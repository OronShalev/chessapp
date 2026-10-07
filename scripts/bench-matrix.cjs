// bench-matrix.cjs
//
// Sequential driver for scripts/benchmark-review.cjs. Runs a matrix of
// (build, engineCount, threadsPerEngine, hash, fixture) game-review
// benchmarks — 50 plies (51 positions), depth 20, MultiPV 2 — and writes
// a summary with per-config wall time and overhead breakdowns.
//
// Usage:
//   node scripts/bench-matrix.cjs baseline
//   node scripts/bench-matrix.cjs improved [configsJsonPath]
//
//   baseline: freezes the current app/ui .../engine.ts in a snapshot file
//             before the first run (so edits made while the matrix is
//             running cannot leak into baseline numbers) and runs the full
//             configuration matrix against it.
//   improved: runs the config list from a JSON file (default
//             scripts/review-benchmarks/improved-configs.json) against the
//             live engine.ts, for A/B comparison.
//
// A run is skipped when its output directory already contains a result with
// status "complete" (resume after interruption).
//
// Env: BENCH_DEPTH (default 20), BENCH_RUN_TIMEOUT_MIN (default 90).

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const phase = process.argv[2] || "baseline";
const depth = Number(process.env.BENCH_DEPTH || 20);
const runTimeoutMs = (Number(process.env.BENCH_RUN_TIMEOUT_MIN || 90)) * 60 * 1000;

const LIVE_ENGINE = path.join(
    root, "app/ui/src/apps/features/analysis/lib/engine.ts"
);
const benchScript = path.join(__dirname, "benchmark-review.cjs");

let engineSourcePath = process.env.BENCH_ENGINE_SRC
    ? path.resolve(process.env.BENCH_ENGINE_SRC)
    : LIVE_ENGINE;
if (phase === "baseline" && !process.env.BENCH_ENGINE_SRC) {
    // Freeze a snapshot of the engine source for the whole baseline phase.
    // (BENCH_ENGINE_SRC may pin an existing snapshot explicitly, e.g. when
    // running a `...-baseline` phase name after the live file already moved.)
    const snapDir = path.join(__dirname, "review-benchmarks", "snapshots");
    fs.mkdirSync(snapDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    engineSourcePath = path.join(snapDir, `engine-baseline-${stamp}.ts`);
    if (!fs.existsSync(engineSourcePath)) fs.copyFileSync(LIVE_ENGINE, engineSourcePath);
}

const DEFAULT_BASELINE_CONFIGS = [
    // Calibration + the app's current default configuration (4 engines x 4
    // threads) on a tactical game.
    { build: "lite", workers: 8, threads: 1, hash: 32, fixture: "tactical" },
    { build: "lite", workers: 4, threads: 4, hash: 16, fixture: "tactical" },
    // Engine-count sweep with single-threaded engines (classical game).
    { build: "lite", workers: 1, threads: 1, hash: 32, fixture: "classical" },
    { build: "lite", workers: 4, threads: 1, hash: 32, fixture: "classical" },
    { build: "lite", workers: 6, threads: 1, hash: 32, fixture: "classical" },
    { build: "lite", workers: 8, threads: 1, hash: 32, fixture: "classical" },
    // Multi-threaded engines, staying at or below the 12 logical processors.
    { build: "lite", workers: 4, threads: 2, hash: 16, fixture: "classical" },
    { build: "lite", workers: 6, threads: 2, hash: 16, fixture: "classical" },
    // Current app default on the classical game (16 threads > 12 available:
    // measures the oversubscription cost).
    { build: "lite", workers: 4, threads: 4, hash: 16, fixture: "classical" }
];

const configs = (() => {
    // A custom config list (argv[3]) applies to any phase; otherwise the
    // phase default is used (`...-baseline` phases fall back to the
    // original round-1 matrix when no round3-baseline list exists).
    const customPath = process.argv[3]
        || path.join(__dirname, "review-benchmarks",
            phase.endsWith("baseline")
                ? "round3-baseline-configs.json"
                : "improved-configs.json");
    if (fs.existsSync(customPath)) {
        return JSON.parse(fs.readFileSync(customPath, "utf8"));
    }
    if (phase.endsWith("baseline")) return DEFAULT_BASELINE_CONFIGS;

    throw Error(`No ${phase} config list at ${customPath}`);
})();

const outRoot = path.join(__dirname, "review-benchmarks", phase);
fs.mkdirSync(outRoot, { recursive: true });
const summaryPath = path.join(outRoot, "summary.json");

const machine = {
    cpu: os.cpus()[0].model,
    logicalCPUs: os.cpus().length,
    totalMemoryGB: +(os.totalmem() / 1073741824).toFixed(1),
    node: process.version
};

const summary = {
    phase,
    machine,
    depth,
    // multiPV / nodeBudget / hashPolicy are per-config (see each run's
    // `config` object); there is no single phase-wide value anymore.
    plies: 50,
    positions: 51,
    engineSourcePath,
    engineSourceSHA256: sha256(engineSourcePath),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    runs: []
};
const saveSummary = () =>
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

function sha256(filePath) {
    return require("node:crypto").createHash("sha256")
        .update(fs.readFileSync(filePath)).digest("hex");
}

function slugOf(config) {
    let slug = `${config.fixture}-${config.build}`
        + `-w${config.workers}-t${config.threads}-h${config.hash}`;
    if (config.hashPolicy === "clear") slug += "-hashclear";
    if (config.nodes) slug += `-n${config.nodes}`;
    if (config.mpv && config.mpv !== 2) slug += `-mp${config.mpv}`;
    return slug;
}

function runConfig(config) {
    const outDir = path.join(outRoot, slugOf(config));
    fs.mkdirSync(outDir, { recursive: true });

    // Resume support
    const existing = fs.readdirSync(outDir)
        .filter(name => name.endsWith(".json"))
        .map(name => JSON.parse(
            fs.readFileSync(path.join(outDir, name), "utf8")
        ))
        .find(result => result.status === "complete");
    if (existing) {
        console.log(`[skip] ${slugOf(config)} (already complete)`);
        return extractRun(config, existing);
    }

    console.log(`\n=== ${slugOf(config)} `
        + `(${config.workers} engines x ${config.threads} threads, `
        + `hash ${config.hash}MB, ${config.build}) ===`);

    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [
            benchScript,
            config.build,
            String(config.workers),
            String(config.hash),
            config.fixture
        ], {
            cwd: root,
            env: {
                ...process.env,
                BENCH_DEPTH: String(depth),
                BENCH_THREADS: String(config.threads),
                BENCH_MPV: String(config.mpv || 2),
                BENCH_NODES: String(config.nodes || 0),
                BENCH_HASH_POLICY: config.hashPolicy || "keep",
                BENCH_OUT: outDir,
                BENCH_ENGINE_SRC: engineSourcePath
            }
        });

        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
        }, runTimeoutMs);

        child.on("error", error => {
            clearTimeout(timeout);
            reject(error);
        });

        child.on("exit", code => {
            clearTimeout(timeout);
            const files = fs.readdirSync(outDir)
                .filter(name => name.endsWith(".json"));
            if (!files.length) {
                resolve({ config: slugOf(config), status: timedOut ? "timeout" : `crashed (exit ${code})` });
                return;
            }
            const result = JSON.parse(
                fs.readFileSync(path.join(outDir, files[files.length - 1]), "utf8")
            );
            if (timedOut) result.status = "timeout";
            resolve(extractRun(config, result));
        });
    });
}

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100) * sorted.length - 1)];
}

function extractRun(config, result) {
    const run = {
        config: {
            ...config,
            totalThreads: config.workers * config.threads
        },
        status: result.status,
        error: result.error
    };

    if (result.status !== "complete") return run;

    const walls = result.positions.map(p => p.wallMs).sort((a, b) => a - b);
    const finalDepths = result.positions.flatMap(p =>
        (p.finalLines || []).map(line => line.depth));
    const npsList = result.positions
        .map(p => p.stats && p.stats.nps).filter(n => n > 0);

    run.elapsedMs = result.elapsedMs;
    run.avgPositionMs = +(result.elapsedMs / result.positions.length).toFixed(0);
    run.positionMs = {
        min: +walls[0].toFixed(0),
        avg: +(walls.reduce((a, b) => a + b, 0) / walls.length).toFixed(0),
        p95: +percentile(walls, 95).toFixed(0),
        max: +walls[walls.length - 1].toFixed(0)
    };
    run.overheadMs = {
        // Total JS time spent in setPosition (FEN rebuild via chess.js).
        setup: +result.positions.reduce((a, p) => a + (p.setupMs || 0), 0).toFixed(0),
        // Total JS time spent parsing info lines (regex + SAN conversion).
        callbacks: +result.positions.reduce((a, p) => a + (p.callbackMs || 0), 0).toFixed(0)
    };
    run.infoLines = result.positions.reduce((a, p) => a + (p.infoLines || 0), 0);
    run.storedLines = result.positions.reduce((a, p) => a + (p.storedLines || 0), 0);
    run.avgNps = +(npsList.reduce((a, b) => a + b, 0) / (npsList.length || 1)).toFixed(0);
    run.totalNodes = result.positions
        .reduce((a, p) => a + ((p.stats && p.stats.nodes) || 0), 0);
    run.hashfullMax = Math.max(0, ...result.positions.map(p => (p.stats && p.stats.hashfull) || 0));
    run.minFinalDepth = Math.min(...finalDepths);
    run.maxFinalDepth = Math.max(...finalDepths);
    run.startupMs = Math.max(0, ...result.startup.map(s => s.ms));
    // Lane idle accounting: the gap between one position finishing on a lane
    // and the next one starting on the same lane. Large values mean the lane
    // was starved of work (queue/claim overhead) or a position's dispatch was
    // delayed; the tail gap covers time between the last position and the run
    // end (e.g. a slow final position on another lane).
    const lanes = new Map();
    for (const p of result.positions) {
        if (!lanes.has(p.workerIndex)) lanes.set(p.workerIndex, []);
        lanes.get(p.workerIndex).push(p);
    }
    let idleMs = 0;
    let maxIdleGapMs = 0;
    for (const lane of lanes.values()) {
        lane.sort((a, b) => a.startedMs - b.startedMs);
        let cursor = 0;
        for (const p of lane) {
            const gap = p.startedMs - cursor;
            if (gap > 0) {
                idleMs += gap;
                if (gap > maxIdleGapMs) maxIdleGapMs = gap;
            }
            cursor = p.finishedMs;
        }
        const tail = (result.elapsedMs || 0) - cursor;
        if (tail > 0) idleMs += tail;
    }
    run.idleMs = Math.round(idleMs);
    run.maxIdleGapMs = Math.round(maxIdleGapMs);
    // Peak aggregate engine memory across the run (KB -> MB).
    if (result.memorySamples && result.memorySamples.length) {
        run.peakMemoryMB = +Math.max(
            0,
            ...result.memorySamples.map(s => (s.totalKB || 0) / 1024)
        ).toFixed(1);
    }
    run.engineSourceSHA256 = result.meta && result.meta.engineSourceSHA256;
    run.resultId = result.meta && result.meta.id;
    return run;
}

async function main() {
    console.log(`bench-matrix [${phase}] depth ${depth}, ${configs.length} config(s)`);
    console.log(`engine source: ${engineSourcePath}`);
    console.log(`machine: ${machine.cpu} | ${machine.logicalCPUs} logical CPUs | ${machine.totalMemoryGB} GB RAM`);
    saveSummary();

    for (const config of configs) {
        try {
            const run = await runConfig(config);
            summary.runs.push(run);
            if (run.status === "complete") {
                console.log(`--> ${(run.elapsedMs / 1000).toFixed(1)}s `
                    + `(${run.avgPositionMs} avg / ${run.positionMs.p95} p95 per position, `
                    + `stored lines ${run.storedLines})`);
            } else {
                console.log(`--> ${run.status}${run.error ? `: ${String(run.error).split("\n")[0]}` : ""}`);
            }
            saveSummary();
        } catch (error) {
            console.error(`config ${slugOf(config)} failed:`, error);
            summary.runs.push({ config: slugOf(config), status: "failed", error: String(error) });
            saveSummary();
        }
    }

    summary.finishedAt = new Date().toISOString();
    saveSummary();

    console.log(`\nSummary written to ${summaryPath}`);
    console.table(summary.runs.map(run => ({
        config: run.config,
        status: run.status,
        "elapsed (s)": run.elapsedMs ? +(run.elapsedMs / 1000).toFixed(1) : null,
        "pos avg (ms)": run.avgPositionMs,
        "pos p95 (ms)": run.positionMs && run.positionMs.p95,
        "setup+cb (ms)": run.overheadMs ? run.overheadMs.setup + run.overheadMs.callbacks : null,
        "idle (ms)": run.idleMs,
        "max idle gap (ms)": run.maxIdleGapMs,
        "peak mem (MB)": run.peakMemoryMB,
        "info lines": run.infoLines,
        "stored lines": run.storedLines,
        "avg nps": run.avgNps,
        "depth min": run.minFinalDepth
    })));
}

main().catch(error => {
    console.error("bench-matrix error:", error);
    process.exitCode = 1;
});
