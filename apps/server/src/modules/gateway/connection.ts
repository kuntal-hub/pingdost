/**
 * One device's WebSocket (ARCHITECTURE A3, A4; ADR 0010). Each binary message is one
 * ClientFrame or ServerFrame.
 * - The first frame must be `Auth` within `authTimeoutMs`; tokens never travel in the URL.
 * - `Send` runs the online path (Deliver → transport ACK) or the offline mailbox path, and
 *   is answered by one `Accepted` or `ServerError` with the same request ID.
 * - After `AuthOk`, pending mail streams in batches; the next batch waits for the ACKs.
 * - Typing and ephemeral packets are relayed in memory to online devices only.
 * Frames are rate-limited per socket, and a slow reader is never buffered without bound.
 */
import type { Collection } from 'mongodb';
import type { Logger } from 'pino';
import type { RawData, WebSocket } from 'ws';

import {
  Accepted_Status,
  bytesToUuid,
  create,
  decodeClientFrame,
  decodeTransportPacket,
  encodeServerFrame,
  PacketFlag,
  PROTOCOL_VERSION,
  ProtocolError,
  ServerFrameSchema,
  uuidToBytes,
  type Auth,
  type ClientFrame,
  type MessageInitShape,
  type TransportPacket,
  type Typing,
} from '@pingdost/protocol';
import { RETRYABLE_ERROR_CODES, type ErrorCode } from '@pingdost/shared-types';

import type { ConnectionRegistry } from './registry';
import type { Clock } from '../../infra/clock';
import { AppError } from '../../infra/errors';
import type { Metrics } from '../../infra/metrics';
import type { AuthCollections } from '../auth/repo';
import type { AccessTokens } from '../auth/tokens';
import type { EnvelopeRecord } from '../delivery/record';
import {
  DeliveryError,
  protocolErrorCode,
  type DeliveryService,
  type EnvelopeSource,
} from '../delivery/service';
import type { MailboxSettings } from '../delivery/settings';
import type { DeviceCollections } from '../device/repo';
import type { OneTimeKeyDoc } from '../keys/repo';
import type { PushNotifier } from '../push/notifier';

export interface GatewaySettings {
  authTimeoutMs: number;
  /** Sent in `AuthOk`: how often an idle client should Ping. */
  clientPingIntervalMs: number;
  /** Server-side WebSocket pings; a socket that misses one is terminated. */
  serverPingIntervalMs: number;
  /** Re-checks the session, so logout and revocation close the socket. */
  sessionRecheckMs: number;
  /** Bytes queued on a socket before non-essential frames are dropped and fetches pause. */
  maxBufferedBytes: number;
  /** `Send`s awaiting their answer, per socket. */
  maxInflightSends: number;
  /** Frames per `rateWindowMs`, per socket. */
  maxFrames: number;
  maxTypingFrames: number;
  rateWindowMs: number;
  /** How long a fetch batch waits for its ACKs before the stream stops. */
  fetchAckTimeoutMs: number;
  /** ACKs within this window are deleted together (fewer Redis commands). */
  ackCoalesceMs: number;
  /** `OtkLow` is sent below this many unclaimed one-time keys (the app tops up to 50). */
  otkLowThreshold: number;
}

export const DEFAULT_GATEWAY_SETTINGS: GatewaySettings = {
  authTimeoutMs: 5_000,
  clientPingIntervalMs: 25_000,
  serverPingIntervalMs: 30_000,
  sessionRecheckMs: 60_000,
  maxBufferedBytes: 1_048_576,
  maxInflightSends: 64,
  maxFrames: 300,
  maxTypingFrames: 30,
  rateWindowMs: 10_000,
  fetchAckTimeoutMs: 30_000,
  ackCoalesceMs: 50,
  otkLowThreshold: 20,
};

/** Application close codes (4000–4999). */
export const CLOSE_CODES = {
  unauthenticated: 4001,
  replaced: 4002,
  revoked: 4003,
  /** Too many frames, or a reader too slow to keep up. */
  overloaded: 4008,
  /** A frame that is not a protocol message. */
  protocol: 1002,
} as const;

export interface GatewayDeps {
  settings: GatewaySettings;
  mailbox: MailboxSettings;
  clock: Clock;
  metrics: Metrics;
  log: Logger;
  tokens: AccessTokens;
  sessions: AuthCollections['sessions'];
  devices: DeviceCollections['devices'];
  oneTimeKeys: Collection<OneTimeKeyDoc>;
  delivery: DeliveryService;
  push: PushNotifier;
  registry: ConnectionRegistry<Connection>;
}

type ServerFrameInit = MessageInitShape<typeof ServerFrameSchema>;

/** A fixed-window frame budget. */
class FrameBudget {
  #windowStart = 0;
  #count = 0;
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  take(now: number): boolean {
    if (now - this.#windowStart >= this.windowMs) {
      this.#windowStart = now;
      this.#count = 0;
    }
    return ++this.#count <= this.limit;
  }
}

export class Connection {
  #state: 'auth' | 'open' | 'closed' = 'auth';
  #userId = '';
  #deviceId = '';
  #sessionId = '';
  /** Online deliveries waiting for this device's transport ACK. */
  readonly #waiters = new Map<string, ((acked: boolean) => void)[]>();
  /** Envelopes this connection fetched from the mailbox, until acknowledged. */
  readonly #fetched = new Map<string, EnvelopeSource>();
  /** Every envelope fetched on this connection, so none is streamed twice. */
  readonly #streamed = new Set<string>();
  readonly #ackListeners = new Set<() => void>();
  /** ACKed envelope IDs waiting for the next delete batch. */
  readonly #acks = { redis: new Set<string>(), mongo: new Set<string>() };
  #ackTimer: NodeJS.Timeout | undefined;
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #frames: FrameBudget;
  readonly #typing: FrameBudget;
  #inflightSends = 0;
  #alive = true;
  readonly #log: Logger;

  constructor(
    private readonly socket: WebSocket,
    private readonly d: GatewayDeps,
  ) {
    const { settings } = d;
    this.#frames = new FrameBudget(settings.maxFrames, settings.rateWindowMs);
    this.#typing = new FrameBudget(settings.maxTypingFrames, settings.rateWindowMs);
    this.#log = d.log.child({ component: 'gateway' });

    socket.on('message', (data, isBinary) => void this.#onMessage(data, isBinary));
    socket.on('close', () => this.#closed());
    socket.on('error', (error) => this.#log.debug({ err: error }, 'socket error'));
    socket.on('pong', () => {
      this.#alive = true;
    });
    this.#after(settings.authTimeoutMs, () => {
      if (this.#state !== 'auth') return;
      this.#error(0, 'UNAUTHENTICATED', 'no Auth frame in time');
      this.close(CLOSE_CODES.unauthenticated, 'auth timeout');
    });
  }

  get deviceId(): string {
    return this.#deviceId;
  }

  get open(): boolean {
    return this.#state === 'open';
  }

  close(code: number, reason: string): void {
    if (this.socket.readyState === this.socket.OPEN) this.socket.close(code, reason);
    this.#closed();
  }

  /** A newer socket for this device took over. */
  replaced(): void {
    this.#error(0, 'CONNECTION_REPLACED', 'a newer connection replaced this one');
    this.close(CLOSE_CODES.replaced, 'replaced');
  }

  /** The device was revoked (ADR 0008): tell the client, then close. */
  revoke(revokedAtMs: number): void {
    this.#send({
      requestId: 0,
      body: { case: 'revoked', value: { revokedAtMs: BigInt(revokedAtMs) } },
    });
    this.close(CLOSE_CODES.revoked, 'revoked');
  }

  /**
   * The online path: hands the envelope to this device and waits for its transport ACK.
   * False on timeout, when the socket closes, or when the device cannot take it now.
   */
  deliverOnline(record: EnvelopeRecord): Promise<boolean> {
    if (!this.open || !this.#deliver(record)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(record.envelopeId) ?? [];
      const timer = this.#after(this.d.mailbox.onlineAckTimeoutMs, () => settle(false));
      const settle = (acked: boolean) => {
        clearTimeout(timer);
        this.#timers.delete(timer);
        const left = (this.#waiters.get(record.envelopeId) ?? []).filter((w) => w !== settle);
        if (left.length > 0) this.#waiters.set(record.envelopeId, left);
        else this.#waiters.delete(record.envelopeId);
        resolve(acked);
      };
      waiters.push(settle);
      this.#waiters.set(record.envelopeId, waiters);
    });
  }

  /** Sends `OtkLow` when the device holds too few unclaimed one-time keys. */
  async checkKeys(): Promise<void> {
    if (!this.open) return;
    const threshold = this.d.settings.otkLowThreshold;
    const remaining = await this.d.oneTimeKeys.countDocuments(
      { deviceId: this.#deviceId },
      { limit: threshold },
    );
    if (remaining < threshold) {
      this.#send({ requestId: 0, body: { case: 'otkLow', value: { remaining } } });
    }
  }

  // Frames in

  async #onMessage(data: RawData, isBinary: boolean): Promise<void> {
    const { clock, mailbox } = this.d;
    if (!isBinary || !Buffer.isBuffer(data)) {
      this.#error(0, 'MALFORMED_FRAME', 'frames are binary protobuf');
      this.close(CLOSE_CODES.protocol, 'not a binary frame');
      return;
    }
    let frame: ClientFrame;
    try {
      frame = decodeClientFrame(new Uint8Array(data), {
        envelopeMaxBytes: mailbox.envelopeMaxBytes,
        nowMs: clock.now(),
      });
    } catch (error) {
      const code = error instanceof ProtocolError ? protocolErrorCode(error) : 'MALFORMED_FRAME';
      this.#error(0, code, 'the frame was rejected');
      if (this.#state === 'auth') this.close(CLOSE_CODES.protocol, 'bad frame');
      return;
    }
    const requestId = frame.requestId;
    if (!this.#frames.take(clock.now())) {
      this.#error(requestId, 'RATE_LIMITED', 'too many frames');
      return;
    }

    try {
      const { body } = frame;
      if (body.case === 'auth') {
        await this.#auth(requestId, body.value);
        return;
      }
      if (this.#state !== 'open') {
        this.#error(requestId, 'UNAUTHENTICATED', 'send Auth first');
        this.close(CLOSE_CODES.unauthenticated, 'unauthenticated');
        return;
      }
      switch (body.case) {
        case 'send':
          if (body.value.packet) await this.#onSend(requestId, body.value.packet);
          break;
        case 'ack':
          this.#onAck(body.value.envelopeIds);
          break;
        case 'ping':
          this.#send({ requestId, body: { case: 'pong', value: { nonce: body.value.nonce } } });
          break;
        case 'typing':
          this.#onTyping(body.value);
          break;
        case 'ephemeral':
          if (body.value.packet) await this.#onEphemeral(requestId, body.value.packet);
          break;
        case 'presence':
          // Presence arrives with the contacts features (Phase 11).
          break;
        default:
          break;
      }
    } catch (error) {
      this.#log.error({ err: error, frame: frame.body.case }, 'frame handler failed');
      this.#error(requestId, 'INTERNAL', 'internal error');
    }
  }

  async #auth(requestId: number, auth: Auth): Promise<void> {
    if (this.#state !== 'auth') {
      this.#error(requestId, 'CONFLICT', 'already authenticated');
      return;
    }
    const fail = (code: ErrorCode, message: string) => {
      this.#error(requestId, code, message);
      this.close(CLOSE_CODES.unauthenticated, 'auth failed');
    };
    if (auth.protocolVersion !== PROTOCOL_VERSION) {
      fail('PROTOCOL_VERSION_UNSUPPORTED', 'unsupported protocol version');
      return;
    }
    const { tokens, sessions, devices, clock } = this.d;
    let claims;
    try {
      claims = await tokens.verify(auth.accessToken);
    } catch (error) {
      fail(error instanceof AppError ? error.code : 'UNAUTHENTICATED', 'invalid access token');
      return;
    }
    const session = await sessions.findOne(
      {
        _id: claims.sessionId,
        userId: claims.userId,
        revokedAt: null,
        expiresAt: { $gt: new Date(clock.now()) },
      },
      { projection: { deviceId: 1 } },
    );
    if (!session) return fail('UNAUTHENTICATED', 'the session has ended');
    if (!session.deviceId) return fail('DEVICE_REQUIRED', 'the session has no device');
    const device = await devices.findOne(
      { _id: session.deviceId, userId: claims.userId, status: 'active' },
      { projection: { _id: 1 } },
    );
    if (!device) return fail('DEVICE_REVOKED', 'the device is not active');
    if (this.#state !== 'auth') return; // closed while verifying

    this.#state = 'open';
    this.#userId = claims.userId;
    this.#deviceId = session.deviceId;
    this.#sessionId = claims.sessionId;
    this.d.registry.add(this);
    this.d.metrics.wsConnections.inc();
    this.#send({
      requestId,
      body: {
        case: 'authOk',
        value: {
          userId: uuidToBytes(this.#userId),
          deviceId: uuidToBytes(this.#deviceId),
          serverTimeMs: BigInt(clock.now()),
          heartbeatIntervalMs: this.d.settings.clientPingIntervalMs,
        },
      },
    });
    this.#startTimers();
    void this.#streamPending().catch((error: unknown) =>
      this.#log.warn({ err: error }, 'mailbox fetch failed'),
    );
    void this.checkKeys().catch((error: unknown) =>
      this.#log.warn({ err: error }, 'one-time key check failed'),
    );
  }

  async #onSend(requestId: number, packet: TransportPacket): Promise<void> {
    const { delivery, registry, metrics, push } = this.d;
    if (this.#inflightSends >= this.d.settings.maxInflightSends) {
      this.#error(requestId, 'RATE_LIMITED', 'too many sends in flight');
      return;
    }
    this.#inflightSends++;
    try {
      const record = await delivery.prepare(this.#deviceId, packet);
      const recipient = registry.get(record.recipientDeviceId);
      if (recipient && (await recipient.deliverOnline(record))) {
        metrics.envelopesAccepted.inc({ path: 'online' });
        this.#accepted(requestId, packet, record, Accepted_Status.DELIVERED_TRANSPORT);
        return;
      }
      const outcome = await delivery.store(record);
      this.#accepted(requestId, packet, record, Accepted_Status.STORED);
      if (outcome !== 'duplicate') {
        push.wake(record.recipientDeviceId, (packet.flags & PacketFlag.URGENT) !== 0);
      }
    } catch (error) {
      if (!(error instanceof DeliveryError)) throw error;
      metrics.sendRejected.inc({ code: error.code });
      this.#error(requestId, error.code, error.message);
    } finally {
      this.#inflightSends--;
    }
  }

  #onAck(envelopeIds: Uint8Array[]): void {
    for (const bytes of envelopeIds) {
      const id = bytesToUuid(bytes);
      const waiters = this.#waiters.get(id);
      if (waiters) {
        // The online path stored nothing: the waiting sender gets DELIVERED_TRANSPORT.
        for (const settle of [...waiters]) settle(true);
        continue;
      }
      // Redis commands are metered, so Redis is skipped for envelopes fetched from Mongo.
      // Mongo is always asked: the migration may have copied the envelope there since it was
      // fetched. Unknown IDs (e.g. acknowledged after a reconnect) go to both stores.
      if (this.#fetched.get(id) !== 'mongo') this.#acks.redis.add(id);
      this.#acks.mongo.add(id);
    }
    if (this.#acks.mongo.size === 0 || this.#ackTimer) return;
    // ACKs that arrive close together become one delete batch (one Redis transaction).
    this.#ackTimer = setTimeout(() => void this.#flushAcks(), this.d.settings.ackCoalesceMs);
  }

  async #flushAcks(): Promise<void> {
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
    const redis = [...this.#acks.redis];
    const mongo = [...this.#acks.mongo];
    this.#acks.redis.clear();
    this.#acks.mongo.clear();
    if (mongo.length === 0) return;
    try {
      await this.d.delivery.ack(this.#deviceId, { redis, mongo });
    } finally {
      // Only now may the fetch stream read its next batch: earlier, it would re-read the
      // IDs still being deleted (wasted Redis commands).
      for (const id of mongo) this.#fetched.delete(id);
      for (const listener of [...this.#ackListeners]) listener();
    }
  }

  #onTyping(typing: Typing): void {
    if (!this.#typing.take(this.d.clock.now())) return;
    // Phase 11 limits typing to the sender's conversations; until then it is rate-limited.
    for (const bytes of typing.recipientDeviceIds) {
      const recipient = this.d.registry.get(bytesToUuid(bytes));
      if (!recipient?.open || recipient === this) continue;
      recipient.#sendIfRoom({
        requestId: 0,
        body: {
          case: 'typing',
          value: {
            recipientDeviceIds: [],
            senderDeviceId: uuidToBytes(this.#deviceId),
            ...(typing.groupId ? { groupId: typing.groupId } : {}),
            active: typing.active,
          },
        },
      });
    }
  }

  /** Relayed to an online recipient only, never stored (ARCHITECTURE A4). */
  async #onEphemeral(requestId: number, packet: TransportPacket): Promise<void> {
    try {
      const record = await this.d.delivery.prepare(this.#deviceId, packet);
      const recipient = this.d.registry.get(record.recipientDeviceId);
      const sent = recipient?.open
        ? recipient.#sendIfRoom({ requestId: 0, body: { case: 'ephemeral', value: { packet } } })
        : false;
      if (!sent) this.#error(requestId, 'RECIPIENT_OFFLINE', 'the recipient device is offline');
    } catch (error) {
      if (!(error instanceof DeliveryError)) throw error;
      this.#error(requestId, error.code, error.message);
    }
  }

  // Mailbox fetch

  /** Streams pending mail in batches; each next batch waits for the previous one's ACKs. */
  async #streamPending(): Promise<void> {
    const { delivery, mailbox, settings } = this.d;
    while (this.open) {
      const batch = (await delivery.pending(this.#deviceId, mailbox.fetchBatchSize)).filter(
        (envelope) => !this.#streamed.has(envelope.envelopeId),
      );
      if (batch.length === 0) return;
      const sent: string[] = [];
      for (const envelope of batch) {
        if (!(await this.#drained())) return;
        this.#streamed.add(envelope.envelopeId);
        if (!this.#deliver(envelope)) continue;
        this.#fetched.set(envelope.envelopeId, envelope.source);
        sent.push(envelope.envelopeId);
      }
      // A client that stops acknowledging gets the rest on its next connection.
      if (!(await this.#acked(sent, settings.fetchAckTimeoutMs))) return;
    }
  }

  /** Resolves true once none of `ids` is awaiting an ACK, false on timeout or close. */
  async #acked(ids: readonly string[], timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (ids.some((id) => this.#fetched.has(id))) {
      const left = deadline - Date.now();
      if (!this.open || left <= 0) return false;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#ackListeners.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.#ackListeners.add(done);
      });
    }
    return true;
  }

  /** Waits (up to 10 s) for the socket's send buffer to fall below the limit. */
  async #drained(): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    while (this.socket.bufferedAmount > this.d.settings.maxBufferedBytes) {
      if (!this.open || Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return this.open;
  }

  // Frames out

  /** Sends `Deliver`; false when the packet expired or the socket cannot take it. */
  #deliver(record: EnvelopeRecord): boolean {
    let packet: TransportPacket;
    try {
      packet = decodeTransportPacket(record.packet, {
        envelopeMaxBytes: this.d.mailbox.envelopeMaxBytes,
        nowMs: this.d.clock.now(),
      });
    } catch {
      return false; // expired in transit; the migration or reaper deletes it
    }
    return this.#send({ requestId: 0, body: { case: 'deliver', value: { packet } } });
  }

  #accepted(
    requestId: number,
    packet: TransportPacket,
    record: EnvelopeRecord,
    status: Accepted_Status,
  ): void {
    this.#send({
      requestId,
      body: {
        case: 'accepted',
        value: { packetId: packet.packetId, envelopeId: uuidToBytes(record.envelopeId), status },
      },
    });
  }

  #error(requestId: number, code: ErrorCode, message: string): void {
    this.#send({
      requestId,
      body: { case: 'error', value: { code, retryable: RETRYABLE_ERROR_CODES.has(code), message } },
    });
  }

  /** For best-effort frames (typing, ephemeral): dropped when the reader is behind. */
  #sendIfRoom(frame: ServerFrameInit): boolean {
    if (this.socket.bufferedAmount > this.d.settings.maxBufferedBytes) return false;
    return this.#send(frame);
  }

  #send(frame: ServerFrameInit): boolean {
    if (this.socket.readyState !== this.socket.OPEN) return false;
    try {
      this.socket.send(
        encodeServerFrame(create(ServerFrameSchema, frame), {
          envelopeMaxBytes: this.d.mailbox.envelopeMaxBytes,
          nowMs: this.d.clock.now(),
        }),
      );
      return true;
    } catch (error) {
      this.#log.warn({ err: error, frame: frame.body?.case }, 'frame not sent');
      return false;
    }
  }

  // Lifecycle

  #startTimers(): void {
    const { settings } = this.d;
    this.#every(settings.serverPingIntervalMs, () => {
      if (!this.#alive) {
        this.socket.terminate();
        this.#closed();
        return;
      }
      this.#alive = false;
      this.socket.ping();
    });
    this.#every(settings.sessionRecheckMs, () => {
      void this.d.sessions
        .findOne(
          {
            _id: this.#sessionId,
            revokedAt: null,
            expiresAt: { $gt: new Date(this.d.clock.now()) },
          },
          { projection: { _id: 1 } },
        )
        .then((session) => {
          if (session || !this.open) return;
          this.#error(0, 'UNAUTHENTICATED', 'the session has ended');
          this.close(CLOSE_CODES.unauthenticated, 'session ended');
        })
        .catch((error: unknown) => this.#log.warn({ err: error }, 'session re-check failed'));
    });
  }

  #after(ms: number, run: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      run();
    }, ms);
    timer.unref();
    this.#timers.add(timer);
    return timer;
  }

  #every(ms: number, run: () => void): void {
    const timer = setInterval(run, ms);
    timer.unref();
    this.#timers.add(timer);
  }

  #closed(): void {
    if (this.#state === 'closed') return;
    const wasOpen = this.#state === 'open';
    this.#state = 'closed';
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    // Senders waiting on this device fall back to the offline path.
    for (const waiters of [...this.#waiters.values()])
      for (const settle of [...waiters]) settle(false);
    for (const listener of [...this.#ackListeners]) listener();
    // Acknowledged before the socket closed: still deleted.
    void this.#flushAcks().catch((error: unknown) =>
      this.#log.warn({ err: error }, 'ack flush failed'),
    );
    if (wasOpen) {
      this.d.registry.remove(this);
      this.d.metrics.wsConnections.dec();
    }
  }
}
