/**
 * The relay store (REQ §11.4): other people's encrypted packets, held until delivered or
 * expired. A byte cap (`MESH_RELAY_STORAGE_LIMIT_BYTES`), with expired packets evicted first
 * and then the oldest received; per-origin quotas refuse more from one origin token instead of
 * letting it push others out. The index lives in memory, payloads in the persistence layer.
 */
import type { MeshPersistence, RelayPacketMeta } from './persistence';
import type { MeshPolicy } from './policy';

export type PutResult = 'stored' | 'duplicate' | 'too_large' | 'origin_quota';

export interface RelayUsage {
  packets: number;
  bytes: number;
}

type StorePolicy = Pick<
  MeshPolicy,
  'storageLimitBytes' | 'perOriginMaxPackets' | 'perOriginMaxBytes'
>;

export class RelayStore {
  readonly #index = new Map<string, RelayPacketMeta>();
  #bytes = 0;
  /** Writes run one after another, so the index and the persistence agree. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly persistence: MeshPersistence,
    private policy: StorePolicy,
  ) {}

  /** Reads the stored index; expired packets are deleted on the way. */
  async load(nowMs: number): Promise<void> {
    const metas = await this.persistence.loadPackets();
    for (const meta of metas) {
      this.#index.set(meta.id, meta);
      this.#bytes += meta.size;
    }
    await this.prune(nowMs);
  }

  setPolicy(policy: StorePolicy): void {
    this.policy = policy;
  }

  usage(): RelayUsage {
    return { packets: this.#index.size, bytes: this.#bytes };
  }

  has(id: string): boolean {
    return this.#index.has(id);
  }

  get(id: string): RelayPacketMeta | undefined {
    return this.#index.get(id);
  }

  /** Every stored packet, oldest received first. */
  all(): RelayPacketMeta[] {
    return [...this.#index.values()];
  }

  readPayload(id: string): Promise<Uint8Array | undefined> {
    return this.persistence.readPayload(id);
  }

  put(meta: RelayPacketMeta, payload: Uint8Array, nowMs: number): Promise<PutResult> {
    return this.#serial(async () => {
      if (this.#index.has(meta.id)) return 'duplicate';
      const { storageLimitBytes, perOriginMaxBytes, perOriginMaxPackets } = this.policy;
      const size = payload.length;
      if (size > storageLimitBytes || size > perOriginMaxBytes) return 'too_large';
      let originBytes = 0;
      let originPackets = 0;
      for (const other of this.#index.values()) {
        if (other.origin !== meta.origin || other.expiresAt <= nowMs) continue;
        originBytes += other.size;
        originPackets++;
      }
      if (originPackets + 1 > perOriginMaxPackets || originBytes + size > perOriginMaxBytes) {
        return 'origin_quota';
      }
      await this.#makeRoom(size, nowMs);
      const stored = { ...meta, size };
      await this.persistence.putPacket(stored, payload);
      this.#index.set(stored.id, stored);
      this.#bytes += size;
      return 'stored';
    });
  }

  /** Records a new copy count (after handing some on). */
  setCopies(id: string, copies: number): Promise<void> {
    return this.#serial(async () => {
      const meta = this.#index.get(id);
      if (!meta || meta.copies === copies) return;
      const next = { ...meta, copies };
      this.#index.set(id, next);
      await this.persistence.updatePacket(next);
    });
  }

  remove(ids: readonly string[]): Promise<string[]> {
    return this.#serial(async () => {
      const gone = ids.filter((id) => this.#index.has(id));
      if (gone.length === 0) return [];
      for (const id of gone) {
        this.#bytes -= this.#index.get(id)!.size;
        this.#index.delete(id);
      }
      await this.persistence.deletePackets(gone);
      return gone;
    });
  }

  /** "Clear relay cache": every stored packet goes; chat history is elsewhere. */
  clear(): Promise<void> {
    return this.#serial(async () => {
      this.#index.clear();
      this.#bytes = 0;
      await this.persistence.clearPackets();
    });
  }

  /** Deletes expired packets; returns their IDs. */
  async prune(nowMs: number): Promise<string[]> {
    const expired = [...this.#index.values()].filter((m) => m.expiresAt <= nowMs).map((m) => m.id);
    return this.remove(expired);
  }

  /** Expired first, then the oldest received, until `size` more bytes fit. */
  async #makeRoom(size: number, nowMs: number): Promise<void> {
    const limit = this.policy.storageLimitBytes;
    if (this.#bytes + size <= limit) return;
    const order = [...this.#index.values()].sort(
      (a, b) =>
        Number(b.expiresAt <= nowMs) - Number(a.expiresAt <= nowMs) || a.receivedAt - b.receivedAt,
    );
    const evict: string[] = [];
    let bytes = this.#bytes;
    for (const meta of order) {
      if (bytes + size <= limit) break;
      evict.push(meta.id);
      bytes -= meta.size;
    }
    for (const id of evict) {
      this.#bytes -= this.#index.get(id)!.size;
      this.#index.delete(id);
    }
    if (evict.length > 0) await this.persistence.deletePackets(evict);
  }

  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }
}
