import { clamp } from "lodash-es";

/**
 * Cores reserved for the page itself (UI rendering, React, and the
 * main-thread engine glue) instead of for engine lanes. The WASM engines
 * run in workers, but the browser's main thread still competes with them
 * for cores; saturating every core makes the review UI stutter exactly when
 * the user is watching it. Reserving one core costs the review a small
 * fraction of wall time (measured in the round-3 benchmarks as the N vs
 * N-1 lane difference) in exchange for a responsive page.
 */
const UI_HEADROOM_CORES = 1;

/**
 * Sizes the local evaluation phase of a game review for the current
 * machine: how many engines to run in parallel, how many threads each
 * engine should use, and how much hash each engine may allocate.
 *
 * Positions are independent of each other, so each one gets its own engine
 * lane. The benchmark matrix shows that MORE lanes (more engines, one
 * thread each) finishes a review faster than fewer lanes with more threads
 * per engine, so the layout is one single-threaded engine per core:
 *
 *   engines = cores - UI_HEADROOM_CORES, threads = 1
 *
 * (floored at one lane). The total thread count stays at or below the core
 * count, so the CPU is well utilised without oversubscription (which is
 * slower: the OS has to time-slice threads that would otherwise run in
 * parallel).
 *
 * Hash is per engine. The whole review's transposition-table memory is
 * kept within a budget (≈256 MB by default, less on low-memory devices per
 * `navigator.deviceMemory`), with a floor large enough for depth-20+
 * searches.
 *
 * A user who wants a fixed layout turns dynamic sizing off and sets the
 * "Number of Engines" manually.
 */
export function resolveEngineSizing({
    logicalCores,
    remainingPositions,
    deviceMemoryGB
}: {
    logicalCores: number;
    remainingPositions: number;
    deviceMemoryGB?: number;
}): { engineCount: number; threads: number; hashMB: number } {
    const cores = Math.max(1, Math.floor(logicalCores || 4));

    // One lane per core, minus the headroom for the page. On a 2-core
    // machine no headroom is taken: a review there must not be reduced to a
    // crawl, and the page has fewer other things to do anyway.
    const lanes = Math.max(1, cores - (cores > 2 ? UI_HEADROOM_CORES : 0));

    // One engine per lane (capped by the number of positions left to do).
    const engineCount = clamp(Math.min(remainingPositions, lanes), 1, lanes);
    const threads = 1;

    // Total transposition-table budget for the whole review. Desktop-class
    // memory gets 256 MB; low-memory devices (navigator.deviceMemory, which
    // reports whole GB and is capped at 8) get a smaller budget so a long
    // review on, say, 4 GB of RAM does not push the tab into swap.
    const memory = deviceMemoryGB ?? 8;
    const totalHashMB = memory < 4 ? 64 : memory < 8 ? 128 : 256;

    const hashMB = clamp(Math.floor(totalHashMB / engineCount), 8, 32);

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

/**
 * Device RAM in GB per `navigator.deviceMemory` (Chromium only; the value
 * is a lower-bound hint, capped at 8). `undefined` where unavailable —
 * callers should treat that as "assume a desktop".
 */
export function getDeviceMemoryGB(): number | undefined {
    const deviceMemory = (
        navigator as { deviceMemory?: number } | undefined
    )?.deviceMemory;

    return deviceMemory && deviceMemory > 0 ? deviceMemory : undefined;
}
