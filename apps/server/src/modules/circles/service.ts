/**
 * Circles (Phase 37, ADR 0041): people message, call and add to groups only those in their
 * circle. A link is mutual: one user's request, the other's accept. Either may remove it.
 * - A request carries no message. Declining is silent: the sender keeps seeing "requested"
 *   until it expires (`CIRCLE_REQUEST_TTL_DAYS`). A request to someone who blocked the sender
 *   is stored as declined, so the block stays hidden.
 * - Blocking removes the link and the requests both ways (`sever`).
 * - The server keeps `circle_links` until either side removes them or deletes the account,
 *   and `circle_requests` for at most 30 days (TTL index). The privacy policy says so.
 * - Enforcement (`inCircle`) runs for every one-to-one envelope, call ring, typing frame and
 *   key claim, so each user's circle is cached in memory: filled at connect (`warm`) and
 *   updated on every change. The API is a single instance (ARCHITECTURE A2), so every change
 *   passes through here.
 */
import type { Collection, Db } from 'mongodb';

import {
  CIRCLE_REQUEST_TTL_DAYS,
  MAX_CIRCLE,
  MAX_PENDING_CIRCLE_REQUESTS,
  type CircleMember,
  type CirclePerson,
  type CircleRequest,
  type CircleRequestsResponse,
  type CircleState,
} from '@pingdost/shared-types';

import type { Clock } from '../../infra/clock';
import { WindowCounter } from '../../infra/counters';
import { AppError } from '../../infra/errors';
import type { IndexSetup } from '../../infra/mongo';
import type { Budget } from '../../infra/throttles';
import type { AuthCollections } from '../auth/repo';

export interface CircleLinkDoc {
  /** The two user IDs, sorted, joined by `:`. */
  _id: string;
  users: [string, string];
  since: Date;
}

export interface CircleRequestDoc {
  /** `${from}:${to}` */
  _id: string;
  from: string;
  to: string;
  createdAt: Date;
  /** The TTL index deletes the request then. */
  expiresAt: Date;
  /** The recipient declined (or had blocked the sender): hidden from them, "requested" to the sender. */
  declined: boolean;
}

export const circleIndexes: IndexSetup = async (db) => {
  await db.collection<CircleLinkDoc>('circle_links').createIndex({ users: 1 });
  const requests = db.collection<CircleRequestDoc>('circle_requests');
  await requests.createIndex({ to: 1, createdAt: 1 });
  await requests.createIndex({ from: 1, createdAt: 1 });
  await requests.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
};

export function linkId(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export interface CircleServiceDeps {
  db: Db;
  users: AuthCollections['users'];
  clock: Clock;
  /** New requests per account (`CIRCLE_REQUESTS_PER_DAY`). */
  requestBudget: Budget;
  /** Whether `blockerUserId` blocked `userId` (ADR 0014). */
  isBlocked: (blockerUserId: string, userId: string) => Promise<boolean>;
  /** `userId`'s lists changed because of `otherUserId`: their sockets get `CircleChanged`. */
  onChanged?: (userId: string, otherUserId: string) => void;
  /** A new request reached `toUserId` (a content-free push). */
  onRequested?: (toUserId: string, fromUserId: string) => void;
  /** `accepterUserId` accepted `requesterUserId`'s request (a content-free push). */
  onAccepted?: (requesterUserId: string, accepterUserId: string) => void;
}

/** Cached circles kept at once; beyond this the cache starts over. */
const MAX_CACHED = 10_000;
const DAY_MS = 86_400_000;

export class CircleService {
  readonly #links: Collection<CircleLinkDoc>;
  readonly #requests: Collection<CircleRequestDoc>;
  readonly #budget: WindowCounter;
  readonly #cache = new Map<string, Set<string>>();

  constructor(private readonly d: CircleServiceDeps) {
    this.#links = d.db.collection<CircleLinkDoc>('circle_links');
    this.#requests = d.db.collection<CircleRequestDoc>('circle_requests');
    this.#budget = new WindowCounter(d.requestBudget.limit, d.requestBudget.windowMs, d.clock);
  }

  /** Whether `a` and `b` are in each other's circle (a user is always in their own). */
  async inCircle(a: string, b: string): Promise<boolean> {
    if (a === b) return true;
    return (await this.#circleOf(a)).has(b);
  }

  /** Loads the user's circle into the cache (on connect), so sends need no Mongo read. */
  async warm(userId: string): Promise<void> {
    await this.#circleOf(userId);
  }

  /** Where each of `others` stands with `userId`'s circle (people search, Phase 38). */
  async statesFor(userId: string, others: readonly string[]): Promise<Map<string, CircleState>> {
    const circle = await this.#circleOf(userId);
    const now = new Date(this.d.clock.now());
    const ids = others.flatMap((other) => [`${userId}:${other}`, `${other}:${userId}`]);
    const requests =
      ids.length === 0
        ? []
        : await this.#requests
            .find(
              { _id: { $in: ids }, expiresAt: { $gt: now } },
              { projection: { declined: 1, from: 1 } },
            )
            .toArray();
    const states = new Map<string, CircleState>();
    for (const other of others) {
      if (circle.has(other)) {
        states.set(other, 'member');
        continue;
      }
      const asked = requests.some((r) => r._id === `${userId}:${other}`);
      // A declined request still shows as "requested" to its sender, and not to the decliner.
      const incoming = requests.some((r) => r._id === `${other}:${userId}` && !r.declined);
      states.set(other, asked ? 'requested' : incoming ? 'incoming' : 'none');
    }
    return states;
  }

  async list(userId: string): Promise<CircleMember[]> {
    const links = await this.#links.find({ users: userId }).sort({ since: 1 }).toArray();
    const others = links.map((link) => ({
      userId: link.users[0] === userId ? link.users[1] : link.users[0],
      since: link.since.getTime(),
    }));
    const people = await this.#people(others.map((other) => other.userId));
    return others.flatMap(({ userId: id, since }) => {
      const person = people.get(id);
      return person ? [{ ...person, since }] : [];
    });
  }

  async requests(userId: string): Promise<CircleRequestsResponse> {
    const now = new Date(this.d.clock.now());
    const [incoming, outgoing] = await Promise.all([
      this.#requests
        .find({ to: userId, declined: false, expiresAt: { $gt: now } })
        .sort({ createdAt: -1 })
        .toArray(),
      this.#requests
        .find({ from: userId, expiresAt: { $gt: now } })
        .sort({ createdAt: -1 })
        .toArray(),
    ]);
    const people = await this.#people([
      ...incoming.map((doc) => doc.from),
      ...outgoing.map((doc) => doc.to),
    ]);
    const view = (doc: CircleRequestDoc, other: string): CircleRequest[] => {
      const person = people.get(other);
      return person
        ? [{ ...person, createdAt: doc.createdAt.getTime(), expiresAt: doc.expiresAt.getTime() }]
        : [];
    };
    return {
      incoming: incoming.flatMap((doc) => view(doc, doc.from)),
      outgoing: outgoing.flatMap((doc) => view(doc, doc.to)),
    };
  }

  /**
   * `from` asks `to` into their circle. `linked` when they were linked already or `to` had
   * asked first (this accepts it); else `requested`, also when repeated.
   */
  async request(from: string, to: string): Promise<'requested' | 'linked'> {
    if (from === to) {
      throw new AppError('VALIDATION_FAILED', { detail: 'You are always in your own circle.' });
    }
    if (!(await this.d.users.countDocuments({ _id: to, status: 'active' }, { limit: 1 }))) {
      throw new AppError('NOT_FOUND');
    }
    if (await this.inCircle(from, to)) return 'linked';
    if (await this.d.isBlocked(from, to)) {
      throw new AppError('CONFLICT', { detail: 'Unblock them first.' });
    }
    const now = new Date(this.d.clock.now());
    // They asked first (or this user had declined them and changed their mind): a link.
    const reverse = await this.#requests.findOne({
      _id: `${to}:${from}`,
      expiresAt: { $gt: now },
    });
    if (reverse) {
      await this.#link(to, from);
      return 'linked';
    }
    const own = await this.#requests.findOne({ _id: `${from}:${to}`, expiresAt: { $gt: now } });
    if (own) return 'requested';

    if ((await this.#circleOf(from)).size >= MAX_CIRCLE) throw new AppError('CIRCLE_LIMIT_REACHED');
    const pending = await this.#requests.countDocuments({ from, expiresAt: { $gt: now } });
    if (pending >= MAX_PENDING_CIRCLE_REQUESTS) throw new AppError('CIRCLE_LIMIT_REACHED');
    const budget = this.#budget.hit(from);
    if (!budget.allowed) {
      throw new AppError('RATE_LIMITED', { retryAfterSeconds: budget.retryAfterSeconds });
    }
    // Someone who blocked the sender never sees the request; the sender sees "requested".
    const declined = await this.d.isBlocked(to, from);
    await this.#requests.replaceOne(
      { _id: `${from}:${to}` },
      {
        from,
        to,
        createdAt: now,
        expiresAt: new Date(now.getTime() + CIRCLE_REQUEST_TTL_DAYS * DAY_MS),
        declined,
      },
      { upsert: true },
    );
    this.d.onChanged?.(from, to);
    if (!declined) {
      this.d.onChanged?.(to, from);
      this.d.onRequested?.(to, from);
    }
    return 'requested';
  }

  /** `userId` accepts `from`'s waiting request. */
  async accept(userId: string, from: string): Promise<void> {
    const request = await this.#requests.findOne({
      _id: `${from}:${userId}`,
      declined: false,
      expiresAt: { $gt: new Date(this.d.clock.now()) },
    });
    if (!request) {
      if (await this.inCircle(userId, from)) return;
      throw new AppError('NOT_FOUND');
    }
    await this.#link(from, userId);
  }

  /** Silent: `from` keeps seeing "requested" until the request expires. */
  async decline(userId: string, from: string): Promise<void> {
    const result = await this.#requests.updateOne(
      { _id: `${from}:${userId}` },
      { $set: { declined: true } },
    );
    if (result.matchedCount > 0) this.d.onChanged?.(userId, from);
  }

  /** `userId` withdraws their request to `to`. */
  async withdraw(userId: string, to: string): Promise<void> {
    const doc = await this.#requests.findOneAndDelete({ _id: `${userId}:${to}` });
    if (!doc) return;
    this.d.onChanged?.(userId, to);
    if (!doc.declined) this.d.onChanged?.(to, userId);
  }

  /** Either side removes the link. No notice is sent; both sides' lists refresh. */
  async remove(userId: string, other: string): Promise<void> {
    const result = await this.#links.deleteOne({ _id: linkId(userId, other) });
    this.#forget(userId, other);
    if (result.deletedCount > 0) {
      this.d.onChanged?.(userId, other);
      this.d.onChanged?.(other, userId);
    }
  }

  /** A block between the two: the link and the requests go, both ways. */
  async sever(a: string, b: string): Promise<void> {
    const [link, requests] = await Promise.all([
      this.#links.deleteOne({ _id: linkId(a, b) }),
      this.#requests.deleteMany({ _id: { $in: [`${a}:${b}`, `${b}:${a}`] } }),
    ]);
    this.#forget(a, b);
    if (link.deletedCount + requests.deletedCount > 0) {
      this.d.onChanged?.(a, b);
      this.d.onChanged?.(b, a);
    }
  }

  /** A deleted account (ADR 0036): its links and requests, both ways. */
  async removeUser(userId: string): Promise<void> {
    const [links, requests] = await Promise.all([
      this.#links.find({ users: userId }, { projection: { users: 1 } }).toArray(),
      this.#requests
        .find({ $or: [{ from: userId }, { to: userId }] }, { projection: { from: 1, to: 1 } })
        .toArray(),
    ]);
    await Promise.all([
      this.#links.deleteMany({ users: userId }),
      this.#requests.deleteMany({ $or: [{ from: userId }, { to: userId }] }),
    ]);
    const others = new Set([
      ...links.map((link) => (link.users[0] === userId ? link.users[1] : link.users[0])),
      ...requests.map((doc) => (doc.from === userId ? doc.to : doc.from)),
    ]);
    this.#cache.delete(userId);
    for (const other of others) {
      this.#cache.get(other)?.delete(userId);
      this.d.onChanged?.(other, userId);
    }
  }

  async #link(requester: string, accepter: string): Promise<void> {
    const [mine, theirs] = await Promise.all([this.#circleOf(requester), this.#circleOf(accepter)]);
    if (mine.size >= MAX_CIRCLE || theirs.size >= MAX_CIRCLE) {
      throw new AppError('CIRCLE_LIMIT_REACHED');
    }
    const users = [requester, accepter].sort() as [string, string];
    await this.#links.updateOne(
      { _id: linkId(requester, accepter) },
      { $setOnInsert: { users, since: new Date(this.d.clock.now()) } },
      { upsert: true },
    );
    await this.#requests.deleteMany({
      _id: { $in: [`${requester}:${accepter}`, `${accepter}:${requester}`] },
    });
    this.#cache.get(requester)?.add(accepter);
    this.#cache.get(accepter)?.add(requester);
    this.d.onChanged?.(requester, accepter);
    this.d.onChanged?.(accepter, requester);
    this.d.onAccepted?.(requester, accepter);
  }

  #forget(a: string, b: string): void {
    this.#cache.get(a)?.delete(b);
    this.#cache.get(b)?.delete(a);
  }

  async #circleOf(userId: string): Promise<Set<string>> {
    const cached = this.#cache.get(userId);
    if (cached) return cached;
    const links = await this.#links.find({ users: userId }, { projection: { users: 1 } }).toArray();
    const circle = new Set(
      links.map((link) => (link.users[0] === userId ? link.users[1] : link.users[0])),
    );
    // Another call may have filled it meanwhile; keep the one already shared.
    const raced = this.#cache.get(userId);
    if (raced) return raced;
    if (this.#cache.size >= MAX_CACHED) this.#cache.clear();
    this.#cache.set(userId, circle);
    return circle;
  }

  async #people(userIds: readonly string[]): Promise<Map<string, CirclePerson>> {
    if (userIds.length === 0) return new Map();
    const docs = await this.d.users
      .find(
        { _id: { $in: [...new Set(userIds)] }, status: 'active' },
        { projection: { username: 1, displayName: 1, avatarUrl: 1 } },
      )
      .toArray();
    return new Map(
      docs.map((doc) => [
        doc._id,
        {
          userId: doc._id,
          username: doc.username,
          displayName: doc.displayName,
          avatarUrl: doc.avatarUrl,
        },
      ]),
    );
  }
}
