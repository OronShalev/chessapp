// make-benchmark-xlsx.cjs
//
// Reads scripts/benchmark-results.json (produced by benchmark-engine-count.cjs)
// and writes a formatted .xlsx workbook to the user's Desktop.
//
// Sheets:
//   Summary  - per (engine option, engine count): the 3 individual run times,
//              the average, and the speedup vs the 1-engine average.
//   Raw runs - every individual timed run.
//   Meta     - benchmark parameters.
//
// Usage: node make-benchmark-xlsx.cjs [outputPath]
//   outputPath defaults to <Desktop>/engine-benchmark-depth20.xlsx

const fs = require("fs");
const os = require("os");
const path = require("path");
const XLSX = require("xlsx");

const RESULTS_PATH = path.join(__dirname, "benchmark-results.json");
const OUT_PATH = process.argv[2] || path.join(
    os.homedir(), "Desktop", "engine-benchmark-depth20.xlsx"
);

const data = JSON.parse(fs.readFileSync(RESULTS_PATH, "utf8"));
const { meta, results } = data;

if (!results || results.length === 0) {
    console.error("No results found in", RESULTS_PATH);
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Summary sheet: one row per (engine, count).
// ---------------------------------------------------------------------------
const engineOrder = meta && meta.engines ? meta.engines : [...new Set(results.map(r => r.engine))];
const counts = meta && meta.engineCounts ? meta.engineCounts : [...new Set(results.map(r => r.count))].sort((a, b) => a - b);

const byEngineCount = {};
for (const r of results) {
    (byEngineCount[r.engine] ||= {})[r.count] ||= [];
    byEngineCount[r.engine][r.count].push(r);
}

const summaryRows = [];
for (const engine of engineOrder) {
    const label = results.find(r => r.engine === engine)?.engineLabel || engine;
    const perCount = byEngineCount[engine] || {};
    const oneRuns = (perCount[1] || []).map(r => r.elapsedMs);
    const oneAvg = oneRuns.length ? oneRuns.reduce((a, b) => a + b, 0) / oneRuns.length : null;
    for (const count of counts) {
        const runs = (perCount[count] || []).sort((a, b) => a.run - b.run);
        if (runs.length === 0) continue;
        const avgMs = runs.reduce((a, r) => a + r.elapsedMs, 0) / runs.length;
        summaryRows.push({
            "Engine option": label,
            "Engines": count,
            "Run 1 (s)": +(runs[0].elapsedMs / 1000).toFixed(3),
            "Run 2 (s)": runs[1] ? +(runs[1].elapsedMs / 1000).toFixed(3) : null,
            "Run 3 (s)": runs[2] ? +(runs[2].elapsedMs / 1000).toFixed(3) : null,
            "Average (s)": +(avgMs / 1000).toFixed(3),
            "Speedup vs 1 engine": oneAvg ? +(oneAvg / avgMs).toFixed(2) : null
        });
    }
}

// ---------------------------------------------------------------------------
// Raw runs sheet.
// ---------------------------------------------------------------------------
const rawRows = results
    .slice()
    .sort((a, b) =>
        a.engine === b.engine ? (a.count === b.count ? a.run - b.run : a.count - b.count)
            : engineOrder.indexOf(a.engine) - engineOrder.indexOf(b.engine))
    .map(r => ({
        "Engine option": r.engineLabel,
        "Engines": r.count,
        "Run": r.run,
        "Elapsed (s)": +(r.elapsedMs / 1000).toFixed(3),
        "Positions evaluated": r.positionsEvaluated
    }));

// ---------------------------------------------------------------------------
// Meta sheet.
// ---------------------------------------------------------------------------
const metaRows = [
    { Parameter: "Depth", Value: meta.depth },
    { Parameter: "MultiPV lines", Value: meta.lines },
    { Parameter: "Positions per game", Value: meta.positionCount },
    { Parameter: "Engine counts tested", Value: meta.engineCounts.join(", ") },
    { Parameter: "Runs per engine count", Value: meta.runsPerCount },
    { Parameter: "Engine options", Value: results.map(r => r.engineLabel).filter((v, i, a) => a.indexOf(v) === i).join("; ") },
    { Parameter: "Started at (UTC)", Value: meta.startedAt },
    { Parameter: "Finished at (UTC)", Value: meta.finishedAt },
    { Parameter: "Work distribution", Value: "Shared position index, round-robin work-stealing (mirrors evaluate.ts)" },
    { Parameter: "Timing", Value: "Wall clock, engine spawn to last bestmove, per run" }
];

// ---------------------------------------------------------------------------
// Build the workbook.
// ---------------------------------------------------------------------------
const wb = XLSX.utils.book_new();

const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
wsSummary["!cols"] = [
    { wch: 30 }, { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    { wch: 12 }, { wch: 20 }
];
XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

const wsRaw = XLSX.utils.json_to_sheet(rawRows);
wsRaw["!cols"] = [{ wch: 30 }, { wch: 8 }, { wch: 6 }, { wch: 12 }, { wch: 20 }];
XLSX.utils.book_append_sheet(wb, wsRaw, "Raw runs");

const wsMeta = XLSX.utils.json_to_sheet(metaRows);
wsMeta["!cols"] = [{ wch: 28 }, { wch: 80 }];
XLSX.utils.book_append_sheet(wb, wsMeta, "Meta");

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
XLSX.writeFile(wb, OUT_PATH);
console.log(`Wrote ${OUT_PATH}`);
console.log(`  Summary rows: ${summaryRows.length}, raw runs: ${rawRows.length}`);
