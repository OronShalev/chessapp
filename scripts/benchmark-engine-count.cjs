// benchmark-engine-count.cjs
//
// Parallel-engine benchmark. Measures how long the local Stockfish evaluation
// phase takes to analyse a fixed game as the number of engines run in parallel
// varies from 1 to 8.
//
// This mirrors the work-distribution logic in
//   app/ui/src/apps/features/analysis/lib/evaluate.ts
// exactly:
//   - A shared `stateTreeNodeIndex` is incremented synchronously as each engine
//     "picks up" the next position (round-robin work-stealing).
//   - Each engine evaluates its position with `go depth <N>` until `bestmove`.
//   - The run completes when every engine has exhausted the position queue.
//
// The cloud-evaluation phase is intentionally skipped: it is sequential (one
// FEN at a time) and is NOT what the engine-count selector parallelizes. Only
// the local Stockfish phase is measured, which is the phase the feature
// changes.
//
// Fairness: every (engine, count) combination uses the identical engine build,
// game, depth, and position set. The only variable is the engine count. Each
// combination is timed RUNS_PER_COUNT times and the runs are averaged.
//
// Engine options (the two builds shipped in public/engines):
//   full  -> stockfish-19-single.js  + .wasm   (Stockfish 19, full WASM)
//   lite  -> stockfish-19-lite-single.js + .wasm (Stockfish 19 Lite, WASM)
//
// Results are written incrementally to scripts/benchmark-results.json after
// every individual run, so a long run can be resumed after an interruption by
// simply re-running the script (already-completed runs are skipped).
//
// Usage:
//   node benchmark-engine-count.cjs [engineKey]
//     engineKey optional: full | lite  (default: both)
//
// Env overrides (mainly for quick smoke tests):
//   BENCH_DEPTH, BENCH_PLYS, BENCH_RUNS, BENCH_COUNTS (comma list)

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Chess } = require("chess.js");

const STARTING_FEN =
    "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Number of half-moves to play, giving 31 positions (root + 30). Long enough
// that the search work dominates the fixed per-engine startup overhead, so the
// measured speedup reflects work distribution rather than process startup.
const PLY_COUNT = parseInt(process.env.BENCH_PLYS || "30");

// Depth 20, per the benchmark request.
const DEPTH = parseInt(process.env.BENCH_DEPTH || "20");
// MultiPV, matching the default settings.lines (2).
const LINES = 2;
const ENGINE_COUNTS = (process.env.BENCH_COUNTS || "1,2,4,8,16")
    .split(",").map(Number);
const RUNS_PER_COUNT = parseInt(process.env.BENCH_RUNS || "3");

const ENGINES = {
    full: {
        label: "Stockfish 19 (full WASM)",
        js: "stockfish-19-single.js",
        wasm: "stockfish-19-single.wasm"
    },
    lite: {
        label: "Stockfish 19 Lite (WASM)",
        js: "stockfish-19-lite-single.js",
        wasm: "stockfish-19-lite-single.wasm"
    }
};

const RESULTS_PATH = path.join(__dirname, "benchmark-results.json");

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
// Results persistence (incremental + resumable).
// ---------------------------------------------------------------------------
function loadResults() {
    try {
        return JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
    } catch {
        return { meta: null, results: [] };
    }
}

function saveResults(data) {
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(data, null, 2));
}

function doneKeys(data) {
    const set = new Set();
    for (const r of data.results) set.add(`${r.engine}:${r.count}:${r.run}`);
    return set;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const engineArg = process.argv[2];
    const engineKeys = engineArg
        ? [engineArg]
        : Object.keys(ENGINES);
    for (const k of engineKeys) {
        if (!ENGINES[k]) {
            console.error(`Unknown engine key: ${k}`);
            process.exit(2);
        }
    }

    const positions = buildPositions();
    console.log(`Game: ${positions.length} positions, depth ${DEPTH}, ` +
        `MultiPV ${LINES}, ${RUNS_PER_COUNT} runs per count, ` +
        `counts [${ENGINE_COUNTS.join(",")}]`);
    console.log(`Engines: ${engineKeys.join(", ")}`);
    console.log("");

    const data = loadResults();
    data.meta = {
        depth: DEPTH,
        lines: LINES,
        positionCount: positions.length,
        engineCounts: ENGINE_COUNTS,
        runsPerCount: RUNS_PER_COUNT,
        engines: engineKeys,
        startedAt: data.meta && data.meta.startedAt
            ? data.meta.startedAt
            : new Date().toISOString(),
        finishedAt: null
    };
    const done = doneKeys(data);

    // One temp dir per engine option, holding that build's JS (+ wasm) renamed
    // to stockfish.js / stockfish.wasm so Emscripten loads the right wasm.
    const tmpDirs = {};
    for (const key of engineKeys) {
        const spec = ENGINES[key];
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sf-bench-${key}-`));
        fs.copyFileSync(
            path.join(__dirname, "..", "public", "engines", spec.js),
            path.join(dir, "stockfish.js")
        );
        if (spec.wasm) {
            fs.copyFileSync(
                path.join(__dirname, "..", "public", "engines", spec.wasm),
                path.join(dir, "stockfish.wasm")
            );
        }
        tmpDirs[key] = dir;
    }

    try {
        for (const key of engineKeys) {
            for (const count of ENGINE_COUNTS) {
                for (let run = 1; run <= RUNS_PER_COUNT; run++) {
                    const k = `${key}:${count}:${run}`;
                    if (done.has(k)) {
                        console.log(`[skip] ${key} x${count} run${run} (done)`);
                        continue;
                    }
                    process.stdout.write(
                        `[${key}] ${count} engine(s), run ${run}/${RUNS_PER_COUNT}... `
                    );
                    const { elapsed, positionsEvaluated } =
                        await runBenchmark(positions, count, tmpDirs[key]);
                    data.results.push({
                        engine: key,
                        engineLabel: ENGINES[key].label,
                        count,
                        run,
                        elapsedMs: elapsed,
                        positionsEvaluated
                    });
                    saveResults(data);
                    console.log(`${(elapsed / 1000).toFixed(2)}s ` +
                        `(${positionsEvaluated} positions)`);
                }
            }
        }
    } finally {
        data.meta.finishedAt = new Date().toISOString();
        saveResults(data);
        // Best-effort cleanup: child.kill() is async, so on Windows the killed
        // processes may still hold the wasm/js handles. The dirs are in
        // os.tmpdir() and reaped by the OS, so a failure here must not mask
        // the benchmark results.
        for (const dir of Object.values(tmpDirs)) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        }
    }

    console.log("");
    console.log(`Results written to ${RESULTS_PATH}`);
}

main().catch(err => {
    console.error("Benchmark error:", err);
    process.exit(1);
});
