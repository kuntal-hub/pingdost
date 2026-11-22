// The game with friends whose screen is open (Phase 43): while it is, its chat shows a "Back to
// game" pill. The game screen stays mounted under the chat when the user opens the chat from it.
import { create } from 'zustand';

export interface ActiveGame {
  gameId: string;
  conversationId: string;
  /** The game's name ("Connect Four"). */
  name: string;
  yourTurn: boolean;
}

export const useActiveGame = create<{ game: ActiveGame | null }>(() => ({ game: null }));

export function setActiveGame(game: ActiveGame): void {
  const current = useActiveGame.getState().game;
  if (
    current?.gameId === game.gameId &&
    current.yourTurn === game.yourTurn &&
    current.conversationId === game.conversationId
  ) {
    return;
  }
  useActiveGame.setState({ game });
}

/** The game screen closed: forget it, unless another game's screen took over. */
export function clearActiveGame(gameId: string): void {
  if (useActiveGame.getState().game?.gameId === gameId) useActiveGame.setState({ game: null });
}
