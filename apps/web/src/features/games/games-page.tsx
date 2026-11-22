// The Games page (Phases 41–43, ADR 0049): games with friends (your turn, playing, invitations),
// unfinished solo games, the games to play, friends online to invite, the results kept in this
// browser, and what is coming. Games with friends live in their chat.
import { Play, UsersRound } from 'lucide-react';
import { Link } from 'react-router';

import { Button } from '@/components/ui/button';
import {
  BOT_LEVEL_NAMES,
  BOT_LEVELS,
  catalogEntry,
  GAME_CATALOG,
  isTurnGameId,
  LUDO_COLOR_NAMES,
  totals,
  TURN_GAME_IDS,
  turnRules,
  type CatalogEntry,
  type GameId,
} from '@pingdost/games';

import { FriendGames, FriendsOnline } from './friend-games';
import { GAME_ICONS } from './game-icons';
import { useGames } from './store';

function players(entry: CatalogEntry): string {
  return entry.minPlayers === entry.maxPlayers
    ? `${entry.minPlayers} players`
    : `${entry.minPlayers}–${entry.maxPlayers} players`;
}

function ContinueCard({ game, detail, to }: { game: GameId; detail: string; to: string }) {
  const entry = catalogEntry(game);
  const Glyph = GAME_ICONS[entry.icon];
  return (
    <section className="pd-card flex flex-wrap items-center gap-4 rounded-2xl p-4">
      <span className="flex size-12 items-center justify-center rounded-xl bg-raised text-accent">
        <Glyph aria-hidden size={26} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="font-bold">{entry.name} in progress</h2>
        <p className="text-sm text-muted">{detail}</p>
      </div>
      <Button asChild>
        <Link to={to}>
          <Play aria-hidden size={18} />
          Continue
        </Link>
      </Button>
    </section>
  );
}

function ContinueCards() {
  const solo = useGames((state) => state.solo);
  const turnSolo = useGames((state) => state.turnSolo);
  const cards = [];
  if (solo && solo.state.phase !== 'over') {
    const { options, state } = solo;
    const yourTurn = state.players[state.current]?.color === options.you;
    cards.push(
      <ContinueCard
        key="ludo"
        game="ludo"
        to="/games/ludo"
        detail={`You (${LUDO_COLOR_NAMES[options.you]}) against ${options.computers} ${
          options.computers === 1 ? 'computer player' : 'computer players'
        } · ${BOT_LEVEL_NAMES[options.level]}${yourTurn ? ' · your turn' : ''}`}
      />,
    );
  }
  for (const id of TURN_GAME_IDS) {
    const game = turnSolo[id];
    if (!game || game.state.ranks) continue;
    const others = game.options.computers;
    cards.push(
      <ContinueCard
        key={id}
        game={id}
        to={`/games/${id}`}
        detail={`Against ${others} ${others === 1 ? 'computer player' : 'computer players'}${
          turnRules(id).levels ? ` · ${BOT_LEVEL_NAMES[game.options.level]}` : ''
        }${game.state.current === 0 ? ' · your turn' : ''}`}
      />,
    );
  }
  return <>{cards}</>;
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
      <div className="grid grid-cols-2 gap-2">
        <Button asChild>
          <Link to={entry.id === 'ludo' ? '/games/ludo/setup' : `/games/${entry.id}/setup`}>
            <Play aria-hidden size={18} />
            Computer
          </Link>
        </Button>
        <Button asChild variant="secondary">
          <Link to={`/games/friends/${entry.id}`}>
            <UsersRound aria-hidden size={18} />
            Friends
          </Link>
        </Button>
      </div>
    </section>
  );
}

function Records() {
  const book = useGames((state) => state.stats);
  const played = GAME_CATALOG.filter((entry) => totals(book[entry.id]).played > 0);
  if (played.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-bold text-muted">Your record</h2>
      {played.map((entry) => {
        const stats = book[entry.id];
        const levels = !isTurnGameId(entry.id) || turnRules(entry.id).levels;
        const tallies = levels
          ? BOT_LEVELS.map((level) => ({
              label: BOT_LEVEL_NAMES[level],
              tally: stats?.solo[level],
            }))
          : [{ label: 'Against the computer', tally: totals(stats) }];
        return (
          <div key={entry.id} className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{entry.name}</h3>
            <ul className="grid grid-cols-3 gap-2">
              {tallies.map(({ label, tally }) => {
                const t = tally ?? { played: 0, won: 0 };
                return (
                  <li key={label} className="pd-card flex flex-col items-center rounded-xl py-3">
                    <span className="text-xl font-bold">
                      {t.won}/{t.played}
                      <span className="sr-only"> won</span>
                    </span>
                    <span className="text-xs text-muted">{label}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
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
      <ContinueCards />
      <div className="grid gap-4 sm:grid-cols-2">
        {available.map((entry) => (
          <GameCard key={entry.id} entry={entry} />
        ))}
      </div>
      <FriendsOnline />
      <Records />
      {soon.length > 0 && (
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
      )}
      <p className="text-xs text-muted">
        Games against the computer run only in this browser, and your results stay here. PingDost
        keeps no record of the games you play.
      </p>
    </div>
  );
}
