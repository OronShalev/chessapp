import { Chess } from "chess.js";

import { EngineLine } from "@domain/types/game/position/EngineLine";
import EngineVersion from "@domain/constants/EngineVersion";
import { STARTING_FEN } from "@domain/constants/utils";

// Convert UCI evaluation types to our ones
const uciEvaluationTypes: Record<string, string | undefined> = {
    cp: "centipawn",
    mate: "mate"
};

class Engine {
    private worker: Worker;
    private version: EngineVersion;

    private position = STARTING_FEN;
    private evaluating = false;

    // Mirror of the currently set position, kept in sync with the worker:
    // `positionBoard` is `position` as a chess.js board, and
    // `appliedMoves` (and its joined form `appliedKey`) are the UCI moves
    // played from `rootFen` to get there. Position updates that extend the
    // same prefix can then play only the new moves (a full replay is
    // O(depth) each, O(n²) per game), and SAN conversion can reuse the
    // board instead of re-parsing the FEN for every info line.
    private rootFen = STARTING_FEN;
    private positionBoard = new Chess(STARTING_FEN);
    private appliedMoves: string[] = [];
    private appliedKey = "";

    constructor(version: EngineVersion, threads = 1) {
        this.worker = new Worker("/engines/" + version);
        this.version = version;

        this.worker.postMessage("uci");
        this.setThreadCount(threads);
        this.setPosition(this.position);
    }

    private consumeLogs(
        command: string,
        endCondition: (logMessage: string) => boolean,
        onLogReceived?: (logMessage: string) => void
    ): Promise<string[]> {
        this.worker.postMessage(command);

        const worker = this.worker;
        const logMessages: string[] = [];

        return new Promise((res, rej) => {
            function onMessageReceived(event: MessageEvent) {
                const message = String(event.data);

                onLogReceived?.(message);
    
                logMessages.push(message);
    
                if (endCondition(message)) {
                    worker.removeEventListener("message", onMessageReceived);
                    worker.removeEventListener("error", rej);

                    res(logMessages);
                }
            }

            this.worker.addEventListener("message", onMessageReceived);
            this.worker.addEventListener("error", rej);
        });
    }

    onMessage(handler: (message: string) => void) {
        this.worker.addEventListener("message", event => {
            handler(String(event.data));
        });

        return this;
    }

    onError(handler: (error: string) => void) {
        this.worker.addEventListener("error", event => {
            handler(String(event.error));
        });

        return this;
    }

    terminate() {
        this.worker.postMessage("quit");

        // Hard-kill the worker so its (WASM) memory is released
        // immediately, instead of waiting for the engine to exit itself.
        this.worker.terminate();
    }

    setOption(option: string, value: string) {
        this.worker.postMessage(
            `setoption name ${option} value ${value}`
        );

        return this;
    }

    setLineCount(lines: number) {
        this.setOption("MultiPV", lines.toString());

        return this;
    }

    setThreadCount(threads: number) {
        this.setOption("Threads", threads.toString());

        return this;
    }

    setPosition(fen: string, uciMoves?: string[]) {
        if (uciMoves?.length) {
            const movesKey = uciMoves.join(" ");

            this.worker.postMessage(
                `position fen ${fen} moves ${movesKey}`
            );

            this.setTrackedPosition(fen, uciMoves, movesKey);

            return this;
        }

        this.worker.postMessage(`position fen ${fen}`);

        this.rootFen = fen;
        this.positionBoard = new Chess(fen);
        this.position = fen;
        this.appliedMoves = [];
        this.appliedKey = "";

        return this;
    }

    /**
     * Moves the tracked board to `fen` + `uciMoves`, playing only the
     * moves that extend the already-applied prefix. Falls back to a full
     * replay when the root changed or the prefix diverged.
     */
    private setTrackedPosition(
        fen: string,
        uciMoves: string[],
        movesKey: string
    ) {
        const extendsApplied =
            this.appliedMoves.length <= uciMoves.length
            && (this.appliedKey.length == 0
                || movesKey.startsWith(this.appliedKey + " "));

        if (fen !== this.rootFen || !extendsApplied) {
            this.rootFen = fen;
            this.positionBoard = new Chess(fen);
            this.appliedMoves = [];
            this.appliedKey = "";
        }

        for (const uciMove of uciMoves.slice(this.appliedMoves.length)) {
            this.positionBoard.move(uciMove);
        }

        this.appliedMoves = uciMoves;
        this.appliedKey = movesKey;
        this.position = this.positionBoard.fen();
    }

    async evaluate(options: {
        depth: number;
        timeLimit?: number;
        onEngineLine?: (line: EngineLine) => void;
    }): Promise<EngineLine[]> {
        // At most one entry per MultiPV index: each new info line replaces
        // the older (shallower) line in the same slot, so the returned
        // batch holds only the final lines. The onEngineLine callback still
        // receives every line for live display.
        const engineLines: EngineLine[] = [];

        const maxTimeArgument = options.timeLimit
            ? `movetime ${options.timeLimit}` : "";

        // Fully parsing every intermediate line (SAN conversion and all)
        // is only worth it for callers that display lines live. Otherwise,
        // buffer each MultiPV slot's latest raw line and parse only the
        // final line of each slot once the search is over — per-line work
        // (a chess.js FEN parse plus a PV replay, repeated for every
        // iteration of every line) is what otherwise occupies the main
        // thread for most of a review.
        const liveLines = !!options.onEngineLine;
        const latestLine: (string | undefined)[] = [];

        this.evaluating = true;

        await this.consumeLogs(
            `go depth ${options.depth} ${maxTimeArgument}`,
            log => (
                log.startsWith("bestmove")
                || log.includes("depth 0")
            ),
            log => {
                if (!log.startsWith("info depth")) return;
                if (log.includes("currmove")) return;

                if (!liveLines) {
                    // Extract the multipv index of line
                    const index = parseInt(log.match(/(?<= multipv )\d+/)?.[0] || "") || 1;
                    latestLine[index - 1] = log;
                    return;
                }

                const line = this.parseInfoLine(log);
                if (!line) return;

                // Replace any older line for this MultiPV index
                engineLines[line.index - 1] = line;
                options.onEngineLine?.(line);
            }
        );

        if (!liveLines) {
            for (const rawLine of latestLine) {
                if (!rawLine) continue;

                const line = this.parseInfoLine(rawLine);
                if (line) engineLines[line.index - 1] = line;
            }
        }

        this.evaluating = false;

        return engineLines;
    }

    /**
     * Fully parses one `info depth` line into an EngineLine, or returns
     * null when the line carries no usable score. Used for both live
     * (per line) and buffered (final line only) parsing, so both paths
     * produce identical results.
     */
    private parseInfoLine(log: string): EngineLine | null {
        // Extract depth and multipv index of line
        const depth = parseInt(log.match(/(?<= depth )\d+/)?.[0] || "");
        if (isNaN(depth)) return null;

        const index = parseInt(log.match(/(?<= multipv )\d+/)?.[0] || "") || 1;

        // Extract evaluation type and score
        const scoreMatches = log.match(/ score (cp|mate) (-?\d+)/);

        const evaluationType = uciEvaluationTypes[scoreMatches?.[1] || ""];
        if (
            evaluationType != "centipawn"
            && evaluationType != "mate"
        ) return null;

        let evaluationScore = parseInt(scoreMatches?.[2] || "");
        if (isNaN(evaluationScore)) return null;

        // Make sure evaluations are always from White's view
        if (this.position.includes(" b ")) {
            evaluationScore = -evaluationScore;
        }

        // Extract UCI moves from pv
        const moveUcis = log.match(/ pv (.*)/)?.at(1)?.split(" ") || [];

        // Convert these to SANs
        const moveSans = this.movesToSans(moveUcis);

        return {
            depth: depth,
            index: index,
            evaluation: {
                type: evaluationType,
                value: evaluationScore
            },
            source: this.version,
            moves: moveUcis.map((moveUci, moveIndex) => ({
                uci: moveUci,
                san: moveSans[moveIndex]
            }))
        };
    }

    /**
     * Converts UCI moves to SANs by playing them out on the tracked
     * position board and undoing them, leaving the board as found.
     * Reusing the board (instead of `new Chess(this.position)` per call)
     * avoids re-parsing the FEN for every line. If the shared board
     * cannot play a move, the whole PV is retried on a fresh board of
     * the position — a genuine failure there still throws, as before.
     */
    private movesToSans(uciMoves: string[]): string[] {
        const sans: string[] = [];

        let applied = 0;

        for (const uciMove of uciMoves) {
            try {
                sans.push(this.positionBoard.move(uciMove).san);
                applied++;
            } catch {
                for (let i = 0; i < applied; i++) {
                    this.positionBoard.undo();
                }

                sans.length = 0;

                const board = new Chess(this.position);
                for (const retryMove of uciMoves) {
                    sans.push(board.move(retryMove).san);
                }

                return sans;
            }
        }

        for (let i = 0; i < applied; i++) {
            this.positionBoard.undo();
        }

        return sans;
    }

    async stopEvaluation() {
        this.worker.postMessage("stop");

        if (this.evaluating) {
            await this.consumeLogs(
                "", log => log.includes("bestmove")
            );
        }

        this.evaluating = false;
    }
}

export default Engine;