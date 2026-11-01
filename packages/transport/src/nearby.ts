/**
 * Direct nearby messaging (REQ §11.1 mode 1, §11.2, §11.3; ADR 0024): the message engine's
 * `TransportPacket`s over the platform's nearby links, unchanged. The links themselves are
 * not paired or encrypted (ADR 0023); what they carry is already E2EE.
 *
 * - **Handshake.** On every new link each side sends `Hello` with a fresh random token, then a
 *   second `Hello` whose proof signs both tokens with its device's Ed25519 identity key
 *   (`nearbyHelloMessage`). A peer whose key is in this device's verified directory is a known
 *   contact device: packets for it go over this link. Any other peer stays unknown (a relay
 *   candidate for Phase 23); this side learns nothing more about it.
 * - **Delivery.** An envelope goes only to the link whose peer proved the recipient device's
 *   key. The recipient answers with an `Ack` once it stored the envelope; then `send` resolves
 *   `ok` (the next hop holds it, which is not a delivery receipt). No ACK in time is `TIMEOUT`:
 *   the sender tries again later, maybe over the Internet, and the recipient dedupes.
 * - **Status.** `online` while started (looking for peers), whether or not anyone is in
 *   range; `reaches` answers per device.
 */
import {
  AckSchema,
  bytesEqual,
  bytesToUuid,
  create,
  decodeAck,
  decodeEnvelope,
  decodeHello,
  decodeTransportPacket,
  encodeAck,
  encodeHello,
  encodeTransportPacket,
  fromBase64,
  HELLO_TOKEN_BYTES,
  HelloCapability,
  HelloProofSchema,
  HelloSchema,
  MAX_ACK_IDS,
  nearbyHelloMessage,
  PacketKind,
  PROTOCOL_VERSION,
  ProtocolError,
  toBase64,
  TransportPacketSchema,
  UUID_BYTES,
  uuidToBytes,
  uuidv7Bytes,
  type CodecOptions,
  type Hello,
  type TransportPacket,
} from '@pingdost/protocol';

import { MeshRelay, type MeshIdentity, type MeshRelayOptions } from './mesh';
import { Listeners, ValueStream, type ReadonlyValueStream } from './stream';
import type {
  PacketListener,
  RelayedEvent,
  SendResult,
  Transport,
  TransportStatus,
  Unsubscribe,
} from './types';

// REQ §11.2's platform interface. Android implements it on the BLE module (ADR 0023).

export interface PeerDescriptor {
  /** The peer's current link-layer address (it rotates; never an identity). */
  address: string;
  /** Its advertised random token, if known (it rotates too). */
  token: string | null;
}

export interface PeerConnection {
  linkId: number;
  peer: PeerDescriptor;
  mtu: number;
}

export interface NearbyLinkDown {
  id: number;
  reason: string;
  /** Packets accepted by `send` that never went out. */
  unsent: number;
}

export interface NearbyTransport {
  startDiscovery(): Promise<void>;
  stopDiscovery(): Promise<void>;
  connect(peer: PeerDescriptor): Promise<PeerConnection>;
  disconnect(connection: PeerConnection): Promise<void>;
  /** Resolves once the link took the packet (not on delivery). */
  send(connection: PeerConnection, packet: Uint8Array): Promise<void>;
  onPacket(handler: (packet: Uint8Array, from: PeerConnection) => void): Unsubscribe;
  onConnection(handler: (connection: PeerConnection) => void): Unsubscribe;
  onDisconnect(handler: (event: NearbyLinkDown) => void): Unsubscribe;
}

// Who is on the other end

/** A device of a known contact (or of this user), proven in the handshake. */
export interface NearbyPeer {
  userId: string;
  deviceId: string;
}

export type HelloCheck =
  | { status: 'known'; peer: NearbyPeer }
  /** A valid signature by a key this device has no verified directory entry for. */
  | { status: 'unknown' }
  | { status: 'invalid' };

/** The message engine provides this (`createNearbyIdentity`). */
export interface NearbyIdentity {
  readonly deviceId: string;
  /** This device's Ed25519 identity key, unpadded base64. */
  readonly identityKey: string;
  /** Signs with the device's identity key; returns the signature as base64. */
  sign(message: Uint8Array): string;
  /** Checks the signature, then looks the key up among the verified directories. */
  check(identityKey: string, message: Uint8Array, signature: string): Promise<HelloCheck>;
  /** A plain Ed25519 check (mesh ACKs and relayed envelopes; needed for the mesh). */
  verify?: MeshIdentity['verify'];
  /** The cached directory device behind a routing token (needed for the mesh). */
  resolveOrigin?: MeshIdentity['resolveOrigin'];
}

export interface NearbySummary {
  /** Known contact devices with a link now. */
  peers: NearbyPeer[];
  /** Links whose peer proved a key this device does not know. */
  unknown: number;
  /** Links still in the handshake. */
  pending: number;
}

export interface NearbyPeerTransportOptions {
  links: NearbyTransport;
  identity: NearbyIdentity;
  /** No nearby ACK in this long: `TIMEOUT`. Default 15 s. */
  ackTimeoutMs?: number;
  /** A peer that has not proved a key by then counts as unknown. Default 15 s. */
  handshakeTimeoutMs?: number;
  /** HELLO and ACK packets expire this long after they are made (room for clock skew). */
  controlTtlMs?: number;
  /** `ENVELOPE_MAX_BYTES`. */
  envelopeMaxBytes?: number;
  now?: () => number;
  random?: (length: number) => Uint8Array;
  /** States and counts only, never keys or packet contents (ARCHITECTURE A10). */
  log?: (message: string, fields?: Record<string, string | number | boolean>) => void;
  /**
   * The mesh relay (ADR 0025): packets for devices out of range are held and handed to relays,
   * and, while relaying is on, other people's packets are carried. Without it, only direct.
   */
  mesh?: MeshRelayOptions;
}

/** HELLO and ACK are hop-local: their `dst` names no device. */
const LINK_LOCAL = Uint8Array.of(0);
/** Invalid proofs on one link before it is closed. */
const MAX_INVALID_PROOFS = 3;

const OFFLINE: SendResult = { ok: false, code: 'OFFLINE', retryable: true };
const NO_ROUTE: SendResult = { ok: false, code: 'NO_ROUTE', retryable: true };
const TIMEOUT: SendResult = { ok: false, code: 'TIMEOUT', retryable: true };
const ACKED: SendResult = { ok: true, status: 'delivered_transport' };

const unpadded = (bytes: Uint8Array) => toBase64(bytes).replace(/=+$/, '');

interface LinkState {
  connection: PeerConnection;
  ownToken: Uint8Array;
  peerToken: Uint8Array | null;
  /** The peer token our proof was made for. */
  provedFor: Uint8Array | null;
  /** The key the peer proved, and the capabilities it signed. */
  peerKey: string | null;
  capabilities: number;
  status: 'handshake' | 'known' | 'unknown';
  peer: NearbyPeer | null;
  invalidProofs: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Envelope IDs stored here and not yet acknowledged to the peer. */
  acks: Uint8Array[];
}

interface PendingSend {
  linkId: number;
  resolve: (result: SendResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class NearbyPeerTransport implements Transport {
  readonly kind = 'nearby';
  readonly #status = new ValueStream<TransportStatus>('offline');
  readonly #summary = new ValueStream<NearbySummary>({ peers: [], unknown: 0, pending: 0 });
  readonly #packets = new Listeners<Parameters<PacketListener>>();
  readonly #reach = new Listeners<[]>();
  readonly #links = new Map<number, LinkState>();
  readonly #pending = new Map<string, PendingSend>();
  readonly #unsubscribe: Unsubscribe[];
  readonly #self: Uint8Array;
  readonly #options: Required<
    Omit<NearbyPeerTransportOptions, 'links' | 'identity' | 'envelopeMaxBytes' | 'log' | 'mesh'>
  > &
    Pick<NearbyPeerTransportOptions, 'envelopeMaxBytes' | 'log'>;
  readonly #mesh: MeshRelay | undefined;

  constructor(private readonly config: NearbyPeerTransportOptions) {
    this.#options = {
      ackTimeoutMs: config.ackTimeoutMs ?? 15_000,
      handshakeTimeoutMs: config.handshakeTimeoutMs ?? 15_000,
      controlTtlMs: config.controlTtlMs ?? 10 * 60_000,
      now: config.now ?? Date.now,
      random: config.random ?? ((length) => crypto.getRandomValues(new Uint8Array(length))),
      ...(config.envelopeMaxBytes === undefined
        ? {}
        : { envelopeMaxBytes: config.envelopeMaxBytes }),
      ...(config.log === undefined ? {} : { log: config.log }),
    };
    this.#self = uuidToBytes(config.identity.deviceId);
    const { identity } = config;
    if (config.mesh) {
      const { verify, resolveOrigin } = identity;
      if (!verify || !resolveOrigin) throw new Error('the mesh needs verify and resolveOrigin');
      this.#mesh = new MeshRelay(
        {
          identity: {
            deviceId: identity.deviceId,
            sign: (m) => identity.sign(m),
            verify,
            resolveOrigin,
          },
          now: () => this.#options.now(),
          ...(config.envelopeMaxBytes === undefined
            ? {}
            : { envelopeMaxBytes: config.envelopeMaxBytes }),
          sendBytes: (linkId, bytes) => {
            const link = this.#links.get(linkId);
            return link
              ? this.config.links.send(link.connection, bytes)
              : Promise.reject(new Error('link_down'));
          },
          deliver: (packet, ack) => this.#packets.emit(packet, ack),
          ...(config.log === undefined ? {} : { log: config.log }),
        },
        config.mesh,
      );
    }
    const { links } = config;
    this.#unsubscribe = [
      links.onConnection((connection) => this.#onConnection(connection)),
      links.onPacket((packet, from) => this.#onPacket(packet, from)),
      links.onDisconnect((event) => this.#onDisconnect(event.id)),
    ];
  }

  get status$(): ReadonlyValueStream<TransportStatus> {
    return this.#status;
  }

  /** Known contacts in range, unknown peers and handshakes in progress. */
  get summary$(): ReadonlyValueStream<NearbySummary> {
    return this.#summary;
  }

  /** The mesh relay, when configured: its status, the relaying switch and the cache. */
  get mesh(): MeshRelay | undefined {
    return this.#mesh;
  }

  /** Starts looking for peers; packets may wait for a nearby route from now on. */
  async start(): Promise<void> {
    await this.#mesh?.start();
    await this.config.links.startDiscovery();
    this.#status.set('online');
  }

  /** Stops discovery and forgets every link. */
  async stop(): Promise<void> {
    this.#status.set('offline');
    for (const id of [...this.#links.keys()]) this.#onDisconnect(id);
    await this.config.links.stopDiscovery();
  }

  dispose(): void {
    this.#status.set('offline');
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    for (const id of [...this.#links.keys()]) this.#onDisconnect(id);
    this.#mesh?.dispose();
  }

  reaches(deviceId: string): boolean {
    return this.#status.value === 'online' && this.#linkFor(deviceId) !== undefined;
  }

  /** With the mesh, every device out of direct range can wait in it for relays. */
  carries(): boolean {
    return this.#status.value === 'online' && this.#mesh !== undefined;
  }

  withdraw(envelopeIds: readonly string[]): void {
    this.#mesh?.withdraw(envelopeIds);
  }

  onRelayed(listener: (event: RelayedEvent) => void): Unsubscribe {
    return this.#mesh?.onRelayed(listener) ?? (() => undefined);
  }

  onReachability(listener: () => void): Unsubscribe {
    return this.#reach.add(listener);
  }

  onPacket(listener: PacketListener): Unsubscribe {
    return this.#packets.add(listener);
  }

  /**
   * Sends one envelope to its recipient device's link and waits for that device's ACK. With
   * no such link, the mesh holds it for relays (`held`) when it is configured.
   */
  async send(packet: TransportPacket): Promise<SendResult> {
    if (this.#status.value !== 'online') return OFFLINE;
    if (packet.kind !== PacketKind.ENVELOPE || packet.dst.length !== UUID_BYTES) {
      return { ok: false, code: 'INVALID', retryable: false };
    }
    const link = this.#linkFor(bytesToUuid(packet.dst));
    if (!link) return this.#mesh ? this.#mesh.send(packet) : NO_ROUTE;
    let bytes: Uint8Array;
    let key: string;
    try {
      key = bytesToUuid(decodeEnvelope(packet.payload, this.#codec()).envelopeId);
      bytes = encodeTransportPacket(packet, this.#codec());
    } catch (error) {
      const expired = error instanceof ProtocolError && error.code === 'EXPIRED';
      return { ok: false, code: expired ? 'ENVELOPE_EXPIRED' : 'INVALID', retryable: false };
    }
    this.#pending.get(key)?.resolve(TIMEOUT);
    const linkId = link.connection.linkId;
    const acked = new Promise<SendResult>((resolve) => {
      const entry: PendingSend = {
        linkId,
        resolve: (result) => {
          clearTimeout(entry.timer);
          if (this.#pending.get(key) === entry) this.#pending.delete(key);
          resolve(result);
        },
        timer: setTimeout(() => entry.resolve(TIMEOUT), this.#options.ackTimeoutMs),
      };
      this.#pending.set(key, entry);
    });
    try {
      await this.config.links.send(link.connection, bytes);
    } catch {
      // The link refused it (gone, full): nothing went out.
      this.#pending.get(key)?.resolve(NO_ROUTE);
    }
    return acked;
  }

  // Links

  #linkFor(deviceId: string): LinkState | undefined {
    let found: LinkState | undefined;
    for (const link of this.#links.values()) {
      if (link.status === 'known' && link.peer?.deviceId === deviceId) found = link;
    }
    return found; // the newest
  }

  #onConnection(connection: PeerConnection): void {
    const existing = this.#links.get(connection.linkId);
    if (existing) {
      existing.connection = connection;
      return;
    }
    this.#adopt(connection);
  }

  /** A new link, or one that was up before this transport (a JS reload): handshake now. */
  #adopt(connection: PeerConnection): LinkState {
    const link: LinkState = {
      connection,
      ownToken: this.#options.random(HELLO_TOKEN_BYTES),
      peerToken: null,
      provedFor: null,
      status: 'handshake',
      peer: null,
      peerKey: null,
      capabilities: 0,
      invalidProofs: 0,
      timer: undefined,
      acks: [],
    };
    link.timer = setTimeout(() => {
      if (this.#links.get(connection.linkId) !== link || link.status !== 'handshake') return;
      link.status = 'unknown';
      this.#log('nearby handshake timed out');
      this.#changed(false);
    }, this.#options.handshakeTimeoutMs);
    this.#links.set(connection.linkId, link);
    this.#sendHello(link, false);
    this.#changed(false);
    return link;
  }

  #onDisconnect(id: number): void {
    const link = this.#links.get(id);
    if (!link) return;
    this.#links.delete(id);
    clearTimeout(link.timer);
    this.#mesh?.linkDown(id);
    // It may or may not have arrived: the sender tries again and the recipient dedupes.
    for (const entry of [...this.#pending.values()]) {
      if (entry.linkId === id) entry.resolve(TIMEOUT);
    }
    this.#changed(link.status === 'known');
  }

  #changed(reach: boolean): void {
    const links = [...this.#links.values()];
    this.#summary.set({
      peers: links.flatMap((l) => (l.status === 'known' && l.peer ? [l.peer] : [])),
      unknown: links.filter((l) => l.status === 'unknown').length,
      pending: links.filter((l) => l.status === 'handshake').length,
    });
    if (reach) this.#reach.emit();
  }

  // Incoming

  #onPacket(bytes: Uint8Array, from: PeerConnection): void {
    if (this.#status.value !== 'online') return;
    const link = this.#links.get(from.linkId) ?? this.#adopt(from);
    let packet: TransportPacket;
    try {
      packet = decodeTransportPacket(bytes, this.#codec());
    } catch {
      this.#log('nearby packet rejected');
      return;
    }
    switch (packet.kind) {
      case PacketKind.HELLO:
        void this.#onHello(link, packet.payload);
        break;
      case PacketKind.ENVELOPE:
        this.#onEnvelope(link, packet);
        break;
      case PacketKind.ACK:
        this.#onAck(link, packet.payload);
        break;
      case PacketKind.MESH_ENVELOPE:
      case PacketKind.MESH_CHUNK:
      case PacketKind.MESH_ACK:
      case PacketKind.MESH_SUMMARY:
        // Only from a peer that proved a key on this link (ADR 0025, 0027).
        if (link.peerKey !== null) this.#mesh?.onPacket(link.connection.linkId, packet);
        break;
      default:
        break;
    }
  }

  async #onHello(link: LinkState, payload: Uint8Array): Promise<void> {
    let hello: Hello;
    try {
      hello = decodeHello(payload);
    } catch {
      this.#log('nearby hello rejected');
      return;
    }
    if (link.peerToken === null || !bytesEqual(link.peerToken, hello.peerToken)) {
      const reset = link.peerToken !== null;
      link.peerToken = hello.peerToken;
      if (reset) {
        // The peer started over (e.g. its app reloaded): prove again, and tell it our token.
        const wasKnown = link.status === 'known';
        link.status = 'handshake';
        link.peer = null;
        link.peerKey = null;
        this.#mesh?.linkDown(link.connection.linkId);
        this.#changed(wasKnown);
        this.#sendHello(link, false);
      }
    }
    if (link.provedFor === null || !bytesEqual(link.provedFor, hello.peerToken)) {
      this.#sendHello(link, true);
    }
    if (hello.proof) await this.#verify(link, hello);
  }

  async #verify(link: LinkState, hello: Hello): Promise<void> {
    const proof = hello.proof;
    if (!proof) return;
    const identityKey = unpadded(proof.identityKey);
    let message: Uint8Array;
    try {
      message = nearbyHelloMessage(hello.peerToken, link.ownToken, identityKey, hello.capabilities);
    } catch {
      return;
    }
    const result = await this.config.identity.check(
      identityKey,
      message,
      unpadded(proof.signature),
    );
    const current = this.#links.get(link.connection.linkId);
    if (current !== link || link.peerToken === null || !bytesEqual(link.peerToken, hello.peerToken))
      return; // gone or restarted meanwhile
    if (result.status === 'invalid') {
      link.invalidProofs++;
      this.#log('nearby proof invalid', { count: link.invalidProofs });
      if (link.invalidProofs >= MAX_INVALID_PROOFS) {
        void this.config.links.disconnect(link.connection).catch(() => undefined);
      }
      return;
    }
    clearTimeout(link.timer);
    link.peerKey = identityKey;
    link.capabilities = hello.capabilities;
    if (result.status === 'known' && (hello.capabilities & HelloCapability.DIRECT) !== 0) {
      link.status = 'known';
      link.peer = result.peer;
      this.#log('nearby peer known');
      this.#changed(true);
    } else {
      link.status = 'unknown';
      link.peer = null;
      this.#log('nearby peer unknown');
      this.#changed(false);
    }
    if (link.peerToken) {
      this.#mesh?.linkReady({
        id: link.connection.linkId,
        ownToken: link.ownToken,
        peerToken: link.peerToken,
        peerKey: identityKey,
        capabilities: hello.capabilities,
        peerDeviceId: link.peer?.deviceId ?? null,
      });
    }
  }

  #onEnvelope(link: LinkState, packet: TransportPacket): void {
    // Only envelopes for this device; forwarding for others is Phase 23's relay.
    if (!bytesEqual(packet.dst, this.#self)) return;
    let envelopeId: Uint8Array;
    try {
      envelopeId = decodeEnvelope(packet.payload, this.#codec()).envelopeId;
    } catch {
      this.#log('nearby envelope rejected');
      return;
    }
    let acked = false;
    this.#packets.emit(packet, () => {
      if (acked) return;
      acked = true;
      this.#queueAck(link, envelopeId);
    });
  }

  #onAck(link: LinkState, payload: Uint8Array): void {
    let ids: Uint8Array[];
    try {
      ids = decodeAck(payload).envelopeIds;
    } catch {
      return;
    }
    for (const id of ids) {
      const entry = this.#pending.get(bytesToUuid(id));
      // Only the link it went to can acknowledge it.
      if (entry?.linkId === link.connection.linkId) entry.resolve(ACKED);
    }
  }

  // Outgoing control packets

  /** Acknowledgements made in one turn go out together. */
  #queueAck(link: LinkState, envelopeId: Uint8Array): void {
    link.acks.push(envelopeId);
    if (link.acks.length > 1) return;
    queueMicrotask(() => {
      while (link.acks.length > 0) {
        const envelopeIds = link.acks.splice(0, MAX_ACK_IDS);
        this.#sendControl(link, PacketKind.ACK, encodeAck(create(AckSchema, { envelopeIds })));
      }
    });
  }

  /** What this device does over a nearby link: direct always, relaying while it is on. */
  #capabilities(): number {
    return HelloCapability.DIRECT | (this.#mesh?.relaying ? HelloCapability.RELAY : 0);
  }

  #sendHello(link: LinkState, withProof: boolean): void {
    const capabilities = this.#capabilities();
    const hello = create(HelloSchema, {
      protocolVersion: PROTOCOL_VERSION,
      peerToken: link.ownToken,
      capabilities,
    });
    if (withProof && link.peerToken) {
      const { identity } = this.config;
      const message = nearbyHelloMessage(
        link.ownToken,
        link.peerToken,
        identity.identityKey,
        capabilities,
      );
      hello.proof = create(HelloProofSchema, {
        identityKey: fromBase64(identity.identityKey),
        signature: fromBase64(identity.sign(message)),
      });
      link.provedFor = link.peerToken;
    }
    this.#sendControl(link, PacketKind.HELLO, encodeHello(hello));
  }

  #sendControl(link: LinkState, kind: PacketKind, payload: Uint8Array): void {
    const now = this.#options.now();
    const bytes = encodeTransportPacket(
      create(TransportPacketSchema, {
        version: PROTOCOL_VERSION,
        packetId: uuidv7Bytes(),
        kind,
        dst: LINK_LOCAL,
        createdAtMs: BigInt(now),
        expiresAtMs: BigInt(now + this.#options.controlTtlMs),
        hopBudget: 0,
        flags: 0,
        payload,
      }),
      this.#codec(now),
    );
    this.config.links.send(link.connection, bytes).catch(() => {
      // The link is going away; its disconnect event cleans up.
    });
  }

  #codec(nowMs = this.#options.now()): CodecOptions {
    return {
      nowMs,
      ...(this.#options.envelopeMaxBytes === undefined
        ? {}
        : { envelopeMaxBytes: this.#options.envelopeMaxBytes }),
    };
  }

  #log(message: string, fields?: Record<string, string | number | boolean>): void {
    this.#options.log?.(message, fields);
  }
}
