// compare-accuracy.cjs
//
// Accuracy / PV-integrity comparator for two benchmark-review result files.
//
// Usage:
//   node scripts/compare-accuracy.cjs <reference.json> <candidate.json> [labelA] [labelB]
//   node scripts/compare-accuracy.cjs --determinism <runA.json> <runB.json>
//
// Normal mode compares the candidate against the reference position by
// position: best-move agreement; evaluation deviation (cp + White
// win-probability, mirroring domain expectedPoints); PV prefix agreement and
// PV length; mate-score consistency; reached depth; and move-classification
// stability (mirrors the domain point-loss classifier incl. FORCED/THEORY/
// BEST short-circuits; brilliant/critical are not modelled - they only
// upgrade BEST moves). Determinism mode diffs two same-config runs.

const fs = require("node:fs");
const path = require("node:path");
const { Chess } = require("chess.js");

const root = path.resolve(__dirname, "..");
const openingsDb = require(
    path.join(root, "app/domain/src/resources/openings.json")
);

// Keep the report save alive even if the stdout pipe closes mid-run
// (e.g. `| Select-Object -First N` on Windows): a broken console write
// must not kill the process before the JSON report is written.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

function loadResult(filePath) {
    const result = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (result.status !== "complete")
        throw Error(`${filePath}: status is "${result.status}", not complete`);
    return result;
}

function topLine(position) {
    // finalLines[0] is the MultiPV index-1 (best) line recorded by the harness.
    return (position.finalLines || [])[0];
}

// White win-probability of a White-normalised evaluation (domain model).
function whiteWinProb(evaluation, fen) {
    const sideToMove = fen.split(" ")[1];
    if (evaluation.type === "mate") {
        if (evaluation.value > 0) return 1;
        if (evaluation.value < 0) return 0;
        // mate 0: the side to move is checkmated right now.
        return sideToMove === "w" ? 0 : 1;
    }
    return 1 / (1 + Math.exp(-0.0035 * evaluation.value));
}

// Mirrors getExpectedPointsLoss (domain). The centipawn branch ignores
// moveColour (evals are White-normalised); only the mate-0 branch uses it.
function ep(eval_, mcWhite) {
    if (eval_.type === "mate") {
        if (eval_.value === 0) return mcWhite ? 1 : 0;
        return eval_.value > 0 ? 1 : 0;
    }
    return 1 / (1 + Math.exp(-0.0035 * eval_.value));
}
function epLoss(prevEval, curEval, moveWhite) {
    const a = prevEval.type === "mate" ? ep(prevEval, !moveWhite) : ep(prevEval, moveWhite);
    const b = ep(curEval, moveWhite);
    return Math.max(0, (a - b) * (moveWhite ? 1 : -1));
}

// Mirrors pointLossClassify (domain), returning the base classification.
function pointLossClassify(prevEval, curEval, moveWhite) {
    const f = moveWhite ? 1 : -1;
    const previousSubjective = prevEval.value * f;
    const subjective = curEval.value * f;

    if (prevEval.type === "mate" && curEval.type === "mate") {
        if (previousSubjective > 0 && subjective < 0)
            return subjective < -3 ? "mistake" : "blunder";
        const mateLoss = (curEval.value - prevEval.value) * f;
        if (mateLoss < 0 || (mateLoss === 0 && subjective < 0)) return "best";
        if (mateLoss < 2) return "excellent";
        if (mateLoss < 7) return "okay";
        return "inaccuracy";
    }
    if (prevEval.type === "mate" && curEval.type === "centipawn") {
        if (subjective >= 800) return "excellent";
        if (subjective >= 400) return "okay";
        if (subjective >= 200) return "inaccuracy";
        if (subjective >= 0) return "mistake";
        return "blunder";
    }
    if (prevEval.type === "centipawn" && curEval.type === "mate") {
        if (subjective > 0) return "best";
        if (subjective >= -2) return "blunder";
        if (subjective >= -5) return "mistake";
        return "inaccuracy";
    }
    const loss = epLoss(prevEval, curEval, moveWhite);
    if (loss < 0.01) return "best";
    if (loss < 0.045) return "excellent";
    if (loss < 0.08) return "okay";
    if (loss < 0.12) return "inaccuracy";
    if (loss < 0.22) return "mistake";
    return "blunder";
}
// Classifies the move INTO position `i` (0-based) using the run's own
// top lines. Mirrors classify() short-circuit order (forced/theory/mated/
// top-move/point-loss).
function classifyMove(i, positions, getTop) {
    const prevLine = getTop(i - 1);
    const curLine = getTop(i);
    if (!prevLine || !curLine || !prevLine.moves.length || !curLine.moves.length)
        return { class: "n/a" };

    const prevFen = positions[i - 1].fen;
    if (new Chess(prevFen).moves().length <= 1) return { class: "forced" };
    if (openingsDb[positions[i].fen.split(" ")[0]]) return { class: "theory" };
    if (new Chess(positions[i].fen).isCheckmate())
        return { class: "best", reason: "mated" };

    const playedUci = positions[i].moves[i - 1];
    if (prevLine.moves[0].uci === playedUci) return { class: "best" };

    const moveWhite = prevFen.split(" ")[1] === "w";
    return {
        class: pointLossClassify(prevLine.evaluation, curLine.evaluation, moveWhite),
        pointLoss: epLoss(prevLine.evaluation, curLine.evaluation, moveWhite)
    };
}

function percentile(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.ceil(p / 100) * sorted.length - 1)];
}
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

function compareMeta(result) {
    return {
        build: result.meta.build, workers: result.meta.workers,
        threads: result.meta.threadsPerEngine, hash: result.meta.hashMB,
        depth: result.meta.depth, mpv: result.meta.multiPV,
        nodes: result.meta.nodeBudget, hashPolicy: result.meta.hashPolicy,
        engineSHA: (result.meta.engineSourceSHA256 || "").slice(0, 12),
        wasmSHA: (result.meta.wasmSHA256 || "").slice(0, 12)
    };
}
function runComparison(A, B) {
    const out = {
        positionsCompared: 0, fenMismatches: 0,
        bestmove: { agree: 0, disagreements: [] },
        evaluation: {
            cpPairs: 0, meanAbsDcp: 0, p95AbsDcp: 0, maxAbsDcp: 0,
            matePairs: 0, mateEqual: 0, mateValueDiff: 0, typeFlips: 0,
            winProbMeanAbsD: 0, winProbMaxAbsD: 0
        },
        pv: {
            meanPrefixLen: 0, p95PrefixLen: 0,
            prefixAtLeast3: 0, prefixAtLeast5: 0,
            prefixAtLeast3Frac: 0, prefixAtLeast5Frac: 0,
            meanLenA: 0, meanLenB: 0
        },
        depth: { minA: 0, meanA: 0, minB: 0, meanB: 0 },
        classification: { perClassA: {}, perClassB: {}, flips: [] },
        accuracy: { whiteA: 0, blackA: 0, whiteB: 0, blackB: 0 }
    };

    const n = Math.min(A.positions.length, B.positions.length);
    const dcp = [], prefixLens = [], depthsA = [], depthsB = [];
    const accA = { white: [], black: [] };
    const accB = { white: [], black: [] };
    let winProbSum = 0, compared = 0, lenA = 0, lenB = 0;

    for (let i = 0; i < n; i++) {
        const pA = A.positions[i];
        const pB = B.positions[i];
        if (pA.fen !== pB.fen) { out.fenMismatches++; continue; }
        compared++;

        const lineA = topLine(pA);
        const lineB = topLine(pB);
        if (!lineA || !lineB) continue;

        depthsA.push(lineA.depth);
        depthsB.push(lineB.depth);

        const moveA = lineA.moves[0] && lineA.moves[0].uci;
        const moveB = lineB.moves[0] && lineB.moves[0].uci;
        if (moveA && moveB) {
            if (moveA === moveB) out.bestmove.agree++;
            else out.bestmove.disagreements.push({
                ply: i, fen: pA.fen,
                a: { move: moveA, eval: lineA.evaluation, depth: lineA.depth },
                b: { move: moveB, eval: lineB.evaluation, depth: lineB.depth }
            });
        }

        const eA = lineA.evaluation;
        const eB = lineB.evaluation;
        if (eA.type === "centipawn" && eB.type === "centipawn") {
            out.evaluation.cpPairs++;
            const d = Math.abs(eA.value - eB.value);
            dcp.push(d);
            out.evaluation.maxAbsDcp = Math.max(out.evaluation.maxAbsDcp, d);
        } else if (eA.type === "mate" && eB.type === "mate") {
            out.evaluation.matePairs++;
            if (eA.value === eB.value) out.evaluation.mateEqual++;
            else out.evaluation.mateValueDiff++;
        } else out.evaluation.typeFlips++;

        winProbSum += Math.abs(
            whiteWinProb(eA, pA.fen) - whiteWinProb(eB, pA.fen)
        );
        out.evaluation.winProbMaxAbsD = Math.max(
            out.evaluation.winProbMaxAbsD,
            Math.abs(whiteWinProb(eA, pA.fen) - whiteWinProb(eB, pA.fen))
        );

        const pvA = lineA.moves.map(m => m.uci);
        const pvB = lineB.moves.map(m => m.uci);
        let prefix = 0;
        while (prefix < pvA.length && prefix < pvB.length
            && pvA[prefix] === pvB[prefix]) prefix++;
        prefixLens.push(prefix);
        if (prefix >= 3) out.pv.prefixAtLeast3++;
        if (prefix >= 5) out.pv.prefixAtLeast5++;
        lenA += pvA.length;
        lenB += pvB.length;
        if (i >= 1) {
            const ca = classifyMove(i, A.positions, j => topLine(A.positions[j]));
            const cb = classifyMove(i, B.positions, j => topLine(B.positions[j]));
            out.classification.perClassA[ca.class] =
                (out.classification.perClassA[ca.class] || 0) + 1;
            out.classification.perClassB[cb.class] =
                (out.classification.perClassB[cb.class] || 0) + 1;
            if (ca.class !== cb.class) out.classification.flips.push({
                ply: i, fen: pA.fen, a: ca.class, b: cb.class
            });
            if (ca.pointLoss != undefined) {
                const playedWhite = A.positions[i - 1].fen.split(" ")[1] === "w";
                const valA = 103.16 * Math.exp(-4 * ca.pointLoss) - 3.17;
                const valB = 103.16 * Math.exp(-4 * (cb.pointLoss || 0)) - 3.17;
                (playedWhite ? accA.white : accA.black).push(valA);
                (playedWhite ? accB.white : accB.black).push(valB);
            }
        }
    }

    out.positionsCompared = compared;
    out.evaluation.meanAbsDcp = +mean(dcp).toFixed(2);
    out.evaluation.p95AbsDcp = +percentile([...dcp].sort((x, y) => x - y), 95).toFixed(0);
    out.evaluation.winProbMeanAbsD = +(winProbSum / Math.max(1, compared)).toFixed(5);
    out.pv.meanPrefixLen = +mean(prefixLens).toFixed(2);
    out.pv.p95PrefixLen = +percentile([...prefixLens].sort((x, y) => x - y), 95).toFixed(0);
    out.pv.prefixAtLeast3Frac = +(out.pv.prefixAtLeast3 / Math.max(1, compared)).toFixed(3);
    out.pv.prefixAtLeast5Frac = +(out.pv.prefixAtLeast5 / Math.max(1, compared)).toFixed(3);
    out.pv.meanLenA = +(lenA / Math.max(1, compared)).toFixed(2);
    out.pv.meanLenB = +(lenB / Math.max(1, compared)).toFixed(2);
    out.depth.minA = depthsA.length ? Math.min(...depthsA) : 0;
    out.depth.meanA = +mean(depthsA).toFixed(2);
    out.depth.minB = depthsB.length ? Math.min(...depthsB) : 0;
    out.depth.meanB = +mean(depthsB).toFixed(2);
    out.accuracy.whiteA = +mean(accA.white).toFixed(2);
    out.accuracy.blackA = +mean(accA.black).toFixed(2);
    out.accuracy.whiteB = +mean(accB.white).toFixed(2);
    out.accuracy.blackB = +mean(accB.black).toFixed(2);
    return out;
}
module.exports = { loadResult, topLine, whiteWinProb, ep, epLoss, pointLossClassify, classifyMove, runComparison, percentile, mean };

if (require.main !== module) return;

const args = process.argv.slice(2);
const determinism = args[0] === "--determinism";
const fileA = determinism ? args[1] : args[0];
const fileB = determinism ? args[2] : args[1];
if (!fileA || !fileB) {
    console.error("Usage: compare-accuracy.cjs [--determinism] <a.json> <b.json>");
    process.exit(2);
}

const A = loadResult(fileA);
const B = loadResult(fileB);

if (A.meta.fixture !== B.meta.fixture)
    console.warn(`WARNING: fixture mismatch (${A.meta.fixture} vs ${B.meta.fixture})`);

const report = {
    labelA: process.argv[determinism ? 5 : 4] || A.meta.id,
    labelB: process.argv[determinism ? 6 : 5] || B.meta.id,
    metaA: compareMeta(A),
    metaB: compareMeta(B),
    elapsedMs: { a: A.elapsedMs, b: B.elapsedMs }
};

if (determinism) {
    const diffs = [];
    const n = Math.min(A.positions.length, B.positions.length);
    for (let i = 0; i < n; i++) {
        const pA = A.positions[i];
        const pB = B.positions[i];
        if (pA.fen !== pB.fen) { diffs.push({ ply: i, what: "fen" }); continue; }
        const a = pA.finalLines || [];
        const b = pB.finalLines || [];
        if (a.length !== b.length) { diffs.push({ ply: i, what: "lineCount" }); continue; }
        for (let k = 0; k < a.length; k++) {
            const same = JSON.stringify(a[k].moves.map(m => m.uci)) === JSON.stringify(b[k].moves.map(m => m.uci))
                && a[k].evaluation.type === b[k].evaluation.type
                && a[k].evaluation.value === b[k].evaluation.value
                && a[k].depth === b[k].depth;
            if (!same) diffs.push({
                ply: i, what: `line${k}`,
                a: { move: a[k].moves[0] && a[k].moves[0].uci, eval: a[k].evaluation, depth: a[k].depth },
                b: { move: b[k].moves[0] && b[k].moves[0].uci, eval: b[k].evaluation, depth: b[k].depth }
            });
        }
    }
    report.determinism = {
        positionsDiffering: new Set(diffs.map(d => d.ply)).size,
        lineDiffs: diffs
    };
    console.log(`DETERMINISM: ${A.meta.fixture} | ${A.meta.id} vs ${B.meta.id}`);
    console.log(`  positions differing: ${report.determinism.positionsDiffering}/${n}`);
    if (diffs.length) console.table(diffs.slice(0, 30));
} else {
    Object.assign(report, runComparison(A, B));
    const r = report;
    console.log(`\nACCURACY: ${r.labelA}  vs  ${r.labelB}`);
    console.log(`  meta A: ${JSON.stringify(r.metaA)}`);
    console.log(`  meta B: ${JSON.stringify(r.metaB)}`);
    console.log(`  positions compared: ${r.positionsCompared} (FEN mismatches: ${r.fenMismatches})`);
    console.log(`  bestmove agreement: ${r.bestmove.agree}/${r.positionsCompared}`
        + ` (${(100 * r.bestmove.agree / Math.max(1, r.positionsCompared)).toFixed(1)}%)`);
    if (r.bestmove.disagreements.length)
        console.table(r.bestmove.disagreements.slice(0, 20));
    const e = r.evaluation;
    console.log(`  eval (cp pairs ${e.cpPairs}): mean|dc| ${e.meanAbsDcp}, p95 ${e.p95AbsDcp}, max ${e.maxAbsDcp}`);
    console.log(`  eval (win prob): mean|dw| ${e.winProbMeanAbsD}, max|dw| ${e.winProbMaxAbsD}`);
    console.log(`  mate: pairs ${e.matePairs}, equal ${e.mateEqual}, value-diff ${e.mateValueDiff}, type flips ${e.typeFlips}`);
    console.log(`  pv: prefix mean ${r.pv.meanPrefixLen}, p95 ${r.pv.p95PrefixLen}, >=3: ${r.pv.prefixAtLeast3Frac}, >=5: ${r.pv.prefixAtLeast5Frac}, len A/B ${r.pv.meanLenA}/${r.pv.meanLenB}`);
    console.log(`  depth: A min/mean ${r.depth.minA}/${r.depth.meanA}, B min/mean ${r.depth.minB}/${r.depth.meanB}`);
    console.log(`  classification A: ${JSON.stringify(r.classification.perClassA)}`);
    console.log(`  classification B: ${JSON.stringify(r.classification.perClassB)}`);
    console.log(`  classification flips: ${r.classification.flips.length}`);
    if (r.classification.flips.length) console.table(r.classification.flips.slice(0, 20));
    console.log(`  accuracy A: white ${r.accuracy.whiteA} / black ${r.accuracy.blackA}`);
    console.log(`  accuracy B: white ${r.accuracy.whiteB} / black ${r.accuracy.blackB}`);
}

const outFile = process.argv[determinism ? 7 : 6]
    || path.join(path.dirname(fileA), "accuracy-comparison.json");
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\nReport: ${outFile}`);


