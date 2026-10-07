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
