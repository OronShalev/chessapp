import { StatusCodes } from "http-status-codes";
import { clone } from "lodash-es";

import AnalysisOptions from "@domain/lib/reporter/types/AnalysisOptions";
import { getGameAnalysis } from "@domain/lib/reporter/report";
import { GameAnalysis } from "@domain/types/game/GameAnalysis";
import { StateTreeNode } from "@domain/types/game/position/StateTreeNode";
import APIResponse from "@/types/APIResponse";

/**
 * Classifies an evaluated state tree as a full game analysis.
 *
 * Runs the same pure `getGameAnalysis` reporter pass that the
 * `/api/analysis/analyse` endpoint wraps, but in-process: that endpoint
 * does nothing else, and calling it meant shipping the whole tree over the
 * network — which is impossible in the native (Android) build, where the
 * app's webview origin has no backend behind it, and which large trees
 * could also trip the endpoint's 1MB body limit. Locally the result is
 * identical.
 */
export async function analyseStateTree(
    rootNode: StateTreeNode,
    options?: AnalysisOptions
): APIResponse<{ gameAnalysis: GameAnalysis }> {
    const gameAnalysis = getGameAnalysis(rootNode, options);

    return {
        status: StatusCodes.OK,
        gameAnalysis
    };
}

export async function analyseNode(
    node: StateTreeNode,
    options?: AnalysisOptions
): APIResponse<{ node: StateTreeNode }> {
    if (!node.parent)
        return { status: StatusCodes.BAD_REQUEST };

    const childlessNode = clone(node);
    childlessNode.children = [];

    const parentNode = clone(node.parent);
    parentNode.children = [childlessNode];

    const reportResult = await analyseStateTree(parentNode, options);
    const analysedNode = reportResult.gameAnalysis?.stateTree.children.at(0);

    return {
        status: reportResult.status,
        node: analysedNode
    };
}