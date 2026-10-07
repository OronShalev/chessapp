// inspect-run.cjs - quick human summary of a benchmark-review result JSON.
// Usage: node scripts/inspect-run.cjs <result.json>
const result = require(process.argv[2]);
const m = result.meta;
console.log("status:", result.status);
console.log("id:", m.id);
console.log("fixture:", m.fixture, m.build, "engineSHA:", (m.engineSourceSHA256 || "").slice(0, 12), "wasmSHA:", (m.wasmSHA256 || "").slice(0, 12));
console.log("workers:", m.workers, "threads:", m.threadsPerEngine, "hash:", m.hashMB, "depth:", m.depth, "mpv:", m.multiPV, "nodes:", m.nodeBudget, "hashPolicy:", m.hashPolicy);
console.log("elapsedMs:", result.elapsedMs, "overheadMs:", result.overheadMs, "positions:", (result.positions || []).length);
console.log("nps:", result.nps, "nodes:", result.nodes, "aggregateNps:", result.aggregateNps);
const p = (result.positions || [])[5] || (result.positions || [])[0];
if (p) {
    console.log("sample position:", p.index, p.fen.slice(0, 48));
    console.log("  lane:", p.lane, "idleMs:", p.idleMs, "warmupIdleMs:", p.warmupIdleMs, "settleMs:", p.settleMs, "memSamples:", (p.mem || []).length);
    for (const l of (p.finalLines || []).slice(0, 2))
        console.log("  line:", l.moves.map(x => x.uci).slice(0, 6).join(" "),
            "depth:", l.depth, "seldepth:", l.seldepth, "eval:", JSON.stringify(l.evaluation));
}
console.log("allPositionsHaveFinalLines:", (result.positions || []).every(x => x.finalLines && x.finalLines.length));
