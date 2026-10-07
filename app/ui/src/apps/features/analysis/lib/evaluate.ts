import { sum, round } from "lodash-es";

import AnalysedGame from "@domain/types/game/AnalysedGame";
import EngineVersion from "@domain/constants/EngineVersion";
import { StateTreeNode, getNodeChain } from "@domain/types/game/position/StateTreeNode";
import { getTopEngineLine } from "@domain/types/game/position/EngineLine";
import Engine from "@analysis/lib/engine";
import getCloudEvaluation from "./cloudEvaluate";
import { getDeviceMemoryGB, getLogicalCoreCount, resolveEngineSizing } from "./engineSizing";

interface EvaluateMovesOptions {
    engineVersion: EngineVersion;
    /**
     * Upper bound on the number of local engines. When `dynamicSizing` is
     * enabled this is the cap the sizing is resolved against; otherwise it
     * is the exact engine count.
     */
    maxEngineCount?: number;
    /**
     * Derive the engine count, threads per engine, and hash size from the
     * machine's logical processor count, so the review saturates the CPU
     * without oversubscribing it.
     */
    dynamicSizing?: boolean;
    /** Threads per engine, used when `dynamicSizing` is disabled. */
    threads?: number;
    engineDepth: number;
    engineTimeLimit?: number;
    cloudEngineLines: number;
    engineConfig?: (engine: Engine) => void;
    onProgress?: (progress: number) => void;
    verbose?: boolean;
}

interface EvaluationProcess {
    evaluate: () => Promise<StateTreeNode[]>;
    controller: AbortController;
}

function createGameEvaluator(
    game: AnalysedGame,
    options: EvaluateMovesOptions
): EvaluationProcess {
    const controller = new AbortController();

    const stateTreeNodes = getNodeChain(game.stateTree);

    // The engine API takes each position's full cumulative UCI move list,
    // so precompute every prefix in one pass. Building the list per
    // position (slice + filter + map over the whole chain each time) is
    // O(depth) per position, i.e. O(n²) per game.
    const stateTreeMovePrefixes: string[][] = [];
    let movePrefix: string[] = [];

    for (const node of stateTreeNodes) {
        if (node.state.move) {
            movePrefix = [...movePrefix, node.state.move.uci];
        }

        stateTreeMovePrefixes.push(movePrefix);
    }

    // Each state tree node keeps a progress from 0 to 1
    const progresses: number[] = [];

    function getProgress() {
        return round(sum(progresses) / stateTreeNodes.length, 3);
    }

    async function evaluator(): Promise<StateTreeNode[]> {
        // Apply cloud evaluations where possible. Requests for the
        // opening prefix are issued in small concurrent batches so the
        // cloud phase takes one round-trip per batch instead of one per
        // position. The first position that is not in the cloud (or
        // returns insufficient data) ends the prefix, and everything from
        // there on is evaluated locally.
        const CLOUD_BATCH_SIZE = 8;

        for (
            let batchStart = 0;
            batchStart < stateTreeNodes.length;
            batchStart += CLOUD_BATCH_SIZE
        ) {
            if (controller.signal.aborted) break;

            const batchEnd = Math.min(
                batchStart + CLOUD_BATCH_SIZE,
                stateTreeNodes.length
            );

            const cloudResults = await Promise.all(
                stateTreeNodes.slice(batchStart, batchEnd).map(async node => {
                    try {
                        return await getCloudEvaluation(
                            node.state.fen, options.cloudEngineLines
                        );
                    } catch {
                        return null;
                    }
                })
            );

            let prefixBroken = false;

            for (let i = batchStart; i < batchEnd; i++) {
                const cloudEngineLines = cloudResults[i - batchStart];
                const topCloudLine = cloudEngineLines
                    ? getTopEngineLine(cloudEngineLines)
                    : undefined;

                if (
                    !cloudEngineLines
                    || !topCloudLine
                    || topCloudLine.depth < options.engineDepth
                    || cloudEngineLines.length < options.cloudEngineLines
                ) {
                    // This position has no usable cloud evaluation: stop
                    // the cloud phase, the local engines pick up here.
                    prefixBroken = true;
                    break;
                }

                stateTreeNodes[i].state.engineLines = [
                    ...stateTreeNodes[i].state.engineLines,
                    ...cloudEngineLines
                ];

                progresses[i] = 1;
                options.onProgress?.(getProgress());
            }

            if (prefixBroken) break;
        }

        // Locally evaluate remaining positions

        // Number of positions covered by the cloud prefix above
        const evaluatedStateCount = stateTreeNodes.filter(
            node => node.state.engineLines.some(
                line => line.source == EngineVersion.LICHESS_CLOUD
            )
        ).length;

        // +1: the last cloud-evaluated position is re-evaluated locally
        const remainingPositions =
            (stateTreeNodes.length - evaluatedStateCount) + 1;

        // How many engines to run and how many threads each gets. With
        // dynamic sizing these are derived from the machine's logical
        // processor count (one engine per core), so the review saturates
        // the CPU without oversubscribing it.
        const {
            engineCount, threads, hashMB
        } = options.dynamicSizing
            ? resolveEngineSizing({
                logicalCores: getLogicalCoreCount(),
                remainingPositions,
                deviceMemoryGB: getDeviceMemoryGB()
            })
            : {
                engineCount: Math.min(
                    options.maxEngineCount || 1,
                    remainingPositions
                ),
                threads: options.threads || 1,
                hashMB: 16
            };

        let enginesResting = 0;
        let stateTreeNodeIndex = Math.max(evaluatedStateCount - 1, 0);

        return await new Promise((res, rej) => {
            // The review settles at most once: the last resting engine
            // resolves it, an abort or a failed search rejects it, and any
            // later late settlement (e.g. a line batch that was in flight
            // when another lane failed) must not re-enter the result.
            let settled = false;

            function settle(fn: () => void) {
                if (settled) return;

                settled = true;
                fn();
            }

            // Bring an engine to a new FEN
            function evaluateNextPosition(engine: Engine) {
                const currentStateTreeNodeIndex = stateTreeNodeIndex;
                const currentStateTreeNode = stateTreeNodes[stateTreeNodeIndex];

                if (stateTreeNodeIndex >= stateTreeNodes.length) {
                    engine.terminate();

                    if (++enginesResting == engineCount)
                        settle(() => res(stateTreeNodes));

                    return;
                }

                engine.setPosition(
                    game.initialPosition,
                    stateTreeMovePrefixes[stateTreeNodeIndex]
                );

                engine.evaluate({
                    depth: options.engineDepth,
                    timeLimit: options.engineTimeLimit
                        ? options.engineTimeLimit * 1000
                        : undefined
                }).then(lines => {
                    // A batch that resolves after the review already settled
                    // (aborted / another lane failed) is stale: its lines
                    // belong to a review nobody is reading any more.
                    if (settled) return;

                    progresses[currentStateTreeNodeIndex] = 1;
                    options.onProgress?.(getProgress());

                    currentStateTreeNode.state.engineLines = [
                        ...currentStateTreeNode.state.engineLines,
                        ...lines
                    ];

                    evaluateNextPosition(engine);
                }).catch(error => {
                    // A failed search (engine crash, malformed PV, ...) must
                    // fail the review instead of leaving its lane hanging
                    // with a rejected promise nobody handles, which would
                    // stall the whole review forever.
                    settle(() => {
                        engines.forEach(laneEngine => laneEngine.terminate());
                        rej(error);
                    });
                });

                stateTreeNodeIndex++;
            }

            // Start engines on first positions
            const engines: Engine[] = [];

            if (!controller.signal.aborted) {
                for (let i = 0; i < engineCount; i++) {
                    const engine = new Engine(options.engineVersion);
                    engines.push(engine);

                    options.engineConfig?.(engine);

                    // These options are queued after the constructor's
                    // `uci`/`position` commands and before any `go`, so UCI
                    // command ordering is preserved.
                    engine.setThreadCount(threads);
                    engine.setOption("Hash", String(hashMB));

                    if (options.verbose) {
                        engine.onMessage(console.log);
                    }

                    engine.onError(error => settle(() => rej(error)));

                    evaluateNextPosition(engine);
                }
            }

            // Cancelled while the cloud prefix was still being collected.
            if (controller.signal.aborted) {
                engines.forEach(engine => engine.terminate());
                settle(() => rej("abort"));
                return;
            }

            controller.signal.addEventListener("abort", () => {
                engines.forEach(engine => engine.terminate());
                settle(() => rej("abort"));
            });
        });
    }

    return { evaluate: evaluator, controller };
}

export default createGameEvaluator;