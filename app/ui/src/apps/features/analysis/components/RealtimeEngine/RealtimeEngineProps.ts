import { CSSProperties } from "react";

import { EngineLine } from "@domain/types/game/position/EngineLine";
import EngineVersion from "@domain/constants/EngineVersion";

interface RealtimeEngineProps {
    className?: string;
    style?: CSSProperties;
    initialPosition: string;
    playedUciMoves?: string[];
    config: {
        version: EngineVersion;
        depth: number;
        lines?: number;
        threads?: number;
        timeLimit?: number;
    };
    cachedEngineLines?: EngineLine[];
    onEngineLines?: (lines: EngineLine[]) => void;
    onEvaluationStart?: () => void;
    onEvaluationComplete?: (lines: EngineLine[]) => void;
}

export default RealtimeEngineProps;