import { clamp } from "lodash-es";

/**
 * Sizes the local evaluation phase of a game review for the current
 * machine: how many engines to run in parallel, how many threads each
 * engine should use, and how much hash each engine may allocate.
 *
 * Positions are independent of each other, so each one gets its own engine
 * lane. The benchmark matrix shows that MORE lanes (more engines, one
 * thread each) finishes a review faster than fewer lanes with more threads
 * per engine, so the layout is one single-threaded engine per logical core:
 *
 *   engines = positions, threads = 1
 *
 * The total thread count then equals the core count exactly, so the CPU is
 * fully used but never oversubscribed (oversubscription is slower: the OS
 * has to time-slice threads that would otherwise run in parallel).
 *
 * A user who wants a fixed layout turns dynamic sizing off and sets the
 * "Number of Engines" manually.
 */
export function resolveEngineSizing({
    logicalCores,
    remainingPositions
}: {
    logicalCores: number;
    remainingPositions: number;
}): { engineCount: number; threads: number; hashMB: number } {
    const cores = Math.max(1, Math.floor(logicalCores || 4));

    // One engine per core (capped by the number of positions left to do).
    const engineCount = clamp(Math.min(remainingPositions, cores), 1, cores);
    const threads = 1;

    // Hash is per engine. Keep the whole review's transposition-table memory
    // bounded (~256 MB), with a floor large enough for a depth-20+ search.
    const hashMB = clamp(Math.floor(256 / engineCount), 8, 32);

    return { engineCount, threads, hashMB };
}

/**
 * The number of logical processors available to the browser, falling back
 * to a conservative default where the API is unavailable.
 */
export function getLogicalCoreCount(fallback = 4) {
    if (
        typeof navigator !== "undefined"
        && navigator.hardwareConcurrency > 0
    ) return navigator.hardwareConcurrency;

    return fallback;
}
