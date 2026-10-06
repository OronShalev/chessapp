import AnalysedGame from "@domain/types/game/AnalysedGame";
import { StateTreeNode } from "@domain/types/game/position/StateTreeNode";

interface ShareDialogProps {
    game: AnalysedGame;
    currentNode: StateTreeNode;
    onClose: () => void;
}

export default ShareDialogProps;