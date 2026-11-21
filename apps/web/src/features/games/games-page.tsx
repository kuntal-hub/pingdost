// The Games page (Phase 41, ADR 0049): games with friends (your turn, playing, invitations),
// friends online to invite, the catalog, an unfinished solo game and the results kept in this
// browser. Games with friends live in their chat (Phase 42).
import {
  ChessKing,
  CircleDot,
  Club,
  Coins,
  Dices,
  Grid3x3,
  Grip,
  Play,
  Route,
  Spade,
  type LucideIcon,
} from 'lucide-react';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';
import {
  BOT_LEVEL_NAMES,
  BOT_LEVELS,
  GAME_CATALOG,
  LUDO_COLOR_NAMES,
  totals,
  type CatalogEntry,
} from '@pingdost/games';

import { FriendGames, FriendsOnline } from './friend-games';
import { useGames } from './store';

const GAME_ICONS: Record<CatalogEntry['icon'], LucideIcon> = {
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

function players(entry: CatalogEntry): string {
  return entry.minPlayers === entry.maxPlayers
    ? `${entry.minPlayers} players`
    : `${entry.minPlayers}–${entry.maxPlayers} players`;
}

function ContinueCard() {
  const solo = useGames((state) => state.solo);
  if (!solo || solo.state.phase === 'over') return null;
  const { options, state } = solo;
  const yourTurn = state.players[state.current]?.color === options.you;
  return (
    <section className="pd-card flex flex-wrap items-center gap-4 rounded-2xl p-4">
      <span className="flex size-12 items-center justify-center rounded-xl bg-raised text-accent">
        <Dices aria-hidden size={26} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="font-bold">Ludo in progress</h2>
        <p className="text-sm text-muted">
          You ({LUDO_COLOR_NAMES[options.you]}) against {options.computers}{' '}
          {options.computers === 1 ? 'computer player' : 'computer players'} ·{' '}
          {BOT_LEVEL_NAMES[options.level]}
          {yourTurn ? ' · your turn' : ''}
        </p>
      </div>
      <Button asChild>
        <Link to="/games/ludo">
          <Play aria-hidden size={18} />
          Continue
        </Link>
      </Button>
    </section>
  );
}

function GameCard({ entry }: { entry: CatalogEntry }) {
  const Glyph = GAME_ICONS[entry.icon];
  return (
    <section className="pd-card flex flex-col gap-3 rounded-2xl p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-14 items-center justify-center rounded-xl bg-raised text-accent">
          <Glyph aria-hidden size={30} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-xl font-extrabold">{entry.name}</h2>
          <p className="text-sm text-muted">{entry.tagline}</p>
          <p className="text-xs text-muted">{players(entry)}</p>
        </div>
      </div>
      <Button asChild>
        <Link to="/games/ludo/setup">Play with the computer</Link>
      </Button>
      <p className="text-center text-xs text-muted">
        To play with friends, start a game from a chat, or invite a friend below.
      </p>
    </section>
  );
}

function Record() {
  const stats = useGames((state) => state.stats.ludo);
  if (totals(stats).played === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-bold text-muted">Your Ludo record</h2>
      <ul className="grid grid-cols-3 gap-2">
        {BOT_LEVELS.map((level) => {
          const tally = stats?.solo[level] ?? { played: 0, won: 0 };
          return (
            <li key={level} className="pd-card flex flex-col items-center rounded-xl py-3">
              <span className="text-xl font-bold">
                {tally.won}/{tally.played}
                <span className="sr-only"> won</span>
              </span>
              <span className="text-xs text-muted">{BOT_LEVEL_NAMES[level]}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function GamesPage() {
  const available = GAME_CATALOG.filter((entry) => entry.available);
  const soon = GAME_CATALOG.filter((entry) => !entry.available);
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 p-4 md:p-6">
      <h1 className="font-display text-2xl font-extrabold">Games</h1>
      <FriendGames />
      <ContinueCard />
      {available.map((entry) => (
        <GameCard key={entry.id} entry={entry} />
      ))}
      <FriendsOnline />
      <Record />
      <section className="flex flex-col gap-2">
        <h2 className="font-bold text-muted">Coming soon</h2>
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {soon.map((entry) => {
            const Glyph = GAME_ICONS[entry.icon];
            return (
              <li
                key={entry.id}
                className="flex flex-col items-center gap-1 rounded-xl bg-raised px-2 py-3 text-muted"
              >
                <Glyph aria-hidden size={24} />
                <span className="truncate text-xs font-semibold">{entry.name}</span>
              </li>
            );
          })}
        </ul>
      </section>
      <p className="text-xs text-muted">
        Games against the computer run only in this browser, and your results stay here. PingDost
        keeps no record of the games you play.
      </p>
    </div>
  );
}
