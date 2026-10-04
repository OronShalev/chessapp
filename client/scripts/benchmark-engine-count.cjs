// benchmark-engine-count.cjs
//
// Developer benchmark: verify that running 4 engines in parallel produces a
// faster game analysis ("review") than running a single engine.
//
// This mirrors the work-distribution logic in
//   client/src/apps/features/analysis/lib/evaluate.ts
// exactly:
//   - A shared `stateTreeNodeIndex` is incremented synchronously as each engine
//     "picks up" the next position (round-robin work-stealing).
//   - Each engine evaluates its position with `go depth <N>` until `bestmove`.
//   - The run completes when every engine has exhausted the position queue.
//
// The cloud-evaluation phase is intentionally skipped: it is sequential (one
// FEN at a time) and is NOT what the 1-4 engine selector parallelizes. Only
// the local Stockfish phase is measured, which is the phase the feature
// changes.
//
// Fairness: the 1-engine and 4-engine runs use the identical engine, game,
// depth, and position set. The only variable is the engine count.
//
// Usage:  node benchmark-engine-count.cjs
// Exit code 0 = 4-engine run was faster (requirement met); 1 = not faster.

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Chess } = require("chess.js");

const STARTING_FEN =
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Number of half-moves to play, giving 31 positions (root + 30). Long enough
// that 4 engines each receive meaningful parallel work.
const PLY_COUNT = 30;

// Depth 12: the starting position's search explodes at depth 16 in the lite
// WASM build (times out past 60s), while depth 12 keeps every position fast.
// The parallelism speedup is a property of work distribution, not search
// depth, so a lower depth does not weaken the conclusion.
const DEPTH = 12;
// MultiPV, matching the default settings.lines (2).
const LINES = 2;
const ENGINE_COUNTS = [1, 4];

// ---------------------------------------------------------------------------
// Build the mainline position chain (mirrors parseStateTree + getNodeChain).
// Each entry carries the FEN and the full UCI move list from the root, which
// is how evaluate.ts re-sets a position (from initialPosition + moves).
//
// The game is generated deterministically by playing quiet moves (chess.js
// move flags "n" = normal, "b" = big-pawn push), which keeps the game long
// and legal by construction — no reliance on a memorized PGN.
// ---------------------------------------------------------------------------
function buildPositions() {
    const board = new Chess(STARTING_FEN);
    const positions = [{ fen: STARTING_FEN, moves: [] }];

    for (let ply = 0; ply < PLY_COUNT; ply++) {
        const legalMoves = board.moves({ verbose: true });
        if (legalMoves.length == 0) break; // game over
        // Prefer quiet moves so the game does not end early via captures or
        // checkmate. Fall back to any legal move if none are quiet.
        const quiet = legalMoves.filter(m => m.flags == "n" || m.flags == "b");
        const chosen = quiet.length > 0 ? quiet[0] : legalMoves[0];
        const move = board.move(chosen.lan);
        positions.push({
            fen: move.after,
            moves: [...positions[positions.length - 1].moves, move.lan]
        });
    }

    return positions;
}

// ---------------------------------------------------------------------------
// A single headless engine: a `node stockfish.js` child process speaking UCI
// over stdin/stdout. Mirrors the browser Engine class (one Worker per engine)
// with the child-process equivalent.
// ---------------------------------------------------------------------------
class Engine {
    constructor(tmpDir) {
        this.child = spawn(
            process.execPath,
            [path.join(tmpDir, "stockfish.js")],
            { cwd: tmpDir, stdio: ["pipe", "pipe", "pipe"] }
        );
        this.buffer = "";
        this.onReady = null;
        this.onBestMove = null;
        this.onExit = null;

        // Resolves when the child process has fully exited.
        this.terminated = new Promise(res => {
            this.child.on("exit", (code, signal) => {
                res();
                this.onExit && this.onExit(code, signal);
            });
        });

        this.child.stdout.on("data", d => this.onData(d));
        this.child.stderr.on("data", () => {});

        // This Stockfish build goes straight from `uciok` to search output
        // (it does not emit `readyok`), so we gate on `uciok`.
        this.child.stdin.write("uci\n");
    }

    onData(data) {
        this.buffer += data.toString();
        let idx;
        while ((idx = this.buffer.indexOf("\n")) >= 0) {
            const line = this.buffer.slice(0, idx).trim();
            this.buffer = this.buffer.slice(idx + 1);
            if (!line) continue;
            if (line === "uciok") {
                this.child.stdin.write(
                    `setoption name MultiPV value ${LINES}\n`
                );
                this.onReady && this.onReady();
            } else if (line.startsWith("bestmove")) {
                this.onBestMove && this.onBestMove(line);
            }
        }
    }

    setPosition(fen, moves) {
        this.child.stdin.write(
            `position fen ${fen} moves ${moves.join(" ")}\n`
        );
    }

    go() {
        this.child.stdin.write(`go depth ${DEPTH}\n`);
    }

    terminate() {
        this.child.kill();
    }
}

// ---------------------------------------------------------------------------
// Run the local evaluation phase with a given engine count, mirroring
// evaluate.ts's createGameEvaluator. Resolves with the wall-clock time.
// ---------------------------------------------------------------------------
function runBenchmark(positions, engineCount, tmpDir) {
    return new Promise((resolve, reject) => {
        const engines = [];
        let stateTreeNodeIndex = 0;
        let enginesResting = 0;
        let finished = false;
        const t0 = Date.now();

        // Resolve only once every engine process has actually exited, so the
        // temp dir is free for cleanup (child.kill() is async on Windows).
        function finish() {
            if (finished) return;
            finished = true;
            const elapsed = Date.now() - t0;
            const pending = engines.map(e => e.terminated);
            Promise.all(pending).then(() => resolve({
                elapsed,
                positionsEvaluated: stateTreeNodeIndex
            }));
        }

        // Bring an engine to the next position (work-stealing). The shared
        // index is read and incremented synchronously, so each engine grabs a
        // distinct position — identical to evaluate.ts.
        function evaluateNextPosition(engine) {
            if (stateTreeNodeIndex >= positions.length) {
                engine.terminate();
                if (++enginesResting == engineCount) finish();
                return;
            }
            const pos = positions[stateTreeNodeIndex];
            engine.setPosition(STARTING_FEN, pos.moves);
            engine.go();
            engine.onBestMove = () => evaluateNextPosition(engine);
            stateTreeNodeIndex++;
        }

        for (let i = 0; i < engineCount; i++) {
            const engine = new Engine(tmpDir);
            engines.push(engine);
            engine.onReady = () => evaluateNextPosition(engine);
            engine.onExit = (code, signal) => {
                // A clean terminate() yields code null / SIGTERM; only a real
                // non-zero exit before completion is an error.
                if (!finished && code !== null && code !== 0) {
                    reject(new Error(`engine exited with code ${code}`));
                }
            };
        }
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const positions = buildPositions();
    console.log(`Game: ${positions.length} positions, depth ${DEPTH}, ` +
        `MultiPV ${LINES}, engine ${"stockfish-19-lite"}`);
    console.log("");

    // One shared temp dir: copy the engine JS + wasm, renaming the JS to
    // `stockfish.js` so Emscripten loads `stockfish.wasm`.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sf-bench-"));
    fs.copyFileSync(
        path.join(__dirname, "..", "public", "engines",
            "stockfish-19-lite-single.js"),
        path.join(tmpDir, "stockfish.js")
    );
    fs.copyFileSync(
        path.join(__dirname, "..", "public", "engines",
            "stockfish-19-lite-single.wasm"),
        path.join(tmpDir, "stockfish.wasm")
    );

    const results = {};
    try {
        for (const count of ENGINE_COUNTS) {
            process.stdout.write(`Running ${count} engine(s)... `);
            const { elapsed, positionsEvaluated } =
                await runBenchmark(positions, count, tmpDir);
            results[count] = { elapsed, positionsEvaluated };
            console.log(`${(elapsed / 1000).toFixed(2)}s ` +
                `(${positionsEvaluated} positions)`);
        }
    } finally {
        // Best-effort: child.kill() is async, so on Windows the killed
        // processes may still hold the wasm/js handles when we get here.
        // The dir is in os.tmpdir() and reaped by the OS, so a failure here
        // must not mask the benchmark results.
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // ignore
        }
    }

    const one = results[1];
    const four = results[4];
    const speedup = one.elapsed / four.elapsed;

    console.log("");
    console.log("Results:");
    console.log(`  1 engine: ${(one.elapsed / 1000).toFixed(2)}s`);
    console.log(`  4 engines: ${(four.elapsed / 1000).toFixed(2)}s`);
    console.log(`  Speedup:   ${speedup.toFixed(2)}x`);
    console.log("");

    const faster = four.elapsed < one.elapsed;
    if (faster) {
        console.log("PASS: 4 engines in parallel were faster than 1 engine.");
        process.exit(0);
    } else {
        console.log("FAIL: 4 engines in parallel were NOT faster than 1 engine.");
        process.exit(1);
    }
}

main().catch(err => {
    console.error("Benchmark error:", err);
    process.exit(1);
});
