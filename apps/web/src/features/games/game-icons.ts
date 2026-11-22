// Each game's icon in the browser (the catalog names an icon key; Lucide draws it).
import {
  ChessKing,
  CircleDot,
  Club,
  Coins,
  Dices,
  Grid3x3,
  Grip,
  Route,
  Spade,
  type LucideIcon,
} from 'lucide-react';

import { catalogEntry, isPlayableGameType, type CatalogEntry } from '@pingdost/games';

export const GAME_ICONS: Record<CatalogEntry['icon'], LucideIcon> = {
  dice: Dices,
  grid: Grid3x3,
  circles: CircleDot,
  dots: Grip,
  ladder: Route,
  chess: ChessKing,
  cards: Club,
  spade: Spade,
  chips: Coins,
};

/** The icon of a game type from the engine (`GameRecord.gameType`); dice for unknown types. */
export function gameIconFor(type: string): LucideIcon {
  return isPlayableGameType(type) ? GAME_ICONS[catalogEntry(type).icon] : Dices;
}
