import { ReactNode } from "react";

import { StateTreeNode } from "@domain/types/game/position/StateTreeNode";

interface MoveProps {
    node?: StateTreeNode;
    children?: ReactNode;
}

export default MoveProps;