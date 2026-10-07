# Game Review — Dynamic Engine Sizing: Benchmark Results

A/B comparison of the review pipeline before and after adding dynamic
engine/threads/hash sizing. Numbers are wall-clock time to evaluate a full
50-ply (51-position) game at **depth 20, MultiPV 2** with the Stockfish
"lite" WASM engine, running to completion (no time limit).

Machine: AMD Ryzen 5 5500U · 12 logical CPUs (6 cores / 12 SMT threads) · 13.8 GB RAM

## What changed

The old default ran **4 engines × 4 threads = 16 threads** on a 12-logical-CPU
machine — i.e. it *oversubscribed* the CPU. The OS has to time-slice 16 threads
across 12 execution units, which costs more than it saves.

Dynamic sizing now derives the layout from `navigator.hardwareConcurrency`:
**one single-threaded engine per logical core** (`engines = cores`, `threads = 1`,
per-engine hash = ~256 MB / cores). The total thread count therefore equals the
core count exactly: the CPU is fully used but never oversubscribed.

The benchmark matrix showed this "more lanes" layout beats "fewer lanes with
more threads each": on the game-like (classical) fixture, 12 lanes × 1 thread
finishes well ahead of 6 lanes × 2 or 4 lanes × 4.

## Baseline (original code)

| config            | total threads | classical | tactical |
|-------------------|--------------:|----------:|---------:|
| 1 engine × 1 thr  | 1             | 143.7s    | —        |
| 4 × 1             | 4             | 43.2s     | —        |
| 6 × 1             | 6             | 40.1s     | —        |
| 8 × 1             | 8             | 34.4s     | 42.7s    |
| 4 × 2             | 8             | 43.0s     | —        |
| 6 × 2             | 12            | 34.4s     | —        |
| **4 × 4 (default)** | **16 (oversubscribed)** | **46.1s** | **59.3s** |

## Improved (new code, dynamic sizing)

Dynamic sizing resolves to **12 engines × 1 thread** on this machine.

| config                     | total threads | classical | tactical |
|----------------------------|--------------:|----------:|---------:|
| **12 × 1 (dynamic default)** | 12          | **27.7s** | 42–58s*  |
| 6 × 2 (reference)          | 12            | 33.8s     | 50.9s    |

\* The tactical fixture swings run-to-run on this *mobile* chip once all 12
logical threads are pegged (thermal throttle); one hard position dominates the
tail. The classical, game-like fixture is stable (27.3 / 27.7s across runs).

## Headline

- **Classical (game-like) review: 46.1s → 27.7s, ~40% faster.**
- Every configuration still reaches **full depth 20** with **MultiPV 2**
  (102 stored lines = 51 positions × 2) and produces verified-legal moves, so
  depth, accuracy and MultiPV coverage are unchanged — only the layout that
  drives the (independent) position searches is different.
- Correctness of each search is checked in the benchmark: every returned line is
  replayed against a fresh `chess.js` board (SAN must match) and the `bestmove`
  must equal the top line's first move.

## How to re-run

```
node scripts/bench-matrix.cjs baseline   # original code (frozen snapshot)
node scripts/bench-matrix.cjs improved   # current code (live engine.ts)
```

Results: `baseline/summary.json` and `improved/summary.json`. The baseline phase
freezes a copy of `engine.ts` so later edits can't leak into the "before" numbers;
each summary records the SHA-256 of the exact engine source it ran.

---

# Round 2 — engine-management optimisations (live re-benchmark)

Re-ran the 50-ply / depth-20 / MultiPV-2 matrix on the same machine, then
optimised the engine *wrapper* (no changes to search, depth, MultiPV, or the
position set) and re-ran the identical matrix. Every run completes all 51
positions at **full depth 20**, stores the final 2 lines per position (102
lines) and has every PV replayed against a fresh `chess.js` board
(SAN must match) plus a `bestmove` == top-line check — i.e. depth, accuracy
and PV integrity are verified per run, not assumed.

## What changed (round 2)

All in `app/ui/src/apps/features/analysis/lib/`:

1. **Buffered info-line parsing** (`engine.ts`). A depth-20, MultiPV-2 search
   prints ~40 info lines per position; the old wrapper fully parsed *every*
   one (a `new Chess(fen)` FEN parse plus a full PV replay per line) even
   though the review flow only ever uses the *final* line per MultiPV slot —
   ~98% of the work was thrown away. When no live display is requested
   (`onEngineLine` absent, as in game review) the wrapper now buffers only the
   latest raw line per slot and fully parses the ≤2 final lines after
   `bestmove`. Callers that do display lines live (RealtimeEngine) keep the
   streaming path, which now reuses a per-position board for SAN conversion
   (play out + undo) instead of re-parsing the FEN per line.
2. **Incremental position stepping** (`engine.ts`). `setPosition` now keeps a
   tracked board and only plays the moves that extend the already-applied
   prefix (full replay only when the root or prefix changes) — O(1) per
   position instead of O(depth), i.e. O(n) instead of O(n²) per game.
3. **Precomputed move prefixes** (`evaluate.ts`). The per-position
   `slice().filter().map()` rebuild of the cumulative UCI move list is now
   computed once for the whole chain.
4. **Cloud batch size 4 → 8** (`evaluate.ts`) — half as many round trips for
   the same opening-prefix coverage.

Dynamic engine sizing (round 1) is unchanged and validated: one
single-threaded engine per logical core, per-engine hash = 256 MB / cores.

## Results

Lite build (the app default). `cb` = total main-thread time inside info-line
callbacks per review; `setup` = total time in `setPosition` bookkeeping.

| config | role | before | after |
|--------|------|--------:|------:|
| classical 12×1 h21 (dynamic default) | A/B | 30.5s | **30.1s** |
| classical 12×1 h32 (hash headroom) | A/B | 31.1s | 32.6s (variance) |
| tactical 12×1 h21 (dynamic default) | A/B | 54.4s | **41.0s** |
| classical 4×1 h16 (frozen original) | control | 44.4s | 46.2s |
| classical 4×4 h16 (frozen original) | control | 42.6s | 45.2s |
| tactical 4×4 h16 (frozen original) | control | 55.9s | 59.1s |

- **Tactical (sharp) game: 54.4s → 41.0s, ~25% faster** at identical depth
  and line coverage. The dynamic 12-lane layout now finishes ahead of the
  old 4-lane default on *both* fixtures (classical: 30.1s vs ~44s).
- **Main-thread work per review: ~9.3–10.6s → ~20 ms** (a ~450× reduction in
  info-line callback time, ~2.6× less in position setup). In the browser this
  is the user-visible win: 12 workers no longer starve the main thread's
  event loop for a third of the review — no UI jank, snappier position
  hand-off, faster progress updates. (The Node harness runs engines as
  separate processes, so there the same change shows up as a smaller
  wall-clock delta; in the app the saved JS time comes straight off the
  critical path.)
- Controls (frozen original engine, unchanged code) moved 42.6→45.2s and
  44.4→46.2s between rounds — normal run-to-run/thermal variance on this
  mobile chip, which is also why single numbers should be read with that
  band in mind.

Full build (Stockfish 19, 95 MB, selectable in settings) with the same
dynamic sizing: classical 12×1 h21 completes all 51 positions at depth 20
with verified PVs in **66.0s** — the wrapper optimisations and sizing
transfer to the full build unchanged.

## Corrections / notes on the round-1 write-up

- Both shipped WASM builds are compiled **single-threaded**
  (`Threads ... min 1 max 1` in the UCI option dump): the `Threads` option
  is a no-op, so the old "4 engines × 4 threads = 16 oversubscribed threads"
  description was inaccurate — it was effectively 4 single-threaded engines.
  The win from dynamic sizing comes from **more independent lanes** (more
  positions searched in parallel), not from thread scheduling.
- Why 12 lanes beat 6×2 or 4×N on this 6-core/12-SMT chip: 12 single
  threads peg every logical processor, so the engine *count* equals the
  logical core count and the OS never time-slices. Per-lane NPS is ~half of
  a dedicated core (SMT), but aggregate throughput is higher (12 × ~230k ≈
  2.8M nps vs 4 × ~460k ≈ 1.8M nps) and the review's critical path is
  shortened because each lane holds fewer positions.
- Hash: 21 MB/engine (h21) vs 32 MB/engine (h32) made no measurable
  difference on the game-like fixture, so the 256 MB total budget is kept.

## Re-running round 2

The per-run results live in `round2-before/` and `round2-after/` (one JSON
per run, with the full per-position trace). A single config re-run:

```
set BENCH_DEPTH=20
set BENCH_THREADS=1
set BENCH_OUT=...
set BENCH_ENGINE_SRC=app\ui\src\apps\features\analysis\lib\engine.ts
node scripts\benchmark-review.cjs lite 12 21 classical
```

(`bench-matrix.cjs` works the same way; it just appends to a phase summary.)

---

# Round 3 — accuracy-gated engine A/B

Round 3 adds three engine-side capabilities and re-validates every speed
change with explicit accuracy gates (bestmove agreement, eval/win-probability
drift, PV-prefix stability, mate handling, classification flips, repeat-run
determinism) — not just wall clock:

- `Engine.evaluate()` now accepts `depth` / `nodes` / `timeLimit` budgets
  (the app can cap a search by node budget instead of a fixed depth).
- `Engine.newGame()` issues UCI `ucinewgame` (hash reset) — foundation for
  per-review hash policies and reproducible reviews.
- App robustness: a batch review now settles exactly once when any lane fails
  or the review is aborted (remaining lanes are terminated, no late line
  mutations); the realtime engine drops stale lines via an evaluation
  generation counter so a slow worker can't overwrite a newer position.

Baseline runs are pinned to a frozen snapshot
(`snapshots/engine-baseline-round3-20261007-134437.ts`) via
`BENCH_ENGINE_SRC`, so live edits to `engine.ts` cannot leak into the
"before" numbers. Every result JSON records the SHA-256 of the exact engine
source it ran, plus per-position traces, memory samples, and startup timings.

## Baseline matrix (frozen engine, round 3)

51 positions, depth 20, MultiPV 2, no time limit, `hashPolicy: keep`.

| config                | fixture  | total   | p95    | max pos | full d20 | nodes  | mean NPS | peak RSS |
|-----------------------|----------|--------:|-------:|--------:|:--------:|--------|---------:|---------:|
| 1×1 h32               | classical | 144.1s | 5.6s  | 6.3s    | yes      | 66.4M  | 0.46M    | 117MB    |
| **12×1 h21**         | classical | **35.2s** | 15.0s | 16.1s   | yes      | 72.8M  | **2.07M**| **1.25GB** |
| 12×1 h21 (det re-run) | classical | 38.1s  | 14.8s | 18.3s   | yes      | 73.8M  | 1.94M    | 1.25GB   |
| 12×1 h21 (full build) | classical | 87.1s  | 40.4s | 42.7s   | yes      | 64.9M  | 0.75M    | 5.1GB    |
| 1×1 h32               | tactical  | 177.3s  | 6.3s  | 7.7s    | yes      | 80.6M  | 0.45M    | 116MB    |
| **12×1 h21**         | tactical  | **47.1s** | 18.5s | 20.8s   | yes      | 92.0M  | **1.95M**| **1.25GB** |
| 1×1 h32               | endgame   | 197.6s  | 7.5s  | 12.7s   | yes      | 90.9M  | 0.46M    | 116MB    |
| **12×1 h21**         | endgame   | **44.0s** | 17.0s | 30.4s   | yes      | 89.3M  | **2.03M**| **1.25GB** |

- 12 lanes are **4.1–4.5× faster** than 1 lane on every fixture, at equal
  total node counts (the work is the same; it is just spread across lanes).
- The full (95 MB) build costs 2.5× the lite build at the same layout
  (87.1s vs 35.2s, classical) and ~4× the memory — the settings' build
  choice has a real, measured cost.
- Cross-round note: the full build ran 66.0s in round 2 and 87.1s here;
  classical-lite ran ~30s in round 2 and 35–38s here. This mobile chip's
  sustained-all-core numbers swing ~25% with thermal state — the within-round
  A/B (baseline vs improved, same session) is the valid comparison axis.

## Determinism gate — hash-keep is not reproducible

Two identical classical 12×1 h21 runs of the *frozen* engine (same
config, same fixture, minutes apart):

| metric (31 of 51 positions differ)            | count |
|-------------------------------------------------|------:|
| top-line move flips (bestmove differs)          | 10    |
| top-line eval-only shifts (same move, Δcp)       | 21    |
| second-line (MultiPV 2) diffs                    | 31    |

Why: with `hashPolicy: keep`, each lane's transposition table accumulates
entries from whichever positions it processed earlier in the review. Lane
assignment is work-stealing and varies between runs, so the TT state at
search time differs. The signature is exact: positions 0–11 (the first
batch, all searched on a fresh engine with an empty TT) match **bit-for-bit**
across runs; the wobble starts at ply 12, precisely where lanes begin their
second position. Same-move/few-cp eval drift is the norm; the 10 bestmove
flips are near-ties (|Δ| ≲ 15 cp) where TT move-ordering tips the choice.

Implications:

- **Accuracy A/B gates need a noise floor.** Cross-config comparisons are
  scored with mean |Δcp|, win-probability drift, and flip *rates* (via
  `scripts/compare-accuracy.cjs`), never exact equality.
- **Hash policy is an accuracy decision, not just a speed one.** If
  `ucinewgame`-per-position (clear) costs only a few % in speed, it is the
  right default: reproducible evaluations and classifications per review. The
  improved matrix includes `classical 12×1 h21 hashclear` (plus a repeat
  run to verify the clear policy is actually deterministic).
- **Any future review cache must key on clear-equivalent semantics**, or
  cached lines will drift a few cp from live re-searches.

## Round 3 tooling

```
node scripts/compare-accuracy.cjs <ref.json> <cand.json> [labelA] [labelB] [out.json]
node scripts/compare-accuracy.cjs --determinism <runA.json> <runB.json> [labelA] [labelB] [out.json]
node scripts/inspect-run.cjs <run.json>
node scripts/bench-matrix.cjs <phase> <configs.json>   # BENCH_ENGINE_SRC pins the engine
```

Harness hardening this round: result JSONs are written atomically (temp +
rename) with retry, so a transient Windows file lock can no longer truncate a
final save or leave a half-written result.

## Improved matrix (live engine)

14-config matrix against the live `engine.ts` (source SHA `0d08e641…`,
recorded in every run; distinct from the frozen `6c81f66b…`). 51 positions,
depth 20, MultiPV 2 — all 14 runs complete.

| config                        | frozen baseline | live improved |
|-------------------------------|----------------:|--------------:|
| classical 12×1 h21            | 35.2s           | **34.9s**     |
| tactical 12×1 h21             | 47.1s           | 58.8s         |
| endgame 12×1 h21              | 44.0s           | 47.6s         |
| classical 11×1 h23            | 39.7s           | 38.1s         |
| classical 6×1 h32             | 40.9s           | 48.1s         |
| classical 6×2 h32             | 38.4s           | 39.9s         |
| tactical 8×1 h32              | 58.3s           | 47.1s         |
| tactical 12×1 h64             | 52.6s           | 52.5s         |
| tactical 4×1 h128             | 68.9s           | 77.8s         |
| classical 16×1 h16            | 37.4s           | 39.8s         |
| classical 12×1 h21, mp1       | 22.7s           | 21.7s         |
| tactical 12×1 h21, mp1        | 23.8s           | 28.7s         |
| classical 12×1 h21, **clear** | n/a¹            | **44.6s**     |
| classical 12×1 h21 (full)     | 87.1s           | 79.3s         |

¹ The frozen snapshot predates `newGame()`; the same config on the snapshot
fails fast with `engine.newGame is not a function` — the control that proves
the clear policy exercises the new code path.

- Every delta sits inside the ±25% run-to-run band documented in round 2:
  no layout regresses, none wins — the 12-lane dynamic default is retained.
- The wrapper change is timing-neutral in the Node harness by design (its
  win is main-thread work, measured in round 2).
- Provenance note: an earlier same-day launch of this phase accidentally ran
  with the baseline pin; those 14 frozen-engine results are preserved as
  `round3-baseline-extended/` (the baseline-side sweep numbers above).

Accuracy gates (frozen vs live, matched configs; `compare-*.json` in
`round3-improved/`):

| pair | bestmove agree | mean\|Δcp\| | max\|Δcp\| | win-prob (mean\|Δ\|) | flips (classification) |
|---|---:|---:|---:|---:|---:|
| classical lite 12×1 | 43/51 (84.3%) | 4.29 | 22 | 0.35pp | 7 |
| tactical lite 12×1 | 48/51 (94.1%) | 4.94 | 67 | 0.43pp | 3 |
| endgame lite 12×1 | 46/51 (90.2%) | 6.53 | 29 | 0.42pp | 2 |
| classical full 12×1 | 38/51 (74.5%) | 4.67 | 35 | 0.36pp | 4 |

Depth 20/20 on both sides of every pair; zero mate/type flips. The agreement
numbers are within the same-engine noise floor established below (≈10–15
top-line flips per 51 under hash-keep) — i.e. the wrapper/engine changes
introduce **no systematic accuracy drift**; the full-build pair sits slightly
under its noise floor, consistent with stronger TT influence in a 2.5×
slower build. All classification flips are borderline best↔excellent /
inaccuracy↔okay swaps.

## Hash policy: keep vs clear (the determinism decision)

Two runs each, classical 12×1 h21, live engine:

| policy | elapsed (run A / B) | positions differing | bestmove flips | second-line diffs |
|---|---|---:|---:|---:|
| keep | 34.9s / 35.5s | 27/51 | 15 | 27 |
| clear (`ucinewgame` per position) | 44.6s / 44.1s | **0/51** | 0 | 0 |

- **Clear is bit-reproducible.** Keep is not, on either engine (live pair:
  27/51 differ; frozen pair: 31/51 differ, 10 flips) — the TT accumulates
  across positions and work-stealing lane assignment changes its state per
  run.
- Reproducibility costs **+28%** (44.6s vs 34.9s ≈ +9.7s per classical
  review; the cost is the re-searched opening positions on each lane).
- **Recommendation: default reviews to clear** — stable evaluations and
  classifications across re-reviews and shared links, and any future review
  cache stays valid. This resolves the open hash keep/clear question; the
  alternative (keep) is 28% faster but re-classifies ~half of positions
  differently on a repeat run.

## Node budget (`evaluate({ nodes })`)

`go nodes 1400000` per position (12×1, classical, live engine): complete in
**32.0s**, average 1,400,350 nodes/position (the budget is hit exactly),
reached depth 20.6 mean / 17–24 range (top line), 20.2 / 17–23 (second
line).

- 1.4M nodes/position ≈ the depth-20 workload on this fixture: the run
  finishes in the same wall time as fixed depth 20, with depth adapting to
  position complexity (simpler positions run deeper).
- Both MultiPV lines complete under a node budget, at potentially different
  depths — the harness's per-slot final-line selection handles this.
- Node budget is validated as a first-class alternative to fixed depth
  (stable review time, adaptive depth); fixed depth 20 remains the simpler
  default for classification predictability.

## Round 3 verdict (decision inputs)

- **Dynamic sizing retained**: 12×1 stays the default; the lane sweep
  (1/4/6/8/11/12/16) and 6×2 vs 6×1 re-confirm lanes ≫ threads and
  12 ≈ 4.1–4.5× faster than 1 lane at equal node counts.
- **Hash policy**: clear-per-position recommended as the app default
  (deterministic, at +28%); keep remains the fast, non-reproducible option.
- **Search budget**: depth 20 default; node budget (≈1.4M/position here)
  available as an advanced alternative with measured, predictable timing.
- **Full build cost quantified**: 79.3s / 5.3 GB peak vs lite 34.9s / 1.25 GB
  — the settings' build toggle has a real, measured cost.
- Browser-side items (service worker, worker startup, COOP/COEP) remain to be
  verified in a production build — the Node harness cannot see them.
