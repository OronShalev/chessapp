import { BoardState } from "@domain/types/game/position/BoardState";
import Evaluation from "@domain/types/game/position/Evaluation";

interface EvaluationGraphPoint {
    nodeId: string;
    state: BoardState;
    evaluation: Evaluation;
    x: number;
    y: number;
}

export default EvaluationGraphPoint;