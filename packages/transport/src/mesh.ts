/**
 * The mesh store-and-forward relay (REQ §11.1 mode 2, §11.3, §11.4; ADR 0025). It runs on the
 * links `NearbyPeerTransport` has proved, and carries E2EE envelopes between phones that are
 * never in range of each other.
 *
 * - **Packets.** An own envelope for a device out of range becomes a `MESH_ENVELOPE` packet:
 *   the same ciphertext without the device IDs, addressed to the recipient's routing token for
 *   that day, with the sender's token, a hop budget, spray copies and the sender's Ed25519
 *   signature over everything relays must not change. Its packet ID is the inner packet's, so
 *   rebuilding it (after a restart) gives the same bytes.
 * - **Summaries.** Once a link is proved, each side sends `MeshSummary`: its own routing tokens
 *   (so a holder knows it met the recipient) and packet IDs it knows were delivered.
 * - **Forwarding (binary spray-and-wait).** A holder with n > 1 copies hands floor(n/2) to a
 *   relay-capable peer that has not had the packet, and keeps the rest; with one copy it only
 *   waits for the recipient. Every relay decrements the hop budget; at 0 it delivers only.
 * - **Answers.** Every offered packet gets a signed `MeshAck` (ACCEPTED, DELIVERED, DUPLICATE
 *   or REFUSED) bound to the link token. ACCEPTED for an own packet means "relayed" (REQ §8.3).
 * - **Recipient.** Resolves the origin token among its cached directories, checks the
 *   signature, rebuilds the Envelope and hands it to the engine like any other packet. A
 *   changed byte fails the check: the packet is refused, never opened.
 * - **Own copies.** The sender keeps its packet until the engine withdraws it (receipt, or sent
 *   another way). Delivered-ID lists are not authenticated, so they never remove an own copy.
 */
import {
  checkMeshChunkPacket,
  checkMeshPacket,
  ChunkBitmap,
  fromHex,
  meshPolicy,
  RateLimiter,
  RelayStore,
  SeenCache,
  splitCopies,
  toHex,
  type MeshPersistence,
  type MeshPolicy,
  type RelayPacketMeta,
  type RelayUsage,
} from '@pingdost/mesh-protocol';
import {
  bytesToUuid,
  create,
  decodeEnvelope,
  decodeMeshAck,
  decodeMeshSummary,
  encodeEnvelope,
  encodeMeshAck,
  encodeMeshChunk,
  encodeMeshEnvelope,
  encodeMeshSummary,
  encodeTransportPacket,
  fromBase64,
  fromMeshEnvelope,
  HelloCapability,
  MAX_MESH_SUMMARY_DELIVERED,
  MAX_MESH_SUMMARY_TRANSFERS,
  MeshAckSchema,
  MeshAckStatus,
  MeshChunkRefSchema,
  MeshChunkSchema,
  MeshSummarySchema,
  meshAckMessage,
  meshChunkDigest,
  meshChunkMessage,
  meshChunkPacketId,
  meshDay,
  meshEnvelopeMessage,
  meshRoutingToken,
  meshRoutingTokens,
  PacketKind,
  PROTOCOL_VERSION,
  ProtocolError,
  toBase64,
  toMeshEnvelope,
  TransportPacketSchema,
  UUID_BYTES,
  uuidToBytes,
  uuidv7Bytes,
  type CodecOptions,
  type MeshChunk,
  type MeshEnvelope,
  type TransportPacket,
} from '@pingdost/protocol';

import { Listeners, ValueStream, type ReadonlyValueStream } from './stream';
import type { RelayedEvent, SendResult, Unsubscribe } from './types';

/** A cached directory device, found by its routing token. */
export interface MeshOrigin {
  deviceId: string;
  /** Its Ed25519 identity key, unpadded base64. */
  ed25519: string;
}

/** What the relay needs from this device's identity (the engine's `createNearbyIdentity`). */
export interface MeshIdentity {
  readonly deviceId: string;
  sign(message: Uint8Array): string;
  verify(identityKey: string, message: Uint8Array, signature: string): boolean;
  /** The verified directory device whose routing token for `day` is `token`. */
  resolveOrigin(token: Uint8Array, day: number): Promise<MeshOrigin | undefined>;
}

export interface MeshRelayOptions {
  persistence: MeshPersistence;
  policy?: Partial<MeshPolicy>;
  /** Relay for others from the start (the app's toggle and its battery/storage policy). */
  relaying?: boolean;
  /** Receives file chunks addressed to this device (ADR 0027); without it they are refused. */
  files?: MeshFileSink;
}

/** A file this device sends over the mesh (ADR 0027): its STREAM ciphertext, chunk by chunk. */
export interface MeshFileOffer {
  /** The attachment ID. */
  transferId: string;
  recipientDeviceId: string;
  /** Ciphertext chunks (`AttachmentManifest.chunk_count`). */
  count: number;
  createdAt: number;
  expiresAt: number;
  /** Reads ciphertext chunk `index` from the local copy. */
  read(index: number): Promise<Uint8Array>;
}

/** A chunk for this device whose sender's signature and hash checked out. */
export interface MeshFileChunk {
  transferId: string;
  index: number;
  count: number;
  data: Uint8Array;
  senderDeviceId: string;
}

/** The receiving side of mesh file transfers (the app's assembler). */
export interface MeshFileSink {
  /** Transfers to this device: chunks held (bitmap, `ChunkBitmap` layout) or complete. */
  progress(): { transferId: string; have: Uint8Array; complete: boolean }[];
  /** False to refuse chunks of this transfer now (paused or cancelled). */
  accepts?(transferId: string): boolean;
  /** Store the chunk durably, then call `ack`. */
  chunk(chunk: MeshFileChunk, ack: () => void): void;
}

/** How far an own file got: chunks the recipient took, and relays that took any. */
export interface MeshFileProgress {
  transferId: string;
  recipientDeviceId: string;
  count: number;
  /** Chunks the recipient's device stored (from this phone, or as its summary says). */
  delivered: number;
  /** Distinct relays that accepted chunks of it from this phone. */
  relays: number;
}

/** One proved link, as the relay sees it. */
export interface MeshLink {
  id: number;
  /** Our Hello token on this link: the peer signs its answers to us over it. */
  ownToken: Uint8Array;
  /** The peer's Hello token: we sign our answers over it. */
  peerToken: Uint8Array;
  /** The Ed25519 key the peer proved. */
  peerKey: string;
  /** Its Hello capability bits. */
  capabilities: number;
  /** Set when the peer is a known contact device (the direct path reaches it). */
  peerDeviceId: string | null;
}

export interface MeshStatus {
  /** Taking and passing on other people's packets now. */
  relaying: boolean;
  /** Other people's packets held. */
  stored: RelayUsage;
  /** Own packets waiting in the mesh. */
  own: number;
  /** Packets taken for others since start. */
  carried: number;
  /** Packets handed to their recipient since start. */
  handedOver: number;
  /** Own files being sent over the mesh. */
  files: number;
}

export interface MeshHost {
  identity: MeshIdentity;
  now: () => number;
  envelopeMaxBytes?: number;
  sendBytes(linkId: number, bytes: Uint8Array): Promise<void>;
  /** Hands an envelope for this device to the engine; `ack` once it is stored. */
  deliver(packet: TransportPacket, ack: () => void): void;
  /** Relaying went on or off: peers on existing links have to hear of it. */
  relayingChanged?(): void;
  log?: (message: string, fields?: Record<string, string | number | boolean>) => void;
}

interface OwnEntry {
  meta: RelayPacketMeta;
  payload: Uint8Array;
  envelopeId: string;
  dstDevice: string;
  /** Peer keys that had it (accepted or already seen). */
  given: Set<string>;
  /** Peer keys that accepted it from this device. */
  relays: Set<string>;
}

interface OwnFile {
  offer: MeshFileOffer;
  transfer: Uint8Array;
  /** Hex of the transfer ID. */
  transferHex: string;
  dst: Uint8Array;
  origin: Uint8Array;
  expiresAt: number;
  /** Spray copies left per chunk. */
  copies: number[];
  /** Per chunk: peer keys that have it. */
  given: Set<string>[];
  /** Chunks the recipient holds. */
  delivered: ChunkBitmap;
  relays: Set<string>;
}

interface LinkMesh {
  link: MeshLink;
  /** The peer's routing tokens (hex), once its summary arrived. */
  tokens: Set<string> | null;
  /** The peer's own incoming transfers (hex ID → held chunks), from its summary. */
  transfers: Map<string, { have: Uint8Array; complete: boolean }>;
  /** Packet IDs offered on this link already. */
  offered: Set<string>;
  pending: Map<string, (status: MeshAckStatus | 'timeout') => void>;
  pumping: boolean;
  again: boolean;
  lastSummaryAt: number;
}

type Offer =
  | { kind: 'own'; entry: OwnEntry }
  | { kind: 'ownChunk'; file: OwnFile; index: number; deliver: boolean }
  | { kind: 'deliver'; meta: RelayPacketMeta }
  | { kind: 'spray'; meta: RelayPacketMeta };

/** Bit i of a `MeshTransferState.have` bitmap. */
const holds = (have: Uint8Array | undefined, index: number) =>
  have !== undefined && (((have[index >> 3] ?? 0) >> (index & 7)) & 1) === 1;
/** Complete transfers remembered and passed on, so holders drop their chunks. */
const COMPLETE_MAX = 64;

const HELD: SendResult = { ok: true, status: 'held', via: 'mesh' };
const unpadded = (bytes: Uint8Array) => toBase64(bytes).replace(/=+$/, '');
/** Summaries to one link at most this often, besides the first. */
const SUMMARY_INTERVAL_MS = 10_000;
/** A transfer change goes out this soon after the link's last summary (peers allow 3 in a row). */
const TRANSFER_SUMMARY_GAP_MS = 2_000;
const PRUNE_INTERVAL_MS = 60_000;

export class MeshRelay {
  readonly #policy: MeshPolicy;
  readonly #persistence: MeshPersistence;
  readonly #store: RelayStore;
  readonly #seen: SeenCache;
  readonly #own = new Map<string, OwnEntry>();
  readonly #ownByEnvelope = new Map<string, string>();
  readonly #links = new Map<number, LinkMesh>();
  /** Stored packets: who gave each one, and who had it from us (memory only). */
  readonly #fromPeer = new Map<string, string>();
  readonly #given = new Map<string, Set<string>>();
  readonly #delivered: string[] = [];
  readonly #create: RateLimiter;
  readonly #perPeer: RateLimiter;
  readonly #perOrigin: RateLimiter;
  readonly #summaries: RateLimiter;
  readonly #chunks: RateLimiter;
  readonly #relayed = new Listeners<[RelayedEvent]>();
  readonly #fileProgress = new Listeners<[MeshFileProgress]>();
  readonly #status: ValueStream<MeshStatus>;
  /** Own files over the mesh, by transfer and recipient device. */
  readonly #ownFiles = new Map<string, OwnFile>();
  /** Transfers known complete (hex): holders drop their chunks, and pass it on. */
  readonly #complete: string[] = [];
  readonly #sink: MeshFileSink | undefined;
  #relaying: boolean;
  #started: Promise<void> | undefined;
  #carried = 0;
  #handedOver = 0;
  #tokens: { day: number; hex: Set<string>; bytes: Uint8Array[] } | undefined;
  #summaryTimer: ReturnType<typeof setTimeout> | undefined;
  #transfersTimer: ReturnType<typeof setTimeout> | undefined;
  #pruneTimer: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(
    private readonly host: MeshHost,
    options: MeshRelayOptions,
  ) {
    this.#policy = meshPolicy(options.policy);
    this.#store = new RelayStore(options.persistence, this.#policy);
    this.#seen = new SeenCache(this.#policy.seenCacheMax);
    this.#relaying = options.relaying ?? false;
    const { rates } = this.#policy;
    this.#create = new RateLimiter(rates.create);
    this.#perPeer = new RateLimiter(rates.relayPerPeer);
    this.#perOrigin = new RateLimiter(rates.relayPerOrigin);
    this.#summaries = new RateLimiter(rates.summaryPerPeer);
    this.#chunks = new RateLimiter(rates.chunkPerPeer);
    this.#sink = options.files;
    this.#status = new ValueStream<MeshStatus>(this.#snapshot());
    this.#persistence = options.persistence;
  }

  // Files (ADR 0027)

  /**
   * Sends a file's ciphertext over the mesh, chunk by chunk: straight to the recipient's
   * device when it is linked, and as spray copies to relays. Kept until `withdrawFile`.
   */
  sendFile(offer: MeshFileOffer): void {
    const key = `${offer.transferId}/${offer.recipientDeviceId}`;
    if (this.#ownFiles.has(key)) return;
    const day = meshDay(offer.createdAt);
    const transfer = uuidToBytes(offer.transferId);
    this.#ownFiles.set(key, {
      offer,
      transfer,
      transferHex: toHex(transfer),
      dst: meshRoutingToken(offer.recipientDeviceId, day),
      origin: meshRoutingToken(this.host.identity.deviceId, day),
      expiresAt: Math.min(offer.expiresAt, offer.createdAt + this.#policy.ttlMs),
      copies: Array.from({ length: offer.count }, () => this.#policy.chunkCopies),
      given: Array.from({ length: offer.count }, () => new Set<string>()),
      delivered: new ChunkBitmap(offer.count),
      relays: new Set(),
    });
    this.host.log?.('mesh file queued', { chunks: offer.count });
    this.#changed();
    this.#pumpAll();
  }

  /** Stops sending a file (delivered, cancelled or paused): its chunks are no longer offered. */
  withdrawFile(transferId: string): void {
    let changed = false;
    for (const [key, file] of this.#ownFiles) {
      if (file.offer.transferId !== transferId) continue;
      this.#ownFiles.delete(key);
      changed = true;
    }
    if (changed) this.#changed();
  }

  fileProgress(transferId: string): MeshFileProgress[] {
    return [...this.#ownFiles.values()]
      .filter((file) => file.offer.transferId === transferId)
      .map((file) => this.#progressOf(file));
  }

  onFileProgress(listener: (progress: MeshFileProgress) => void): Unsubscribe {
    return this.#fileProgress.add(listener);
  }

  /**
   * The sink's transfers changed (a file completed, or was paused or cancelled): tell linked
   * peers now, so holders stop sending and drop chunks of finished files. A link that had a
   * summary in the last 2 s gets it with the next scheduled round.
   */
  transfersChanged(): void {
    clearTimeout(this.#transfersTimer);
    this.#transfersTimer = undefined;
    const now = this.host.now();
    let wait = 0;
    for (const state of this.#links.values()) {
      const since = now - state.lastSummaryAt;
      if (since >= TRANSFER_SUMMARY_GAP_MS) this.#sendSummary(state);
      else wait = Math.max(wait, TRANSFER_SUMMARY_GAP_MS - since);
    }
    if (wait > 0 && !this.#disposed) {
      this.#transfersTimer = setTimeout(() => this.transfersChanged(), wait);
    }
  }

  #progressOf(file: OwnFile): MeshFileProgress {
    return {
      transferId: file.offer.transferId,
      recipientDeviceId: file.offer.recipientDeviceId,
      count: file.offer.count,
      delivered: file.delivered.held,
      relays: file.relays.size,
    };
  }

  get status$(): ReadonlyValueStream<MeshStatus> {
    return this.#status;
  }

  get relaying(): boolean {
    return this.#relaying;
  }

  /** Loads the relay store and the seen IDs (once). */
  start(): Promise<void> {
    this.#started ??= (async () => {
      const now = this.host.now();
      await this.#store.load(now);
      this.#seen.load(await this.#persistence.loadSeen(), now);
      this.#pruneTimer ??= setInterval(() => void this.#prune(), PRUNE_INTERVAL_MS);
      this.#changed();
    })();
    return this.#started;
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#pruneTimer);
    clearTimeout(this.#summaryTimer);
    clearTimeout(this.#transfersTimer);
    for (const id of [...this.#links.keys()]) this.linkDown(id);
  }

  onRelayed(listener: (event: RelayedEvent) => void): Unsubscribe {
    return this.#relayed.add(listener);
  }

  /**
   * The user's toggle with the app's battery and storage policy. Off: nothing more is taken
   * for others and nothing held is passed on, at once. Own packets are not affected.
   */
  setRelaying(on: boolean): void {
    if (this.#relaying === on) return;
    this.#relaying = on;
    this.host.log?.(on ? 'mesh relaying on' : 'mesh relaying off');
    this.#changed();
    this.host.relayingChanged?.();
    if (on) this.#pumpAll();
  }

  /** "Clear relay cache": other people's packets go; own packets and chats stay. */
  async clear(): Promise<void> {
    await this.#store.clear();
    this.#fromPeer.clear();
    this.#given.clear();
    this.#changed();
  }

  // Own packets

  /** Takes an own envelope for a device out of range; the mesh holds it from now on. */
  async send(packet: TransportPacket): Promise<SendResult> {
    await this.start();
    if (packet.kind !== PacketKind.ENVELOPE || packet.dst.length !== UUID_BYTES) {
      return { ok: false, code: 'INVALID', retryable: false };
    }
    let envelope;
    try {
      envelope = decodeEnvelope(packet.payload, this.#codec());
    } catch {
      return { ok: false, code: 'INVALID', retryable: false };
    }
    const envelopeId = bytesToUuid(envelope.envelopeId);
    if (this.#ownByEnvelope.has(envelopeId)) return HELD;
    const now = this.host.now();
    if (!this.#create.take('own', now)) return { ok: false, code: 'RATE_LIMITED', retryable: true };
    const created = Number(packet.createdAtMs);
    const expires = Math.min(Number(packet.expiresAtMs), created + this.#policy.ttlMs);
    if (expires <= now) return { ok: false, code: 'ENVELOPE_EXPIRED', retryable: false };
    const day = meshDay(created);
    const dst = meshRoutingToken(packet.dst, day);
    const mesh = toMeshEnvelope(envelope, meshRoutingToken(this.host.identity.deviceId, day));
    mesh.signature = fromBase64(
      this.host.identity.sign(
        meshEnvelopeMessage({
          ...this.#statement(mesh),
          packetId: packet.packetId,
          createdAtMs: BigInt(created),
          expiresAtMs: BigInt(expires),
          dst,
        }),
      ),
    );
    let payload: Uint8Array;
    try {
      payload = encodeMeshEnvelope(mesh, this.#codec());
    } catch {
      return { ok: false, code: 'INVALID', retryable: false };
    }
    const meta: RelayPacketMeta = {
      id: toHex(packet.packetId),
      dst: toHex(dst),
      origin: toHex(mesh.originToken),
      createdAt: created,
      expiresAt: expires,
      hopBudget: this.#policy.maxHops,
      copies: this.#policy.sprayCopies,
      flags: packet.flags,
      size: payload.length,
      receivedAt: now,
    };
    this.#own.set(meta.id, {
      meta,
      payload,
      envelopeId,
      dstDevice: bytesToUuid(packet.dst),
      given: new Set(),
      relays: new Set(),
    });
    this.#ownByEnvelope.set(envelopeId, meta.id);
    this.#seen.add(meta.id, expires); // our own packet coming back is a duplicate
    this.host.log?.('mesh packet queued');
    this.#changed();
    this.#pumpAll();
    return HELD;
  }

  /** The engine is done with these envelopes (receipt, or sent another way): drop own copies. */
  withdraw(envelopeIds: readonly string[]): void {
    let changed = false;
    for (const envelopeId of envelopeIds) {
      const id = this.#ownByEnvelope.get(envelopeId);
      if (id === undefined) continue;
      this.#ownByEnvelope.delete(envelopeId);
      this.#own.delete(id);
      changed = true;
    }
    if (changed) this.#changed();
  }

  // Links

  linkReady(link: MeshLink): void {
    if (this.#disposed) return;
    this.linkDown(link.id);
    const state: LinkMesh = {
      link,
      tokens: null,
      transfers: new Map(),
      offered: new Set(),
      pending: new Map(),
      pumping: false,
      again: false,
      lastSummaryAt: 0,
    };
    this.#links.set(link.id, state);
    void this.start().then(() => this.#sendSummary(state));
  }

  /** The peer signed new capabilities on a link that is up: it turned relaying on or off. */
  linkCapabilities(id: number, capabilities: number): void {
    const state = this.#links.get(id);
    if (!state || state.link.capabilities === capabilities) return;
    state.link = { ...state.link, capabilities };
    void this.#pump(state);
  }

  linkDown(id: number): void {
    const state = this.#links.get(id);
    if (!state) return;
    this.#links.delete(id);
    for (const resolve of [...state.pending.values()]) resolve('timeout');
  }

  onPacket(linkId: number, packet: TransportPacket): void {
    const state = this.#links.get(linkId);
    if (!state) return;
    void this.start().then(async () => {
      switch (packet.kind) {
        case PacketKind.MESH_ENVELOPE:
          await this.#onEnvelope(state, packet);
          break;
        case PacketKind.MESH_CHUNK:
          await this.#onChunk(state, packet);
          break;
        case PacketKind.MESH_ACK:
          this.#onAck(state, packet.payload);
          break;
        case PacketKind.MESH_SUMMARY:
          await this.#onSummary(state, packet.payload);
          break;
        default:
          break;
      }
    });
  }

  // Incoming

  async #onEnvelope(state: LinkMesh, packet: TransportPacket): Promise<void> {
    const now = this.host.now();
    const { link } = state;
    if (!this.#perPeer.take(link.peerKey, now)) {
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    const check = checkMeshPacket(packet, this.#policy, now, this.host.envelopeMaxBytes);
    if (!check.ok) {
      this.host.log?.('mesh packet rejected', { reason: check.reason });
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    const id = toHex(packet.packetId);
    const dst = toHex(packet.dst);
    if (this.#ownTokens(now).hex.has(dst)) {
      await this.#receive(state, packet, check.envelope, id);
      return;
    }
    if (!this.#relaying) {
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    if (this.#seen.has(id, now) || this.#store.has(id) || this.#own.has(id)) {
      this.#answer(state, packet.packetId, MeshAckStatus.DUPLICATE);
      return;
    }
    const origin = toHex(check.envelope.originToken);
    if (packet.hopBudget < 1 || !this.#perOrigin.take(origin, now)) {
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    const result = await this.#store.put(
      {
        id,
        dst,
        origin,
        createdAt: Number(packet.createdAtMs),
        expiresAt: Number(packet.expiresAtMs),
        hopBudget: packet.hopBudget - 1,
        copies: packet.copies,
        flags: packet.flags,
        size: packet.payload.length,
        receivedAt: now,
      },
      packet.payload,
      now,
    );
    if (result === 'duplicate') {
      this.#answer(state, packet.packetId, MeshAckStatus.DUPLICATE);
      return;
    }
    if (result !== 'stored') {
      this.host.log?.('mesh packet not stored', { reason: result });
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    await this.#remember(id, Number(packet.expiresAtMs));
    this.#fromPeer.set(id, link.peerKey);
    this.#given.set(id, new Set([link.peerKey]));
    this.#carried++;
    this.#answer(state, packet.packetId, MeshAckStatus.ACCEPTED);
    this.host.log?.('mesh packet carried', { hops: packet.hopBudget - 1 });
    this.#changed();
    this.#pumpAll();
  }

  /** A file chunk (ADR 0027): for this device to the sink; for others into the relay store. */
  async #onChunk(state: LinkMesh, packet: TransportPacket): Promise<void> {
    const now = this.host.now();
    const { link } = state;
    if (!this.#chunks.take(link.peerKey, now)) {
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    const check = checkMeshChunkPacket(packet, this.#policy, now);
    if (!check.ok) {
      this.host.log?.('mesh chunk rejected', { reason: check.reason });
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    const { chunk } = check;
    const ref = chunk.ref!;
    const id = toHex(packet.packetId);
    const dst = toHex(packet.dst);
    const transferHex = toHex(ref.transferId);
    if (this.#ownTokens(now).hex.has(dst)) {
      await this.#receiveChunk(state, packet, chunk, id);
      return;
    }
    if (!this.#relaying) {
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    if (this.#seen.has(id, now) || this.#store.has(id) || this.#complete.includes(transferHex)) {
      this.#answer(state, packet.packetId, MeshAckStatus.DUPLICATE);
      return;
    }
    if (packet.hopBudget < 1) {
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    const result = await this.#store.put(
      {
        id,
        dst,
        origin: toHex(chunk.originToken),
        createdAt: Number(packet.createdAtMs),
        expiresAt: Number(packet.expiresAtMs),
        hopBudget: packet.hopBudget - 1,
        copies: packet.copies,
        flags: packet.flags,
        size: packet.payload.length,
        receivedAt: now,
        kind: 'chunk',
        transfer: transferHex,
        index: ref.index,
      },
      packet.payload,
      now,
    );
    if (result === 'duplicate') {
      this.#answer(state, packet.packetId, MeshAckStatus.DUPLICATE);
      return;
    }
    if (result !== 'stored') {
      this.host.log?.('mesh chunk not stored', { reason: result });
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    await this.#remember(id, Number(packet.expiresAtMs));
    this.#fromPeer.set(id, link.peerKey);
    this.#given.set(id, new Set([link.peerKey]));
    this.#carried++;
    this.#answer(state, packet.packetId, MeshAckStatus.ACCEPTED);
    this.#changed();
    this.#pumpAll();
  }

  /** A chunk for this device: the sender's signature, then the sink stores it. */
  async #receiveChunk(
    state: LinkMesh,
    packet: TransportPacket,
    chunk: MeshChunk,
    id: string,
  ): Promise<void> {
    const ref = chunk.ref!;
    const transferId = bytesToUuid(ref.transferId);
    const sink = this.#sink;
    if (!sink || sink.accepts?.(transferId) === false) {
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    if (this.#seen.has(id, this.host.now())) {
      this.#answer(state, packet.packetId, MeshAckStatus.DELIVERED);
      return;
    }
    const { identity } = this.host;
    const origin = await identity.resolveOrigin(chunk.originToken, meshDay(packet.createdAtMs));
    const valid =
      origin !== undefined &&
      identity.verify(
        origin.ed25519,
        meshChunkMessage({
          packetId: packet.packetId,
          createdAtMs: packet.createdAtMs,
          expiresAtMs: packet.expiresAtMs,
          dst: packet.dst,
          originToken: chunk.originToken,
          transferId: ref.transferId,
          index: ref.index,
          count: ref.count,
          chunkSha256: ref.chunkSha256,
        }),
        unpadded(chunk.signature),
      );
    if (!origin || !valid) {
      this.host.log?.(origin ? 'mesh chunk failed its check' : 'mesh chunk from an unknown sender');
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    let acked = false;
    sink.chunk(
      {
        transferId,
        index: ref.index,
        count: ref.count,
        data: chunk.data,
        senderDeviceId: origin.deviceId,
      },
      () => {
        if (acked) return;
        acked = true;
        void this.#remember(id, Number(packet.expiresAtMs)).then(() =>
          this.#answer(state, packet.packetId, MeshAckStatus.DELIVERED),
        );
      },
    );
  }

  /** A packet for this device: check who sent it and that nothing changed, then open it. */
  async #receive(
    state: LinkMesh,
    packet: TransportPacket,
    mesh: MeshEnvelope,
    id: string,
  ): Promise<void> {
    const { identity } = this.host;
    if (this.#seen.has(id, this.host.now())) {
      this.#answer(state, packet.packetId, MeshAckStatus.DELIVERED);
      return;
    }
    const origin = await identity.resolveOrigin(mesh.originToken, meshDay(packet.createdAtMs));
    const valid =
      origin !== undefined &&
      identity.verify(
        origin.ed25519,
        meshEnvelopeMessage({
          ...this.#statement(mesh),
          packetId: packet.packetId,
          createdAtMs: packet.createdAtMs,
          expiresAtMs: packet.expiresAtMs,
          dst: packet.dst,
        }),
        unpadded(mesh.signature),
      );
    if (!origin || !valid) {
      // Not from a contact, or changed on the way: refused and never opened. Not marked seen,
      // so an intact copy can still arrive through another relay.
      this.host.log?.(
        origin ? 'mesh packet failed its check' : 'mesh packet from an unknown sender',
      );
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    const self = uuidToBytes(identity.deviceId);
    let inner: TransportPacket;
    try {
      inner = create(TransportPacketSchema, {
        version: PROTOCOL_VERSION,
        packetId: packet.packetId,
        kind: PacketKind.ENVELOPE,
        dst: self,
        createdAtMs: packet.createdAtMs,
        expiresAtMs: packet.expiresAtMs,
        hopBudget: 0,
        flags: packet.flags,
        payload: encodeEnvelope(
          fromMeshEnvelope(mesh, uuidToBytes(origin.deviceId), self),
          this.#codec(),
        ),
      });
    } catch {
      this.#answer(state, packet.packetId, MeshAckStatus.REFUSED);
      return;
    }
    let acked = false;
    this.host.deliver(inner, () => {
      if (acked) return;
      acked = true;
      void this.#remember(id, Number(packet.expiresAtMs)).then(() => {
        this.#markDelivered(id);
        this.#answer(state, packet.packetId, MeshAckStatus.DELIVERED);
      });
    });
  }

  #onAck(state: LinkMesh, payload: Uint8Array): void {
    let ack;
    try {
      ack = decodeMeshAck(payload);
    } catch {
      return;
    }
    const id = toHex(ack.packetId);
    const resolve = state.pending.get(id);
    if (!resolve) return;
    const { link } = state;
    if (
      !this.host.identity.verify(
        link.peerKey,
        meshAckMessage(link.ownToken, ack.packetId, ack.status),
        unpadded(ack.signature),
      )
    ) {
      this.host.log?.('mesh ack signature invalid');
      return;
    }
    resolve(ack.status);
  }

  async #onSummary(state: LinkMesh, payload: Uint8Array): Promise<void> {
    if (!this.#summaries.take(state.link.peerKey, this.host.now())) return;
    let summary;
    try {
      summary = decodeMeshSummary(payload);
    } catch {
      return;
    }
    state.tokens = new Set(summary.routingTokens.map(toHex));
    // Holders drop what was delivered. Never an own copy: these lists are not authenticated.
    const held = summary.delivered.map(toHex).filter((id) => this.#store.has(id));
    // Files (ADR 0027): which chunks the peer holds; complete ones need no chunk any more.
    state.transfers = new Map(
      summary.transfers.map((t) => [toHex(t.transferId), { have: t.have, complete: t.complete }]),
    );
    const done = [...state.transfers].filter(([, t]) => t.complete).map(([hex]) => hex);
    for (const meta of this.#store.all()) {
      if (meta.kind === 'chunk' && meta.transfer && done.includes(meta.transfer))
        held.push(meta.id);
    }
    for (const hex of done) {
      // Passed on only by holders, so a stranger cannot spread a made-up one far.
      if (held.length > 0 && !this.#complete.includes(hex)) {
        this.#complete.push(hex);
        if (this.#complete.length > COMPLETE_MAX) this.#complete.shift();
      }
    }
    // The recipient's own word, on a proved link, counts for an own file's progress.
    for (const file of this.#ownFiles.values()) {
      if (state.link.peerDeviceId !== file.offer.recipientDeviceId) continue;
      const peer = state.transfers.get(file.transferHex);
      if (!peer) continue;
      let moved = false;
      for (let i = 0; i < file.offer.count; i++) {
        if ((peer.complete || holds(peer.have, i)) && file.delivered.set(i)) moved = true;
      }
      if (moved) this.#fileProgress.emit(this.#progressOf(file));
    }
    if (held.length > 0) {
      await this.#store.remove(held);
      for (const id of held) this.#markDelivered(id);
      this.#changed();
    }
    void this.#pump(state);
  }

  // Outgoing

  #pumpAll(): void {
    for (const state of this.#links.values()) {
      if (state.tokens !== null) void this.#pump(state);
    }
  }

  /** Offers this link everything it should get, one packet at a time. */
  async #pump(state: LinkMesh): Promise<void> {
    if (state.pumping) {
      state.again = true;
      return;
    }
    state.pumping = true;
    try {
      do {
        state.again = false;
        for (;;) {
          if (this.#links.get(state.link.id) !== state || this.#disposed) return;
          const offer = this.#nextOffer(state);
          if (!offer) break;
          state.offered.add(this.#offerId(offer));
          await this.#offer(state, offer);
        }
      } while (state.again);
    } finally {
      state.pumping = false;
    }
  }

  #offerId(offer: Offer): string {
    if (offer.kind === 'own') return offer.entry.meta.id;
    if (offer.kind === 'ownChunk')
      return toHex(meshChunkPacketId(offer.file.transfer, offer.index));
    return offer.meta.id;
  }

  /** A stored chunk the peer said it holds, or of a transfer it finished: not to send it. */
  #peerHas(state: LinkMesh, meta: RelayPacketMeta): boolean {
    if (meta.kind !== 'chunk' || !meta.transfer) return false;
    const peer = state.transfers.get(meta.transfer);
    return peer !== undefined && (peer.complete || holds(peer.have, meta.index ?? -1));
  }

  /**
   * What to offer this link next, small before big: stored packets for the peer itself,
   * own file chunks for the peer itself, own messages to relays, own chunks to relays, then
   * other people's packets to relays.
   */
  #nextOffer(state: LinkMesh): Offer | undefined {
    const now = this.host.now();
    const { link, tokens, offered } = state;
    if (tokens === null) return undefined;
    const relayPeer = (link.capabilities & HelloCapability.RELAY) !== 0;
    const stored = this.#relaying ? this.#store.all() : [];
    // The recipient is on this link: hand it over (messages first).
    for (const chunks of [false, true]) {
      for (const meta of stored) {
        if ((meta.kind === 'chunk') !== chunks || offered.has(meta.id)) continue;
        if (meta.expiresAt > now && tokens.has(meta.dst) && !this.#peerHas(state, meta)) {
          return { kind: 'deliver', meta };
        }
      }
    }
    // Own files straight to their recipient's device, missing chunks only.
    for (const file of this.#ownFiles.values()) {
      if (link.peerDeviceId !== file.offer.recipientDeviceId || file.expiresAt <= now) continue;
      const peer = state.transfers.get(file.transferHex);
      if (peer?.complete) continue;
      for (let i = 0; i < file.offer.count; i++) {
        if (file.delivered.has(i) || holds(peer?.have, i)) continue;
        const offer: Offer = { kind: 'ownChunk', file, index: i, deliver: true };
        if (!offered.has(this.#offerId(offer))) return offer;
      }
    }
    if (!relayPeer) return undefined;
    for (const entry of this.#own.values()) {
      const { meta } = entry;
      if (offered.has(meta.id) || meta.expiresAt <= now || meta.copies < 2) continue;
      // The recipient itself takes it over the direct path.
      if (link.peerDeviceId === entry.dstDevice || entry.given.has(link.peerKey)) continue;
      return { kind: 'own', entry };
    }
    for (const file of this.#ownFiles.values()) {
      if (link.peerDeviceId === file.offer.recipientDeviceId || file.expiresAt <= now) continue;
      for (let i = 0; i < file.offer.count; i++) {
        if (file.delivered.has(i) || (file.copies[i] ?? 0) < 2) continue;
        if (file.given[i]?.has(link.peerKey)) continue;
        const offer: Offer = { kind: 'ownChunk', file, index: i, deliver: false };
        if (!offered.has(this.#offerId(offer))) return offer;
      }
    }
    for (const chunks of [false, true]) {
      for (const meta of stored) {
        if ((meta.kind === 'chunk') !== chunks) continue;
        if (offered.has(meta.id) || meta.expiresAt <= now) continue;
        if (meta.copies < 2 || meta.hopBudget < 1) continue;
        if (this.#fromPeer.get(meta.id) === link.peerKey) continue;
        if (this.#given.get(meta.id)?.has(link.peerKey)) continue;
        return { kind: 'spray', meta };
      }
    }
    return undefined;
  }

  /** An own file's chunk as a signed MESH_CHUNK payload and its header. */
  async #ownChunk(
    file: OwnFile,
    index: number,
  ): Promise<{ meta: RelayPacketMeta; payload: Uint8Array }> {
    const data = await file.offer.read(index);
    const packetId = meshChunkPacketId(file.transfer, index);
    const ref = create(MeshChunkRefSchema, {
      transferId: file.transfer,
      index,
      count: file.offer.count,
      chunkSha256: meshChunkDigest(data),
    });
    const signature = fromBase64(
      this.host.identity.sign(
        meshChunkMessage({
          packetId,
          createdAtMs: BigInt(file.offer.createdAt),
          expiresAtMs: BigInt(file.expiresAt),
          dst: file.dst,
          originToken: file.origin,
          transferId: file.transfer,
          index,
          count: file.offer.count,
          chunkSha256: ref.chunkSha256,
        }),
      ),
    );
    const payload = encodeMeshChunk(
      create(MeshChunkSchema, { ref, data, originToken: file.origin, signature }),
    );
    return {
      meta: {
        id: toHex(packetId),
        dst: toHex(file.dst),
        origin: toHex(file.origin),
        createdAt: file.offer.createdAt,
        expiresAt: file.expiresAt,
        hopBudget: this.#policy.maxHops,
        copies: file.copies[index] ?? 1,
        flags: 0,
        size: payload.length,
        receivedAt: file.offer.createdAt,
        kind: 'chunk',
        transfer: file.transferHex,
        index,
      },
      payload,
    };
  }

  async #offer(state: LinkMesh, offer: Offer): Promise<void> {
    let meta: RelayPacketMeta;
    let payload: Uint8Array | undefined;
    if (offer.kind === 'own') {
      meta = offer.entry.meta;
      payload = offer.entry.payload;
    } else if (offer.kind === 'ownChunk') {
      try {
        ({ meta, payload } = await this.#ownChunk(offer.file, offer.index));
      } catch {
        this.host.log?.('mesh file chunk unreadable');
        return; // the local copy is gone or unreadable
      }
    } else {
      meta = offer.meta;
      payload = await this.#store.readPayload(meta.id);
    }
    if (!payload) return;
    const { give } = splitCopies(meta.copies);
    const deliver = offer.kind === 'deliver' || (offer.kind === 'ownChunk' && offer.deliver);
    const copies = deliver ? 1 : give;
    let bytes: Uint8Array;
    try {
      bytes = encodeTransportPacket(
        create(TransportPacketSchema, {
          version: PROTOCOL_VERSION,
          packetId: fromHex(meta.id),
          kind: meta.kind === 'chunk' ? PacketKind.MESH_CHUNK : PacketKind.MESH_ENVELOPE,
          dst: fromHex(meta.dst),
          createdAtMs: BigInt(meta.createdAt),
          expiresAtMs: BigInt(meta.expiresAt),
          hopBudget: meta.hopBudget,
          flags: meta.flags,
          copies,
          payload,
        }),
        this.#codec(),
      );
    } catch (error) {
      // Expired meanwhile (or too large to send at all).
      this.host.log?.('mesh offer dropped', {
        reason: error instanceof ProtocolError ? error.code : 'error',
      });
      return;
    }
    const status = await this.#request(state, meta.id, bytes);
    const peer = state.link.peerKey;
    if (offer.kind === 'ownChunk') {
      this.#settleOwnChunk(offer, status, peer, copies);
      return;
    }
    switch (status) {
      case MeshAckStatus.ACCEPTED: {
        if (offer.kind === 'deliver') break;
        const keep = meta.copies - copies;
        if (offer.kind === 'own') {
          const { entry } = offer;
          entry.meta = { ...entry.meta, copies: keep };
          entry.given.add(peer);
          entry.relays.add(peer);
          this.#relayed.emit({ envelopeId: entry.envelopeId, relays: entry.relays.size });
        } else {
          this.#givenTo(meta.id).add(peer);
          await this.#store.setCopies(meta.id, keep);
        }
        break;
      }
      case MeshAckStatus.DELIVERED:
        if (offer.kind === 'own') {
          offer.entry.given.add(peer);
        } else {
          await this.#store.remove([meta.id]);
          this.#handedOver++;
          this.#markDelivered(meta.id);
          this.host.log?.('mesh packet handed over');
        }
        break;
      case MeshAckStatus.DUPLICATE:
        if (offer.kind === 'own') offer.entry.given.add(peer);
        else this.#givenTo(meta.id).add(peer);
        break;
      default:
        break; // refused or no answer: not on this link again
    }
    this.#changed();
  }

  #settleOwnChunk(
    offer: Extract<Offer, { kind: 'ownChunk' }>,
    status: MeshAckStatus | 'timeout',
    peer: string,
    copies: number,
  ): void {
    const { file, index } = offer;
    if (status === MeshAckStatus.DELIVERED && offer.deliver) {
      // Signed by the key the recipient's device proved on this link.
      file.delivered.set(index);
    } else if (status === MeshAckStatus.ACCEPTED && !offer.deliver) {
      file.copies[index] = (file.copies[index] ?? 1) - copies;
      file.given[index]?.add(peer);
      file.relays.add(peer);
    } else if (status === MeshAckStatus.DUPLICATE) {
      file.given[index]?.add(peer);
    } else {
      return;
    }
    this.#fileProgress.emit(this.#progressOf(file));
  }

  #request(state: LinkMesh, id: string, bytes: Uint8Array): Promise<MeshAckStatus | 'timeout'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => done('timeout'), this.#policy.ackTimeoutMs);
      const done = (status: MeshAckStatus | 'timeout') => {
        clearTimeout(timer);
        if (state.pending.get(id) === done) state.pending.delete(id);
        resolve(status);
      };
      state.pending.get(id)?.('timeout');
      state.pending.set(id, done);
      this.host.sendBytes(state.link.id, bytes).catch(() => done('timeout'));
    });
  }

  #answer(state: LinkMesh, packetId: Uint8Array, status: MeshAckStatus): void {
    if (packetId.length !== UUID_BYTES || this.#links.get(state.link.id) !== state) return;
    const signature = fromBase64(
      this.host.identity.sign(meshAckMessage(state.link.peerToken, packetId, status)),
    );
    this.#sendControl(
      state,
      PacketKind.MESH_ACK,
      encodeMeshAck(create(MeshAckSchema, { packetId, status, signature })),
    );
  }

  #sendSummary(state: LinkMesh): void {
    if (this.#links.get(state.link.id) !== state) return;
    state.lastSummaryAt = this.host.now();
    this.#sendControl(
      state,
      PacketKind.MESH_SUMMARY,
      encodeMeshSummary(
        create(MeshSummarySchema, {
          routingTokens: this.#ownTokens(state.lastSummaryAt).bytes,
          delivered: this.#delivered.map(fromHex),
          transfers: this.#transferStates(),
        }),
      ),
    );
  }

  /** Own incoming transfers first (so holders resume them), then complete ones passed on. */
  #transferStates(): { transferId: Uint8Array; have: Uint8Array; complete: boolean }[] {
    const out: { transferId: Uint8Array; have: Uint8Array; complete: boolean }[] = [];
    const seen = new Set<string>();
    for (const t of this.#sink?.progress() ?? []) {
      const transferId = uuidToBytes(t.transferId);
      seen.add(toHex(transferId));
      out.push({ transferId, have: t.complete ? new Uint8Array(0) : t.have, complete: t.complete });
    }
    for (const hex of [...this.#complete].reverse()) {
      if (!seen.has(hex))
        out.push({ transferId: fromHex(hex), have: new Uint8Array(0), complete: true });
    }
    return out.slice(0, MAX_MESH_SUMMARY_TRANSFERS);
  }

  #sendControl(state: LinkMesh, kind: PacketKind, payload: Uint8Array): void {
    const now = this.host.now();
    const bytes = encodeTransportPacket(
      create(TransportPacketSchema, {
        version: PROTOCOL_VERSION,
        packetId: uuidv7Bytes(),
        kind,
        dst: Uint8Array.of(0), // hop-local
        createdAtMs: BigInt(now),
        expiresAtMs: BigInt(now + 10 * 60_000),
        hopBudget: 0,
        flags: 0,
        payload,
      }),
      this.#codec(now),
    );
    this.host.sendBytes(state.link.id, bytes).catch(() => undefined);
  }

  // Bookkeeping

  /** Delivered: remembered, and passed on in the next summaries (a few seconds later). */
  #markDelivered(id: string): void {
    if (this.#delivered.includes(id)) return;
    this.#delivered.push(id);
    if (this.#delivered.length > Math.min(this.#policy.deliveredMax, MAX_MESH_SUMMARY_DELIVERED)) {
      this.#delivered.shift();
    }
    this.#scheduleSummaries();
  }

  /** New summaries to every linked peer, at most one per link per interval. */
  #scheduleSummaries(): void {
    if (this.#summaryTimer !== undefined) return;
    this.#summaryTimer = setTimeout(() => {
      this.#summaryTimer = undefined;
      const now = this.host.now();
      for (const state of this.#links.values()) {
        if (now - state.lastSummaryAt >= SUMMARY_INTERVAL_MS) this.#sendSummary(state);
      }
    }, SUMMARY_INTERVAL_MS);
  }

  async #remember(id: string, expiresAt: number): Promise<void> {
    const evicted = this.#seen.add(id, expiresAt);
    await this.#persistence.saveSeen([{ id, expiresAt }], evicted).catch(() => undefined);
  }

  #givenTo(id: string): Set<string> {
    let set = this.#given.get(id);
    if (!set) {
      set = new Set();
      this.#given.set(id, set);
    }
    return set;
  }

  async #prune(): Promise<void> {
    const now = this.host.now();
    const gone = await this.#store.prune(now);
    for (const id of gone) {
      this.#fromPeer.delete(id);
      this.#given.delete(id);
    }
    const forgotten = this.#seen.prune(now);
    if (forgotten.length > 0)
      await this.#persistence.saveSeen([], forgotten).catch(() => undefined);
    for (const [id, entry] of this.#own) {
      if (entry.meta.expiresAt > now) continue;
      this.#own.delete(id);
      this.#ownByEnvelope.delete(entry.envelopeId);
    }
    for (const [key, file] of this.#ownFiles) {
      if (file.expiresAt <= now) this.#ownFiles.delete(key);
    }
    this.#changed();
  }

  #ownTokens(now: number): { hex: Set<string>; bytes: Uint8Array[] } {
    const day = meshDay(now);
    if (this.#tokens?.day !== day) {
      const bytes = meshRoutingTokens(this.host.identity.deviceId, now, this.#policy.ttlMs);
      this.#tokens = { day, bytes, hex: new Set(bytes.map(toHex)) };
    }
    return this.#tokens;
  }

  #statement(mesh: MeshEnvelope) {
    return {
      originToken: mesh.originToken,
      envelopeId: mesh.envelopeId,
      cryptoType: mesh.cryptoType,
      groupId: mesh.groupId,
      megolmSessionId: mesh.megolmSessionId,
      ciphertext: mesh.ciphertext,
    };
  }

  #snapshot(): MeshStatus {
    return {
      relaying: this.#relaying,
      stored: this.#store.usage(),
      own: this.#own.size,
      carried: this.#carried,
      handedOver: this.#handedOver,
      files: this.#ownFiles.size,
    };
  }

  #changed(): void {
    if (!this.#disposed) this.#status.set(this.#snapshot());
  }

  #codec(nowMs = this.host.now()): CodecOptions {
    return {
      nowMs,
      ...(this.host.envelopeMaxBytes === undefined
        ? {}
        : { envelopeMaxBytes: this.host.envelopeMaxBytes }),
    };
  }
}
