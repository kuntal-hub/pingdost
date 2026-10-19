/**
 * Blocks (REQ §15 security/abuse, ADR 0014). A block is one user's private choice:
 * - the blocked user is not told: their sends to the blocker are answered `Accepted` and
 *   dropped (they keep seeing "sent"), so they cannot learn of the block from the server;
 * - lookups by username or ID still work, both ways;
 * - presence and typing between the two stop, both ways.
 * The API runs as one instance (ARCHITECTURE A2), so each blocker's list is cached in memory
 * and dropped on every change.
 */
import type { Collection, Db } from 'mongodb';

import { MAX_BLOCKS } from '@pingdost/shared-types';

import type { Clock } from '../../infra/clock';
import { AppError } from '../../infra/errors';
import type { IndexSetup } from '../../infra/mongo';

export interface BlockDoc {
  /** `${blockerUserId}:${blockedUserId}` */
  _id: string;
  blockerUserId: string;
  blockedUserId: string;
  createdAt: Date;
}

export const blockIndexes: IndexSetup = async (db) => {
  await db.collection<BlockDoc>('blocks').createIndex({ blockerUserId: 1, createdAt: 1 });
};

/** Cached lists kept at once; beyond this the cache starts over. */
const MAX_CACHED = 10_000;

export class BlockService {
  readonly #blocks: Collection<BlockDoc>;
  readonly #cache = new Map<string, { ids: ReadonlySet<string>; at: number }>();

  constructor(
    db: Db,
    private readonly clock: Clock,
    private readonly cacheMs = 60_000,
  ) {
    this.#blocks = db.collection<BlockDoc>('blocks');
  }

  /** The users `blockerUserId` blocked, oldest block first. */
  async list(blockerUserId: string): Promise<string[]> {
    const docs = await this.#blocks
      .find({ blockerUserId }, { projection: { blockedUserId: 1 } })
      .sort({ createdAt: 1 })
      .toArray();
    return docs.map((doc) => doc.blockedUserId);
  }

  /** Idempotent. */
  async block(blockerUserId: string, blockedUserId: string): Promise<void> {
    if (blockerUserId === blockedUserId) {
      throw new AppError('VALIDATION_FAILED', { detail: 'You cannot block yourself.' });
    }
    const _id = `${blockerUserId}:${blockedUserId}`;
    if (await this.#blocks.countDocuments({ _id }, { limit: 1 })) return;
    if ((await this.#blocks.countDocuments({ blockerUserId })) >= MAX_BLOCKS) {
      throw new AppError('BLOCK_LIMIT_REACHED');
    }
    await this.#blocks.updateOne(
      { _id },
      {
        $setOnInsert: {
          blockerUserId,
          blockedUserId,
          createdAt: new Date(this.clock.now()),
        },
      },
      { upsert: true },
    );
    this.#cache.delete(blockerUserId);
  }

  /** Idempotent. */
  async unblock(blockerUserId: string, blockedUserId: string): Promise<void> {
    await this.#blocks.deleteOne({ _id: `${blockerUserId}:${blockedUserId}` });
    this.#cache.delete(blockerUserId);
  }

  /** Whether `blockerUserId` blocked `userId`. */
  async isBlocked(blockerUserId: string, userId: string): Promise<boolean> {
    if (blockerUserId === userId) return false;
    return (await this.#blockedBy(blockerUserId)).has(userId);
  }

  /** Whether either user blocked the other (presence, typing). */
  async eitherBlocked(a: string, b: string): Promise<boolean> {
    return (await this.isBlocked(a, b)) || (await this.isBlocked(b, a));
  }

  async #blockedBy(blockerUserId: string): Promise<ReadonlySet<string>> {
    const now = this.clock.now();
    const cached = this.#cache.get(blockerUserId);
    if (cached && now - cached.at < this.cacheMs) return cached.ids;
    const ids = new Set(await this.list(blockerUserId));
    if (this.#cache.size >= MAX_CACHED) this.#cache.clear();
    this.#cache.set(blockerUserId, { ids, at: now });
    return ids;
  }
}
