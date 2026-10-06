import { CSSProperties } from "react";

import Game from "@domain/types/game/Game";

interface GameSelectorProps {
    style?: CSSProperties;
    saveLocalStorage?: boolean;
    onGameSelect?: (game: Game | string | null) => void;
}

export default GameSelectorProps;