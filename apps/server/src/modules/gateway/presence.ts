/**
 * Presence (REQ §8.1, ADR 0012): transient and in memory only, never written anywhere.
 * - A user is online while one of their sockets says it is in the foreground (`Presence`
 *   with `online`), until that socket says otherwise or closes.
 * - A socket watches the users it names (the open chat's peer), at most `MAX_PRESENCE_WATCH`.
 * - Reciprocal: only users who share their presence (`privacy.lastSeen`) are reported, and
 *   only to users who share their own.
 * - Never between two users when either blocked the other (ADR 0014).
 * The server keeps no contact list, so watching is explicit; a single API instance holds
 * all state (ARCHITECTURE A2). The watch lists also scope typing (the open chat's peer).
 */
import { MAX_PRESENCE_WATCH } from '@pingdost/protocol';

export interface PresencePeer {
  readonly userId: string;
  /** Sends `Presence{user_id, online}` to this socket (best effort). */
  notifyPresence(userId: string, online: boolean): void;
}

export interface PresenceOptions {
  /** Whether the user shares presence (`privacy.lastSeen`); cached for `cacheMs`. */
  sharesPresence(userId: string): Promise<boolean>;
  /** Whether either user blocked the other. */
  blocked?(a: string, b: string): Promise<boolean>;
  cacheMs?: number;
  now?: () => number;
}

export class PresenceHub<P extends PresencePeer = PresencePeer> {
  readonly #foreground = new Map<P, boolean>();
  readonly #peersOf = new Map<string, Set<P>>();
  readonly #watchers = new Map<string, Set<P>>();
  readonly #watching = new Map<P, Set<string>>();
  /** The last online state told to watchers, per user. */
  readonly #announced = new Map<string, boolean>();
  readonly #shares = new Map<string, { value: boolean; at: number }>();

  constructor(private readonly options: PresenceOptions) {}

  /** A `Presence` frame from `peer`: its foreground state and the users it watches. */
  async update(peer: P, online: boolean, watch: readonly string[]): Promise<void> {
    this.#foreground.set(peer, online);
    let peers = this.#peersOf.get(peer.userId);
    if (!peers) {
      peers = new Set();
      this.#peersOf.set(peer.userId, peers);
    }
    peers.add(peer);

    const before = this.#watching.get(peer) ?? new Set<string>();
    const next = new Set(watch.filter((id) => id !== peer.userId).slice(0, MAX_PRESENCE_WATCH));
    for (const userId of before) if (!next.has(userId)) this.#unwatch(peer, userId);
    for (const userId of next) {
      let watchers = this.#watchers.get(userId);
      if (!watchers) {
        watchers = new Set();
        this.#watchers.set(userId, watchers);
      }
      watchers.add(peer);
    }
    this.#watching.set(peer, next);

    await this.#announce(peer.userId);
    // Newly watched users: the current state at once.
    if (!(await this.#sharesPresence(peer.userId))) return;
    for (const userId of next) {
      if (before.has(userId) || (await this.#blocked(peer.userId, userId))) continue;
      peer.notifyPresence(userId, await this.#online(userId));
    }
  }

  /** Whether `peer` watches `userId` (its user has that chat open). */
  watches(peer: P, userId: string): boolean {
    return this.#watching.get(peer)?.has(userId) ?? false;
  }

  /** After `a` blocked or unblocked `b`: each one's sockets watching the other learn the state. */
  async blocksChanged(a: string, b: string): Promise<void> {
    const blocked = await this.#blocked(a, b);
    for (const [watcherUser, watched] of [
      [a, b],
      [b, a],
    ] as const) {
      if (!(await this.#sharesPresence(watcherUser))) continue;
      const online = !blocked && (await this.#online(watched));
      for (const watcher of [...(this.#watchers.get(watched) ?? [])]) {
        if (watcher.userId === watcherUser) watcher.notifyPresence(watched, online);
      }
    }
  }

  /** The socket closed. */
  async remove(peer: P): Promise<void> {
    if (!this.#foreground.has(peer)) return;
    this.#foreground.delete(peer);
    const peers = this.#peersOf.get(peer.userId);
    peers?.delete(peer);
    if (peers?.size === 0) this.#peersOf.delete(peer.userId);
    for (const userId of this.#watching.get(peer) ?? []) this.#unwatch(peer, userId);
    this.#watching.delete(peer);
    await this.#announce(peer.userId);
  }

  /** Forgets a cached privacy setting (after the user changed it). */
  invalidate(userId: string): void {
    this.#shares.delete(userId);
    void this.#announce(userId);
  }

  #unwatch(peer: P, userId: string): void {
    const watchers = this.#watchers.get(userId);
    watchers?.delete(peer);
    if (watchers?.size === 0) this.#watchers.delete(userId);
  }

  /** Tells watchers when the user's online state changed. */
  async #announce(userId: string): Promise<void> {
    const online = await this.#online(userId);
    if ((this.#announced.get(userId) ?? false) === online) return;
    if (online) this.#announced.set(userId, true);
    else this.#announced.delete(userId);
    for (const watcher of [...(this.#watchers.get(userId) ?? [])]) {
      if (!(await this.#sharesPresence(watcher.userId))) continue;
      if (await this.#blocked(watcher.userId, userId)) continue;
      watcher.notifyPresence(userId, online);
    }
  }

  async #blocked(a: string, b: string): Promise<boolean> {
    return (await this.options.blocked?.(a, b).catch(() => true)) ?? false;
  }

  async #online(userId: string): Promise<boolean> {
    const peers = this.#peersOf.get(userId);
    if (!peers || ![...peers].some((peer) => this.#foreground.get(peer))) return false;
    return this.#sharesPresence(userId);
  }

  async #sharesPresence(userId: string): Promise<boolean> {
    const now = (this.options.now ?? Date.now)();
    const cached = this.#shares.get(userId);
    if (cached && now - cached.at < (this.options.cacheMs ?? 15_000)) return cached.value;
    const value = await this.options.sharesPresence(userId).catch(() => false);
    this.#shares.set(userId, { value, at: now });
    return value;
  }
}
