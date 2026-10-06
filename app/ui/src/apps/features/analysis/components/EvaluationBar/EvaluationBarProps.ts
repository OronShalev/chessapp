import { CSSProperties } from "react";

import Evaluation from "@domain/types/game/position/Evaluation";
import PieceColour from "@domain/constants/PieceColour";

interface EvaluationBarProps {
    className?: string;
    style?: CSSProperties;
    evaluation: Evaluation;
    moveColour?: PieceColour;
    flipped?: boolean;
}

export default EvaluationBarProps;