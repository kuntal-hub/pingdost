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
  checkMeshPacket,
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
  encodeMeshEnvelope,
  encodeMeshSummary,
  encodeTransportPacket,
  fromBase64,
  fromMeshEnvelope,
  HelloCapability,
  MAX_MESH_SUMMARY_DELIVERED,
  MeshAckSchema,
  MeshAckStatus,
  MeshSummarySchema,
  meshAckMessage,
  meshDay,
  meshEnvelopeMessage,
  meshRoutingToken,
  meshRoutingTokens,
  PacketKind,
  PROTOCOL_VERSION,
  toBase64,
  toMeshEnvelope,
  TransportPacketSchema,
  UUID_BYTES,
  uuidToBytes,
  uuidv7Bytes,
  type CodecOptions,
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
}

export interface MeshHost {
  identity: MeshIdentity;
  now: () => number;
  envelopeMaxBytes?: number;
  sendBytes(linkId: number, bytes: Uint8Array): Promise<void>;
  /** Hands an envelope for this device to the engine; `ack` once it is stored. */
  deliver(packet: TransportPacket, ack: () => void): void;
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

interface LinkMesh {
  link: MeshLink;
  /** The peer's routing tokens (hex), once its summary arrived. */
  tokens: Set<string> | null;
  /** Packet IDs offered on this link already. */
  offered: Set<string>;
  pending: Map<string, (status: MeshAckStatus | 'timeout') => void>;
  pumping: boolean;
  again: boolean;
  lastSummaryAt: number;
}

type Offer =
  | { kind: 'own'; entry: OwnEntry }
  | { kind: 'deliver'; meta: RelayPacketMeta }
  | { kind: 'spray'; meta: RelayPacketMeta };

const HELD: SendResult = { ok: true, status: 'held', via: 'mesh' };
const unpadded = (bytes: Uint8Array) => toBase64(bytes).replace(/=+$/, '');
/** Summaries to one link at most this often, besides the first. */
const SUMMARY_INTERVAL_MS = 10_000;
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
  readonly #relayed = new Listeners<[RelayedEvent]>();
  readonly #status: ValueStream<MeshStatus>;
  #relaying: boolean;
  #started: Promise<void> | undefined;
  #carried = 0;
  #handedOver = 0;
  #tokens: { day: number; hex: Set<string>; bytes: Uint8Array[] } | undefined;
  #summaryTimer: ReturnType<typeof setTimeout> | undefined;
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
    this.#status = new ValueStream<MeshStatus>(this.#snapshot());
    this.#persistence = options.persistence;
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
      offered: new Set(),
      pending: new Map(),
      pumping: false,
      again: false,
      lastSummaryAt: 0,
    };
    this.#links.set(link.id, state);
    void this.start().then(() => this.#sendSummary(state));
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
          const id = offer.kind === 'own' ? offer.entry.meta.id : offer.meta.id;
          state.offered.add(id);
          await this.#offer(state, offer);
        }
      } while (state.again);
    } finally {
      state.pumping = false;
    }
  }

  #nextOffer(state: LinkMesh): Offer | undefined {
    const now = this.host.now();
    const { link, tokens, offered } = state;
    if (tokens === null) return undefined;
    const relayPeer = (link.capabilities & HelloCapability.RELAY) !== 0;
    if (this.#relaying) {
      // The recipient is on this link: hand it over.
      for (const meta of this.#store.all()) {
        if (!offered.has(meta.id) && meta.expiresAt > now && tokens.has(meta.dst)) {
          return { kind: 'deliver', meta };
        }
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
    if (!this.#relaying) return undefined;
    for (const meta of this.#store.all()) {
      if (offered.has(meta.id) || meta.expiresAt <= now) continue;
      if (meta.copies < 2 || meta.hopBudget < 1) continue;
      if (this.#fromPeer.get(meta.id) === link.peerKey) continue;
      if (this.#given.get(meta.id)?.has(link.peerKey)) continue;
      return { kind: 'spray', meta };
    }
    return undefined;
  }

  async #offer(state: LinkMesh, offer: Offer): Promise<void> {
    const meta = offer.kind === 'own' ? offer.entry.meta : offer.meta;
    const payload =
      offer.kind === 'own' ? offer.entry.payload : await this.#store.readPayload(meta.id);
    if (!payload) return;
    const { give } = splitCopies(meta.copies);
    const copies = offer.kind === 'deliver' ? 1 : give;
    let bytes: Uint8Array;
    try {
      bytes = encodeTransportPacket(
        create(TransportPacketSchema, {
          version: PROTOCOL_VERSION,
          packetId: fromHex(meta.id),
          kind: PacketKind.MESH_ENVELOPE,
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
    } catch {
      return; // expired meanwhile
    }
    const status = await this.#request(state, meta.id, bytes);
    const peer = state.link.peerKey;
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
        }),
      ),
    );
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
