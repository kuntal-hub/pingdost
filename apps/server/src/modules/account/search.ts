/**
 * People search (Phase 38, ADR 0042): `GET /v1/users/search?q=`, signed in.
 * - From 2 characters: username prefix and display-name word prefix (case- and accent-folded,
 *   from the stored `searchWords`), for accounts that allow "Find me by name". An exact
 *   username always matches, as the exact lookup always has.
 * - A whole email address matches only that address exactly, for accounts that allow "Find me
 *   by email". Part of an address finds nothing: email addresses cannot be discovered by typing
 *   fragments.
 * - At most 10 results; never the searcher, unverified or deleted accounts, or anyone either
 *   side blocked. Results carry the public profile and the circle state, never an email.
 * About four Mongo reads per search (users, blocks, circle requests; the circle is cached),
 * with a per-account budget sized for debounced typing (Atlas M0: 100 ops/s, ADR 0030).
 */
import type { Db, Filter } from 'mongodb';

import {
  EmailSchema,
  USER_SEARCH_LIMIT,
  UsernameSchema,
  type UserSearchResult,
} from '@pingdost/shared-types';

import type { Clock } from '../../infra/clock';
import { WindowCounter } from '../../infra/counters';
import { AppError } from '../../infra/errors';
import type { IndexSetup } from '../../infra/mongo';
import type { Budget } from '../../infra/throttles';
import type { AuthCollections, UserDoc } from '../auth/repo';
import type { CircleService } from '../circles/service';
import type { BlockService } from '../security/blocks';

/** Lower case, accents removed (é → e), so "Zoë" is found by "zoe". */
export function foldText(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** The words of a display name, folded: what a name search matches the start of. */
export function searchWordsOf(displayName: string | null | undefined): string[] {
  if (!displayName) return [];
  return [
    ...new Set(
      foldText(displayName)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((word) => word !== ''),
    ),
  ];
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The search field's index, and the field for accounts made before it existed. */
export const userSearchIndexes: IndexSetup = async (db: Db) => {
  const users = db.collection<UserDoc>('users');
  await users.createIndex({ searchWords: 1 });
  const missing = users.find(
    { searchWords: { $exists: false } },
    { projection: { displayName: 1 } },
  );
  for await (const user of missing) {
    await users.updateOne(
      { _id: user._id },
      { $set: { searchWords: searchWordsOf(user.displayName) } },
    );
  }
};

export interface UserSearchDeps {
  users: AuthCollections['users'];
  blocks: Pick<BlockService, 'blockedBetween'>;
  circles: Pick<CircleService, 'statesFor'>;
  clock: Clock;
  budget: Budget;
}

export class UserSearch {
  readonly #budget: WindowCounter;

  constructor(private readonly d: UserSearchDeps) {
    this.#budget = new WindowCounter(d.budget.limit, d.budget.windowMs, d.clock);
  }

  async search(userId: string, query: string): Promise<UserSearchResult[]> {
    const budget = this.#budget.hit(userId);
    if (!budget.allowed) {
      throw new AppError('RATE_LIMITED', { retryAfterSeconds: budget.retryAfterSeconds });
    }
    const filter = this.#filter(query);
    if (!filter) return [];
    // A few more than shown, so blocked people can be left out and still fill the list.
    const docs = await this.d.users
      .find(
        {
          $and: [filter, { _id: { $ne: userId }, status: 'active', username: { $type: 'string' } }],
        },
        { projection: { username: 1, displayName: 1, avatarUrl: 1 }, limit: USER_SEARCH_LIMIT * 2 },
      )
      .toArray();
    const exact = UsernameSchema.safeParse(query.replace(/^@/, ''));
    // The exact username first, then by username.
    docs.sort(
      (a, b) =>
        Number(b.username === exact.data) - Number(a.username === exact.data) ||
        (a.username ?? '').localeCompare(b.username ?? ''),
    );
    const ids = docs.map((doc) => doc._id);
    const blocked = await this.d.blocks.blockedBetween(userId, ids);
    const shown = docs.filter((doc) => !blocked.has(doc._id)).slice(0, USER_SEARCH_LIMIT);
    const states = await this.d.circles.statesFor(
      userId,
      shown.map((doc) => doc._id),
    );
    return shown.map((doc) => ({
      userId: doc._id,
      username: doc.username!,
      displayName: doc.displayName,
      avatarUrl: doc.avatarUrl,
      circle: states.get(doc._id) ?? 'none',
    }));
  }

  /** The Mongo filter for a query; undefined when it can match no one. */
  #filter(query: string): Filter<UserDoc> | undefined {
    const trimmed = query.trim();
    if (trimmed.includes('@') && !trimmed.startsWith('@')) {
      // An email address: only the whole address, never a fragment.
      const email = EmailSchema.safeParse(trimmed);
      if (!email.success) return undefined;
      return { email: email.data, 'privacy.findByEmail': { $ne: false } };
    }
    const folded = foldText(trimmed.replace(/^@/, ''));
    const terms = folded.split(/[^\p{L}\p{N}_.]+/u).filter((term) => term !== '');
    if (terms.length === 0 || folded.length < 2) return undefined;
    const nameTerms = terms.map((term) => term.replace(/[_.]/g, '')).filter((term) => term !== '');
    const byName: Filter<UserDoc>[] = [];
    if (nameTerms.length > 0) {
      // Every word of the query starts some word of the name ("asha k").
      byName.push({
        searchWords: { $all: nameTerms.map((term) => new RegExp(`^${escapeRegex(term)}`)) },
      });
    }
    if (terms.length === 1 && /^[a-z0-9_.]+$/.test(terms[0]!)) {
      byName.push({ username: new RegExp(`^${escapeRegex(terms[0]!)}`) });
    }
    const exact = UsernameSchema.safeParse(trimmed.replace(/^@/, ''));
    const any: Filter<UserDoc>[] = [
      ...(byName.length > 0 ? [{ $or: byName, 'privacy.findByName': { $ne: false } }] : []),
      ...(exact.success ? [{ username: exact.data }] : []),
    ];
    return any.length > 0 ? { $or: any } : undefined;
  }
}
