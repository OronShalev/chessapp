import Game from "@domain/types/game/Game";
import { GameSourceData } from "@/components/chess/GameSelector/GameSource";

interface GameSearchMenuProps {
    username: string;
    gameSource: GameSourceData;
    onClose: () => void;
    onGameSelect?: (game: Game) => void;
}

export default GameSearchMenuProps;