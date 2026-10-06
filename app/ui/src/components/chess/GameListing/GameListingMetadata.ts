import Game from "@domain/types/game/Game";

type GameListingMetadata = Game & Partial<Game>;

export default GameListingMetadata;