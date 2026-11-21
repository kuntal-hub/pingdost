// Play statistics, kept only on the device (ADR 0049: no server record of who plays).
import { BOT_LEVELS, type BotLevel, type GameId } from './types';

export interface Tally {
  played: number;
  won: number;
}

export interface GameStats {
  /** Solo games by computer level. */
  solo: Record<BotLevel, Tally>;
  /** Games with friends (Phase 42). */
  friends: Tally;
}

export type StatsBook = Partial<Record<GameId, GameStats>>;

export function emptyStats(): GameStats {
  return {
    solo: {
      easy: { played: 0, won: 0 },
      medium: { played: 0, won: 0 },
      hard: { played: 0, won: 0 },
    },
    friends: { played: 0, won: 0 },
  };
}

/** A stats book read from storage: anything malformed counts as zero. */
export function normalizeStats(raw: unknown): StatsBook {
  if (typeof raw !== 'object' || raw === null) return {};
  const book: StatsBook = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as Record<string, unknown>;
    const stats = emptyStats();
    const soloRaw = (entry.solo ?? {}) as Record<string, unknown>;
    for (const level of BOT_LEVELS) stats.solo[level] = tally(soloRaw[level]);
    stats.friends = tally(entry.friends);
    book[id as GameId] = stats;
  }
  return book;
}

/** Counts one finished game. */
export function recordResult(
  book: StatsBook,
  game: GameId,
  mode: { solo: BotLevel } | 'friends',
  won: boolean,
): StatsBook {
  const current = book[game] ?? emptyStats();
  const stats: GameStats = {
    solo: {
      easy: { ...current.solo.easy },
      medium: { ...current.solo.medium },
      hard: { ...current.solo.hard },
    },
    friends: { ...current.friends },
  };
  const entry = mode === 'friends' ? stats.friends : stats.solo[mode.solo];
  entry.played += 1;
  if (won) entry.won += 1;
  return { ...book, [game]: stats };
}

/** All games of one kind added up. */
export function totals(stats: GameStats | undefined): Tally {
  if (!stats) return { played: 0, won: 0 };
  const all = [...BOT_LEVELS.map((level) => stats.solo[level]), stats.friends];
  return all.reduce((sum, t) => ({ played: sum.played + t.played, won: sum.won + t.won }), {
    played: 0,
    won: 0,
  });
}

function tally(raw: unknown): Tally {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const count = (n: unknown): number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  const played = count(value.played);
  return { played, won: Math.min(count(value.won), played) };
}
