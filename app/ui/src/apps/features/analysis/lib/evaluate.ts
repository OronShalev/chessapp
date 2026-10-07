import { sum, round } from "lodash-es";

import AnalysedGame from "@domain/types/game/AnalysedGame";
import EngineVersion from "@domain/constants/EngineVersion";
import { StateTreeNode, getNodeChain } from "@domain/types/game/position/StateTreeNode";
import { getTopEngineLine } from "@domain/types/game/position/EngineLine";
import Engine from "@analysis/lib/engine";
import getCloudEvaluation from "./cloudEvaluate";
import { getLogicalCoreCount, resolveEngineSizing } from "./engineSizing";

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
        const CLOUD_BATCH_SIZE = 4;

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
                remainingPositions
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
            // Bring an engine to a new FEN
            function evaluateNextPosition(engine: Engine) {
                const currentStateTreeNodeIndex = stateTreeNodeIndex;
                const currentStateTreeNode = stateTreeNodes[stateTreeNodeIndex];

                if (stateTreeNodeIndex >= stateTreeNodes.length) {
                    engine.terminate();

                    if (++enginesResting == engineCount)
                        res(stateTreeNodes);

                    return;
                }

                engine.setPosition(game.initialPosition, stateTreeNodes
                    .slice(0, stateTreeNodeIndex + 1)
                    .filter(node => node.state.move)
                    .map(node => node.state.move!.uci)
                );

                engine.evaluate({
                    depth: options.engineDepth,
                    timeLimit: options.engineTimeLimit
                        ? options.engineTimeLimit * 1000
                        : undefined
                }).then(lines => {
                    progresses[currentStateTreeNodeIndex] = 1;
                    options.onProgress?.(getProgress());

                    currentStateTreeNode.state.engineLines = [
                        ...currentStateTreeNode.state.engineLines,
                        ...lines
                    ];

                    evaluateNextPosition(engine);
                });

                stateTreeNodeIndex++;
            }

            // Start engines on first positions
            const engines: Engine[] = [];

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

                engine.onError(rej);

                evaluateNextPosition(engine);
            }

            controller.signal.addEventListener("abort", () => {
                engines.forEach(engine => engine.terminate());
                rej("abort");
            });
        });
    }

    return { evaluate: evaluator, controller };
}

export default createGameEvaluator;