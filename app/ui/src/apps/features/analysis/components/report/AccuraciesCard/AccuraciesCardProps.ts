import { GameAnalysis } from "@domain/types/game/GameAnalysis";

interface AccuraciesCardProps {
    accuracies: {
        white: number;
        black: number;
    };
    estimatedRatings?: GameAnalysis["estimatedRatings"];
}

export default AccuraciesCardProps;