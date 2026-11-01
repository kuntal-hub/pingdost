/**
 * The bounded seen-packet cache (REQ §11.4, §14.1 `seen_mesh_packets`): packet IDs this
 * device took, so a duplicate encounter is answered DUPLICATE and creates nothing new, and a
 * loop ends. Least recently used IDs go first past `max`; an ID is forgotten once its packet
 * expired, since an expired packet is refused anyway.
 */
export interface SeenEntry {
  /** The packet ID, hex. */
  id: string;
  /** The packet's expiry, epoch ms. */
  expiresAt: number;
}

export class SeenCache {
  /** Insertion order is recency: touched entries move to the end. */
  readonly #entries = new Map<string, number>();

  constructor(private readonly max: number) {}

  get size(): number {
    return this.#entries.size;
  }

  load(entries: readonly SeenEntry[], nowMs: number): void {
    for (const entry of [...entries].sort((a, b) => a.expiresAt - b.expiresAt)) {
      if (entry.expiresAt > nowMs) this.#entries.set(entry.id, entry.expiresAt);
    }
    this.#trim();
  }

  has(id: string, nowMs: number): boolean {
    const expiresAt = this.#entries.get(id);
    if (expiresAt === undefined) return false;
    if (expiresAt <= nowMs) {
      this.#entries.delete(id);
      return false;
    }
    this.#entries.delete(id);
    this.#entries.set(id, expiresAt);
    return true;
  }

  /** Records an ID; returns the IDs evicted to stay within `max`. */
  add(id: string, expiresAt: number): string[] {
    this.#entries.delete(id);
    this.#entries.set(id, expiresAt);
    return this.#trim();
  }

  /** Forgets expired IDs; returns them. */
  prune(nowMs: number): string[] {
    const gone: string[] = [];
    for (const [id, expiresAt] of this.#entries) {
      if (expiresAt <= nowMs) gone.push(id);
    }
    for (const id of gone) this.#entries.delete(id);
    return gone;
  }

  #trim(): string[] {
    const evicted: string[] = [];
    for (const id of this.#entries.keys()) {
      if (this.#entries.size - evicted.length <= this.max) break;
      evicted.push(id);
    }
    for (const id of evicted) this.#entries.delete(id);
    return evicted;
  }
}
