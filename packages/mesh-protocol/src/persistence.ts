/**
 * Where a relay keeps other people's packets and the seen IDs (REQ §14.1, §14.3). The app
 * stores them apart from chat history, so clearing the relay cache never touches messages.
 * Android: SQLite tables `mesh_relay_packets` and `seen_mesh_packets`; tests: in memory.
 */
import type { SeenEntry } from './seen';

/** One stored packet, without its payload (the index the relay keeps in memory). */
export interface RelayPacketMeta {
  /** Packet ID, hex. */
  id: string;
  /** Destination routing token, hex. */
  dst: string;
  /** Origin token, hex. */
  origin: string;
  createdAt: number;
  expiresAt: number;
  /** Hops left for the next relay (already decremented for this hop). */
  hopBudget: number;
  /** Copies this device holds (binary spray-and-wait). */
  copies: number;
  flags: number;
  /** Payload bytes. */
  size: number;
  receivedAt: number;
  /** What it carries: an envelope (Phase 23; the default) or a file chunk (ADR 0027). */
  kind?: 'envelope' | 'chunk';
  /** Chunks: the transfer (attachment) ID, hex, and the chunk index. */
  transfer?: string;
  index?: number;
}

export interface MeshPersistence {
  loadPackets(): Promise<RelayPacketMeta[]>;
  readPayload(id: string): Promise<Uint8Array | undefined>;
  putPacket(meta: RelayPacketMeta, payload: Uint8Array): Promise<void>;
  /** Copies changed. */
  updatePacket(meta: RelayPacketMeta): Promise<void>;
  deletePackets(ids: readonly string[]): Promise<void>;
  clearPackets(): Promise<void>;
  loadSeen(): Promise<SeenEntry[]>;
  saveSeen(add: readonly SeenEntry[], remove: readonly string[]): Promise<void>;
}

/** Keeps everything in memory (tests, the simulation). */
export class MemoryMeshPersistence implements MeshPersistence {
  readonly packets = new Map<string, { meta: RelayPacketMeta; payload: Uint8Array }>();
  readonly seen = new Map<string, SeenEntry>();

  loadPackets(): Promise<RelayPacketMeta[]> {
    return Promise.resolve([...this.packets.values()].map((entry) => ({ ...entry.meta })));
  }

  readPayload(id: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.packets.get(id)?.payload);
  }

  putPacket(meta: RelayPacketMeta, payload: Uint8Array): Promise<void> {
    this.packets.set(meta.id, { meta: { ...meta }, payload });
    return Promise.resolve();
  }

  updatePacket(meta: RelayPacketMeta): Promise<void> {
    const entry = this.packets.get(meta.id);
    if (entry) entry.meta = { ...meta };
    return Promise.resolve();
  }

  deletePackets(ids: readonly string[]): Promise<void> {
    for (const id of ids) this.packets.delete(id);
    return Promise.resolve();
  }

  clearPackets(): Promise<void> {
    this.packets.clear();
    return Promise.resolve();
  }

  loadSeen(): Promise<SeenEntry[]> {
    return Promise.resolve([...this.seen.values()]);
  }

  saveSeen(add: readonly SeenEntry[], remove: readonly string[]): Promise<void> {
    for (const id of remove) this.seen.delete(id);
    for (const entry of add) this.seen.set(entry.id, entry);
    return Promise.resolve();
  }
}
