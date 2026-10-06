import { CSSProperties } from "react";

import { StateTreeNode } from "@domain/types/game/position/StateTreeNode";

interface StateTreeEditorProps {
    className?: string;
    style?: CSSProperties;
    stateTreeRootNode: StateTreeNode;
    onMoveClick?: (node: StateTreeNode) => void;
}

export default StateTreeEditorProps;