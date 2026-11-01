/**
 * Receiving files over the mesh (Phase 24, ADR 0027): chunks arrive in any order, from the
 * sender or from relays, across many links. This keeps a bitmap per transfer, stores each
 * chunk durably before it is acknowledged, tells holders what is still missing (`progress`),
 * and once every chunk is here and the manifest is known, checks the whole file
 * (`verifyMeshFile`) before reporting it. A failed check drops the chunks: the sender still
 * holds them and they come again. Structurally a `MeshFileSink` of `@pingdost/transport`.
 */
import type { CryptoProvider } from '@pingdost/crypto/core';

import { verifyMeshFile } from './mesh';
import { AttachmentError, type DecryptInput } from './stream';

export interface MeshChunkStorage {
  put(transferId: string, index: number, data: Uint8Array): Promise<void>;
  get(transferId: string, index: number): Promise<Uint8Array | undefined>;
  /** What is held, after a restart: the chunk count and the indices per transfer. */
  load(): Promise<{ transferId: string; count: number; indices: number[] }[]>;
  /** Records a transfer's chunk count (from its first chunk). */
  begin(transferId: string, count: number): Promise<void>;
  remove(transferId: string): Promise<void>;
}

export type MeshFileInput = DecryptInput & { chunkHashListSha256: Uint8Array };

export interface MeshReceiverHooks {
  /** The whole file checked out: store it (`read` yields its ciphertext chunks in order). */
  verified(transferId: string, read: () => AsyncIterable<Uint8Array>): Promise<void>;
  /** The assembled file failed its check; its chunks were dropped. */
  failed?(transferId: string): void;
  /** Progress changed (for the UI), on every chunk. */
  changed?(transferId: string): void;
  /**
   * Complete, failed, cancelled, paused or resumed, after the state is recorded: tell linked
   * peers (`MeshRelay.transfersChanged`) so holders resume, stop or drop chunks.
   */
  settled?(transferId: string): void;
}

export interface MeshReceiveStatus {
  count: number;
  held: number;
  complete: boolean;
  paused: boolean;
}

interface Transfer {
  count: number;
  held: Set<number>;
  input: MeshFileInput | undefined;
  paused: boolean;
  finishing: boolean;
}

/** Transfers whose manifest has not arrived yet, kept at most (chunks can overtake it). */
const MAX_UNKNOWN = 16;
/** Complete transfers still announced, so holders drop their chunks. */
const MAX_COMPLETE = 32;

export class MeshFileReceiver {
  readonly #transfers = new Map<string, Transfer>();
  readonly #complete: string[] = [];
  readonly #cancelled = new Set<string>();
  readonly #expected = new Map<string, MeshFileInput>();

  constructor(
    private readonly provider: CryptoProvider,
    private readonly storage: MeshChunkStorage,
    private readonly hooks: MeshReceiverHooks,
  ) {}

  async load(): Promise<void> {
    for (const t of await this.storage.load()) {
      this.#transfers.set(t.transferId, {
        count: t.count,
        held: new Set(t.indices),
        input: this.#expected.get(t.transferId),
        paused: false,
        finishing: false,
      });
    }
    for (const id of this.#transfers.keys()) void this.#maybeFinish(id);
  }

  /** The manifest arrived: the file can be checked once all chunks are here. */
  expect(transferId: string, input: MeshFileInput): void {
    if (this.#complete.includes(transferId)) return;
    this.#expected.set(transferId, input);
    const transfer = this.#transfers.get(transferId);
    if (transfer) {
      transfer.input = input;
      void this.#maybeFinish(transferId);
    }
  }

  status(transferId: string): MeshReceiveStatus | undefined {
    if (this.#complete.includes(transferId)) {
      return { count: 0, held: 0, complete: true, paused: false };
    }
    const t = this.#transfers.get(transferId);
    if (!t) return undefined;
    return { count: t.count, held: t.held.size, complete: false, paused: t.paused };
  }

  pause(transferId: string): void {
    const t = this.#transfers.get(transferId);
    if (t) t.paused = true;
    else this.#transfers.set(transferId, this.#new(0, transferId, true));
    this.hooks.changed?.(transferId);
    this.hooks.settled?.(transferId);
  }

  resume(transferId: string): void {
    const t = this.#transfers.get(transferId);
    if (t) t.paused = false;
    this.hooks.changed?.(transferId);
    this.hooks.settled?.(transferId);
  }

  /** Stops receiving it and drops what arrived; later chunks are refused. */
  async cancel(transferId: string): Promise<void> {
    this.#cancelled.add(transferId);
    this.#transfers.delete(transferId);
    await this.storage.remove(transferId);
    this.hooks.changed?.(transferId);
    this.hooks.settled?.(transferId);
  }

  // MeshFileSink

  progress(): { transferId: string; have: Uint8Array; complete: boolean }[] {
    const out: { transferId: string; have: Uint8Array; complete: boolean }[] = [];
    for (const [transferId, t] of this.#transfers) {
      if (t.count === 0 || t.paused) continue;
      const have = new Uint8Array(Math.ceil(t.count / 8));
      for (const i of t.held) have[i >> 3]! |= 1 << (i & 7);
      out.push({ transferId, have, complete: false });
    }
    for (const transferId of [...this.#complete].reverse()) {
      out.push({ transferId, have: new Uint8Array(0), complete: true });
    }
    return out;
  }

  accepts(transferId: string): boolean {
    if (this.#cancelled.has(transferId) || this.#complete.includes(transferId)) return false;
    const t = this.#transfers.get(transferId);
    if (t) return !t.paused;
    // A new transfer: only so many before their manifests arrive.
    const unknown = [...this.#transfers.values()].filter((x) => !x.input).length;
    return this.#expected.has(transferId) || unknown < MAX_UNKNOWN;
  }

  chunk(
    chunk: { transferId: string; index: number; count: number; data: Uint8Array },
    ack: () => void,
  ): void {
    void this.#store(chunk).then(
      (stored) => {
        if (stored) ack();
      },
      () => undefined, // not stored: no ack, the holder offers it again later
    );
  }

  async #store(chunk: {
    transferId: string;
    index: number;
    count: number;
    data: Uint8Array;
  }): Promise<boolean> {
    const { transferId, index, count } = chunk;
    if (!this.accepts(transferId)) return false;
    let t = this.#transfers.get(transferId);
    if (!t || t.count === 0) {
      const paused = t?.paused ?? false;
      t = this.#new(count, transferId, paused);
      this.#transfers.set(transferId, t);
      await this.storage.begin(transferId, count);
    }
    if (count !== t.count || index >= t.count) return false;
    if (t.held.has(index)) return true;
    await this.storage.put(transferId, index, chunk.data);
    t.held.add(index);
    this.hooks.changed?.(transferId);
    void this.#maybeFinish(transferId);
    return true;
  }

  #new(count: number, transferId: string, paused: boolean): Transfer {
    return {
      count,
      held: new Set(),
      input: this.#expected.get(transferId),
      paused,
      finishing: false,
    };
  }

  async #maybeFinish(transferId: string): Promise<void> {
    const t = this.#transfers.get(transferId);
    if (!t || t.finishing || !t.input || t.count === 0 || t.held.size < t.count) return;
    t.finishing = true;
    const read = async function* (this: MeshFileReceiver) {
      for (let i = 0; i < t.count; i++) {
        const data = await this.storage.get(transferId, i);
        if (!data) throw new AttachmentError('integrity', 'a chunk went missing');
        yield data;
      }
    }.bind(this);
    try {
      const hashes: Uint8Array[] = [];
      for await (const data of read()) hashes.push(this.provider.sha256(data));
      await verifyMeshFile(this.provider, t.input, hashes, read());
    } catch {
      // Something is wrong with what arrived: start over; the sender still has every chunk.
      this.#transfers.delete(transferId);
      await this.storage.remove(transferId).catch(() => undefined);
      this.hooks.failed?.(transferId);
      this.hooks.changed?.(transferId);
      this.hooks.settled?.(transferId);
      return;
    }
    await this.hooks.verified(transferId, read);
    this.#transfers.delete(transferId);
    this.#complete.push(transferId);
    if (this.#complete.length > MAX_COMPLETE) this.#complete.shift();
    await this.storage.remove(transferId).catch(() => undefined);
    this.hooks.changed?.(transferId);
    this.hooks.settled?.(transferId);
  }
}

/** Chunks in memory (tests, the simulation). */
export class MemoryChunkStorage implements MeshChunkStorage {
  readonly chunks = new Map<string, Map<number, Uint8Array>>();
  readonly counts = new Map<string, number>();

  put(transferId: string, index: number, data: Uint8Array): Promise<void> {
    let map = this.chunks.get(transferId);
    if (!map) {
      map = new Map();
      this.chunks.set(transferId, map);
    }
    map.set(index, data);
    return Promise.resolve();
  }

  get(transferId: string, index: number): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.chunks.get(transferId)?.get(index));
  }

  load(): Promise<{ transferId: string; count: number; indices: number[] }[]> {
    return Promise.resolve(
      [...this.counts].map(([transferId, count]) => ({
        transferId,
        count,
        indices: [...(this.chunks.get(transferId)?.keys() ?? [])],
      })),
    );
  }

  begin(transferId: string, count: number): Promise<void> {
    this.counts.set(transferId, count);
    return Promise.resolve();
  }

  remove(transferId: string): Promise<void> {
    this.chunks.delete(transferId);
    this.counts.delete(transferId);
    return Promise.resolve();
  }
}
