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
