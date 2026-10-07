// Runs the real TypeScript Engine wrapper against the shipped WASM builds.
// Node child processes substitute for browser Workers: not a browser/UI benchmark.
// Example: node scripts/benchmark-review.cjs lite 4 16
// Arguments: build (lite/full), workers, hash MB, fixture (classical/tactical).
// BENCH_DEPTH defaults to 20; BENCH_OUT may select a separate result directory.
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const ts = require("typescript");
const { Chess } = require("chess.js");

const root = path.resolve(__dirname, "..");
const STARTING_FEN = new Chess().fen();
const build = process.argv[2] || "lite";
const workers = Number(process.argv[3] || 4);
const hash = Number(process.argv[4] || 16);
const fixture = process.argv[5] || "classical";
const depth = Number(process.env.BENCH_DEPTH || 20);
// Threads per engine. Defaults to 1 (each engine single-threaded); set via
// BENCH_THREADS to model the app's `threads` setting.
const threads = Number(process.env.BENCH_THREADS || 1);
// MultiPV lines per search; models the app's "lines" setting (default 2).
const multiPV = Number(process.env.BENCH_MPV || 2);
// Optional node budget: search with `go nodes N` instead of a depth target
// (0 = depth-only search, the app default).
const nodeBudget = Number(process.env.BENCH_NODES || 0);
// Hash policy: "keep" = the engine's hash survives across positions (app
// behaviour); "clear" = `ucinewgame` before every position.
const hashPolicy = process.env.BENCH_HASH_POLICY || "keep";
// Allows the matrix driver to freeze a copy of engine.ts (baseline) or point
// at the live file (improved), independent of edits made while runs execute.
const engineSourcePath = path.resolve(
    process.env.BENCH_ENGINE_SRC
    || path.join(root, "app/ui/src/apps/features/analysis/lib/engine.ts")
);
const version = build === "lite" ? "stockfish-19-lite-single.js" : "stockfish-19-single.js";
const fixtures = {
    // Fischer–Spassky, Reykjavik 1972, game 6: first 25 full moves.
    classical: "c4 e6 Nf3 d5 d4 Nf6 Nc3 Be7 Bg5 O-O e3 h6 Bh4 b6 cxd5 Nxd5 Bxe7 Qxe7 Nxd5 exd5 Rc1 Be6 Qa4 c5 Qa3 Rc8 Bb5 a6 dxc5 bxc5 O-O Ra7 Be2 Nd7 Nd4 Qf8 Nxe6 fxe6 e4 d4 f4 Qe7 e5 Rb8 Bc4 Kh8 Qh3 Nf8 b3 a5",
    // Kasparov–Topalov, Wijk aan Zee 1999: first 25 full moves.
    tactical: "e4 d6 d4 Nf6 Nc3 g6 Be3 Bg7 Qd2 c6 f3 b5 Nge2 Nbd7 Bh6 Bxh6 Qxh6 Bb7 a3 e5 O-O-O Qe7 Kb1 a6 Nc1 O-O-O Nb3 exd4 Rxd4 c5 Rd1 Nb6 g3 Kb8 Na5 Ba8 Bh3 d5 Qf4+ Ka7 Rhe1 d4 Nd5 Nbxd5 exd5 Qd6 Rxd4 cxd4 Re7+ Kb6",
    // Endgame-heavy fixture: the opening of Kasparov–Flear, Manchester 1987
    // (real game, first 9 moves), continued with an exchange-heavy line that
    // leaves the board as a B+N+P vs B+N+P endgame from around move 12 on
    // (queens off after 11...Qxf2+). Every move is legal-verified by chess.js.
    endgame: "d4 Nf6 c4 e6 Nf3 Bb4+ Nbd2 d5 g3 O-O Bg2 dxc4 O-O Qe7 a4 c5 d5 exd5 Nxc4 Qxe2 Qxd5 Qxf2+ Rxf2 Nxd5 Rf1 Re8 Ra2 Rf8 Ra3 Bxa3 Nxa3 Re8 Rf2 Re1+ Nxe1 Nd7 Rxf7 Kxf7 Bxd5+ Ke8 Bxb7 Bxb7 Nb5 Rb8 Nxa7 Rc8 Nxc8 Bxc8 Bd2 Bb7"
};
if (!["lite", "full"].includes(build) || !fixtures[fixture]
    || !Number.isInteger(workers) || workers < 1 || workers > 16
    || !Number.isInteger(hash) || hash < 1
    || !Number.isInteger(depth) || depth < 1
    || !Number.isInteger(threads) || threads < 1 || threads > 32
    || !Number.isInteger(multiPV) || multiPV < 1 || multiPV > 8
    || !Number.isInteger(nodeBudget) || nodeBudget < 0
    || !["keep", "clear"].includes(hashPolicy)
    || !fs.existsSync(engineSourcePath)) throw Error("Invalid benchmark arguments");

const board = new Chess();
const positions = [{ fen: board.fen(), moves: [] }];
for (const san of fixtures[fixture].split(" ")) {
    const move = board.move(san);
    positions.push({ fen: board.fen(), moves: [...positions.at(-1).moves, move.lan] });
}
if (positions.length !== 51) throw Error("Fixture must contain exactly 50 plies");

const out = path.resolve(process.env.BENCH_OUT || path.join(__dirname, "review-benchmarks"));
fs.mkdirSync(out, { recursive: true });
const id = `${fixture}-${build}-w${workers}-t${threads}-h${hash}`
    + `${hashPolicy === "clear" ? "-hashclear" : ""}`
    + `-d${depth}${nodeBudget ? `-n${nodeBudget}` : ""}-mp${multiPV}`
    + `-${Date.now()}`;
const resultPath = path.join(out, `${id}.json`);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "review-bench-"));
fs.copyFileSync(path.join(root, "public", "engines", version), path.join(temp, "stockfish.js"));
fs.copyFileSync(path.join(root, "public", "engines", version.replace(".js", ".wasm")), path.join(temp, "stockfish.wasm"));
const children = [];
let latestWorker;

class ProcessWorker {
    constructor() {
        latestWorker = this;
        this.listeners = new Map();
        this.buffer = "";
        this.commands = [];
        this.options = [];
        this.callbackMs = 0;
        this.infoLines = 0;
        this.latestStats = null;
        this.closed = false;
        this.child = spawn(process.execPath, [path.join(temp, "stockfish.js")], {
            cwd: temp, stdio: ["pipe", "pipe", "pipe"]
        });
        children.push(this);
        this.exited = new Promise(resolve => this.child.once("exit", resolve));
        this.child.on("error", error => this.emit("error", { error }));
        this.child.stdin.on("error", error => {
            if (!this.closed) this.emit("error", { error });
        });
        this.child.on("exit", (code, signal) => {
            if (!this.closed) this.emit("error", { error: Error(`Unexpected engine exit ${code}/${signal}`) });
        });
        this.child.stderr.on("data", data => {
            this.stderr = (this.stderr || "") + data;
        });
        this.child.stdout.on("data", data => {
            this.buffer += data;
            let end;
            while ((end = this.buffer.indexOf("\n")) >= 0) {
                const line = this.buffer.slice(0, end).trim();
                this.buffer = this.buffer.slice(end + 1);
                if (line.startsWith("option name")) this.options.push(line);
                if (line === "readyok") this.ready?.();
                if (line.startsWith("info depth")) {
                    this.infoLines++;
                    const value = name => Number(line.match(new RegExp(` ${name} (\\d+)`))?.[1] || 0);
                    this.latestStats = { depth: value("depth"), nodes: value("nodes"), nps: value("nps"), engineMs: value("time"), hashfull: value("hashfull") };
                }
                if (this.capture) this.capture.push(line);
                const start = performance.now();
                try {
                    this.emit("message", { data: line });
                } catch (error) {
                    this.emit("error", { error });
                }
                this.callbackMs += performance.now() - start;
            }
        });
    }
    addEventListener(type, fn) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
    emit(type, event) {
        for (const fn of [...(this.listeners.get(type) || [])]) fn(event);
    }
    postMessage(command) {
        this.commands.push(command);
        if (command === "quit") return this.terminate();
        this.child.stdin.write(`${command}\n`);
    }
    terminate() {
        this.closed = true;
        this.child.kill();
    }
}
global.Worker = ProcessWorker;

// Transpile only: runtime imports are restricted to Engine's existing dependencies.
const source = fs.readFileSync(engineSourcePath, "utf8");
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const engineModule = { exports: {} };
new Function("require", "module", "exports", compiled)(name => {
    if (name === "chess.js") return require(name);
    if (name === "@domain/constants/utils") return { STARTING_FEN };
    throw Error(`Unexpected runtime import: ${name}`);
}, engineModule, engineModule.exports);
const Engine = engineModule.exports.default;

const result = {
    meta: {
        id, build, version, workers, threadsPerEngine: threads, hashMB: hash, hashPolicy, depth, multiPV, nodeBudget,
        fixture, plies: 50, positions: 51, timeLimit: null,
        mode: "actual Engine.ts with Node process Worker adapter; cloud/UI/classification excluded",
        node: process.version, cpu: os.cpus()[0].model, logicalCPUs: os.cpus().length,
        freeMemoryBytes: os.freemem(), startedAt: new Date().toISOString(),
        engineSourceSHA256: require("node:crypto").createHash("sha256").update(source).digest("hex"),
        wasmSHA256: require("node:crypto").createHash("sha256").update(fs.readFileSync(path.join(temp, "stockfish.wasm"))).digest("hex")
    },
    status: "running", startup: [], positions: [], memorySamples: []
};
// Atomic + fault-tolerant incremental save: write to a sibling temp file
// and rename over the result, so a reader (the matrix driver) never sees a
// half-written file, and a transient lock/antivirus glitch on the target
// path does not take the whole run down. Intermediate saves are logged and
// swallowed; the final save in main() retries before giving up.
const save = () => {
    const tmpPath = resultPath + ".tmp";
    const write = () => {
        fs.writeFileSync(tmpPath, JSON.stringify(result, null, 2));
        fs.renameSync(tmpPath, resultPath);
    };
    try {
        write();
    } catch (error) {
        if (result.status === "complete" || result.status === "failed")
            throw error;

        console.warn(`save glitch (ignored, status ${result.status}): ${error}`);
    }
};
let next = 0;
const start = performance.now();
let lastCompletion = start;

// Peak-memory tracking: one `tasklist` snapshot every 10 s (all child PIDs
// in a single call). Windows only; other platforms record no samples.
const memoryTimer = process.platform === "win32" ? setInterval(() => {
    try {
        const csv = require("node:child_process").execFileSync(
            "tasklist", ["/FO", "CSV", "/NH"],
            { maxBuffer: 8 * 1024 * 1024, windowsHide: true }
        ).toString();
        const byPid = {};
        for (const line of csv.split(/\r?\n/)) {
            // Columns: "Image Name","PID","Session Name","Session#","Mem Usage"
            const m = line.match(/^"([^"]*)","(\d+)","([^"]*)","([^"]*)","([\d,]+) K"$/);
            if (m) byPid[m[2]] = Number(m[5].replace(/,/g, ""));
        }
        const tick = {};
        for (const w of children) {
            const pid = w.child && w.child.pid;
            if (pid) tick[pid] = byPid[pid] || 0;
        }
        result.memorySamples.push({
            t: Math.round(performance.now() - start),
            totalKB: Object.values(tick).reduce((a, b) => a + b, 0),
            byPid: tick
        });
    } catch { /* sample is best-effort */ }
}, 10000) : undefined;
// Failure watchdog only: never returns a shortened search as a valid result.
const watchdog = setInterval(() => {
    if (performance.now() - lastCompletion > 15 * 60 * 1000) {
        result.status = "failed";
        result.error = "No completed position for 15 minutes";
        save();
        children.forEach(child => child.terminate());
        process.exitCode = 1;
        clearInterval(watchdog);
    }
}, 10000);

async function lane(workerIndex) {
    const engineStart = performance.now();
    const engine = new Engine(version, threads);
    const worker = latestWorker;
    let rejectFailure;
    const failure = new Promise((_, reject) => { rejectFailure = reject; });
    // The failure promise may reject between searches; attach a handler immediately.
    failure.catch(() => {});
    engine.onError(message => rejectFailure(Error(message)));
    engine.setLineCount(multiPV);
    engine.setOption("Hash", String(hash));
    await Promise.race([new Promise(resolve => {
        worker.ready = resolve;
        worker.postMessage("isready");
    }), failure]);
    result.startup.push({ workerIndex, ms: performance.now() - engineStart, options: worker.options });
    while (next < positions.length) {
        const index = next++;
        const position = positions[index];
        const positionStart = performance.now();
        const callbackStart = worker.callbackMs;
        const infosStart = worker.infoLines;
        worker.capture = [];
        if (hashPolicy === "clear") engine.newGame();
        engine.setPosition(STARTING_FEN, position.moves);
        const setupMs = performance.now() - positionStart;
        const lines = await Promise.race([engine.evaluate(
            nodeBudget ? { nodes: nodeBudget } : { depth }
        ), failure]);
        const end = performance.now();
        const expected = Math.min(multiPV, new Chess(position.fen).moves().length);
        const finalLines = Array.from({ length: expected }, (_, i) =>
            lines.findLast(line => line.depth >= (nodeBudget ? 1 : depth)
                && line.index === i + 1));
        if (finalLines.some(line => !line || !line.moves.length)) {
            throw Error(`Position ${index}: missing depth ${depth} MultiPV`);
        }
        for (const line of finalLines) {
            const pvBoard = new Chess(position.fen);
            for (const move of line.moves) {
                if (pvBoard.move(move.uci).san !== move.san) throw Error(`Invalid PV at ${index}`);
            }
        }
        const raw = worker.capture;
        worker.capture = null;
        const bestmove = raw.findLast(line => line.startsWith("bestmove"));
        if (!bestmove || (expected && bestmove.split(" ")[1] !== finalLines[0].moves[0].uci)) {
            throw Error(`Position ${index}: bestmove/PV mismatch`);
        }
        result.positions.push({
            index, workerIndex, fen: position.fen, moves: position.moves,
            startedMs: positionStart - start, finishedMs: end - start,
            wallMs: end - positionStart, setupMs,
            callbackMs: worker.callbackMs - callbackStart,
            infoLines: worker.infoLines - infosStart, storedLines: lines.length,
            stats: worker.latestStats, bestmove, finalLines, raw
        });
        lastCompletion = performance.now();
        save();
        console.log(`${id}: ${result.positions.length}/51 (ply ${index}) ${(end - positionStart).toFixed(0)}ms depth=${finalLines.map(line => line.depth).join("/")}`);
    }
    engine.terminate();
}

async function main() {
    console.log(`START ${id}; result ${resultPath}`);
    save();
    try {
        await Promise.all(Array.from({ length: workers }, (_, i) => lane(i)));
        result.elapsedMs = performance.now() - start;
        result.status = "complete";
        result.positions.sort((a, b) => a.index - b.index);
        console.log(`COMPLETE ${(result.elapsedMs / 1000).toFixed(3)}s`);
    } catch (error) {
        result.status = "failed";
        result.error = String(error.stack || error);
        process.exitCode = 1;
        console.error(error);
    } finally {
        clearInterval(watchdog);
        if (memoryTimer) clearInterval(memoryTimer);
        children.forEach(child => child.terminate());
        await Promise.all(children.map(child => child.exited));
        result.meta.finishedAt = new Date().toISOString();
        // The final save must land: retry through transient lock glitches.
        for (let attempt = 0; attempt < 5; attempt++) {
            try {
                save();
                break;
            } catch (error) {
                if (attempt === 4) throw error;
                Atomics.wait(
                    new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250
                );
            }
        }
        fs.rmSync(temp, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });