/**
 * The Internet transport: one authenticated gateway WebSocket per device (ARCHITECTURE A3, A4;
 * ADR 0010). It uses only the standard `WebSocket` API, so it runs unchanged in React Native,
 * browsers and Node (which has had a global `WebSocket` since v22, so no `ws` shim is needed).
 *
 * - The first frame is `Auth`; the transport is `online` after `AuthOk`.
 * - Every `send` is answered by one `Accepted` or `ServerError` with the same request ID.
 * - After `AuthOk` the server streams the device's pending mail by itself, so a reconnect
 *   resumes the fetch; the engine resends its outbox when the status turns `online`.
 * - Reconnects back off exponentially with jitter. Close codes: 4001 refreshes the token,
 *   4002 (a newer socket of this device took over) and 4003 (revoked) stop for good, 4008
 *   backs off further.
 * - It pings while idle and reconnects when the server falls silent.
 * Tokens and payloads are never logged (ARCHITECTURE A10).
 */
import {
  Accepted_Status,
  bytesToUuid,
  ClientFrameSchema,
  create,
  decodeEnvelope,
  decodeServerFrame,
  encodeClientFrame,
  PROTOCOL_VERSION,
  ProtocolError,
  uuidToBytes,
  type MessageInitShape,
  type ServerFrame,
  type TransportPacket,
} from '@pingdost/protocol';

import { backoffDelay, type BackoffOptions } from './backoff';
import { Listeners, ValueStream } from './stream';
import type {
  PacketListener,
  SendResult,
  Transport,
  TransportStatus,
  TypingSignal,
  Unsubscribe,
} from './types';

/** The part of the standard `WebSocket` this transport uses. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

/** The gateway's application close codes (ADR 0010). */
export const WS_CLOSE_CODES = {
  unauthenticated: 4001,
  replaced: 4002,
  revoked: 4003,
  overloaded: 4008,
  protocol: 1002,
} as const;

const OPEN = 1;
/** Close code for a socket this client gives up on (heartbeat or auth timeout). */
const CLIENT_GAVE_UP = 4000;

export type WsEvent =
  | { type: 'connected'; userId: string; deviceId: string; serverTimeMs: number }
  | { type: 'disconnected'; code: number }
  /** The server holds too few of this device's one-time keys: upload more. */
  | { type: 'otk_low'; remaining: number }
  /** This device was revoked: sign out and wipe local data. The transport has stopped. */
  | { type: 'revoked' }
  /** A newer socket of this device took over. The transport has stopped; do not fight it. */
  | { type: 'replaced' }
  /** `Auth` was rejected with this code (the transport retries or refreshes). */
  | { type: 'auth_failed'; code: string };

export interface WsTransportOptions {
  /** `ws(s)://<host>/v1/ws`. */
  url: string;
  /** The current device-bound access token. Secret: never logged. */
  getAccessToken(): string | undefined | Promise<string | undefined>;
  /** After close code 4001: refresh the tokens; true once new ones are stored. */
  refreshToken?(): Promise<boolean>;
  /** Defaults to the global `WebSocket`. */
  createSocket?: WebSocketFactory;
  /** Reconnect delays; default 1 s doubling to 60 s, with jitter. */
  backoff?: BackoffOptions;
  /** How long `AuthOk` may take; default 10 s. */
  authTimeoutMs?: number;
  /** How long a `Send` may wait for its answer; default 15 s. */
  sendTimeoutMs?: number;
  /** ACKs within this window go out as one frame; default 20 ms. */
  ackDelayMs?: number;
  /** `ENVELOPE_MAX_BYTES` as the server enforces it. */
  envelopeMaxBytes?: number;
  now?: () => number;
}

interface PendingSend {
  resolve(result: SendResult): void;
  timer: ReturnType<typeof setTimeout>;
}

type ClientFrameInit = MessageInitShape<typeof ClientFrameSchema>;

function defaultSocket(url: string): WebSocketLike {
  const Socket = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Socket) throw new Error('no global WebSocket: pass createSocket');
  return new Socket(url);
}

const OFFLINE: SendResult = { ok: false, code: 'OFFLINE', retryable: true };

export class WsTransport implements Transport {
  readonly kind = 'internet' as const;
  readonly status$ = new ValueStream<TransportStatus>('offline');

  readonly #options: WsTransportOptions;
  readonly #createSocket: WebSocketFactory;
  readonly #now: () => number;
  readonly #packets = new Listeners<Parameters<PacketListener>>();
  readonly #typing = new Listeners<[TypingSignal]>();
  readonly #events = new Listeners<[WsEvent]>();

  #wanted = false;
  #socket: WebSocketLike | undefined;
  #attempt = 0;
  #requestId = 0;
  #authRequestId = 0;
  /** The code of a `ServerError` that answered `Auth`, until the socket closes. */
  #authError: string | undefined;
  readonly #pending = new Map<number, PendingSend>();
  #acks: Uint8Array[] = [];
  #ackTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #authTimer: ReturnType<typeof setTimeout> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #heartbeatMs = 25_000;
  #lastSentAt = 0;
  #lastReceivedAt = 0;

  constructor(options: WsTransportOptions) {
    this.#options = options;
    this.#createSocket = options.createSocket ?? defaultSocket;
    this.#now = options.now ?? Date.now;
  }

  get status(): TransportStatus {
    return this.status$.value;
  }

  /** Connects, and keeps reconnecting until `stop()`. */
  start(): void {
    if (this.#wanted) return;
    this.#wanted = true;
    this.#attempt = 0;
    void this.#connect();
  }

  /** Disconnects and stops reconnecting. Sends still waiting resolve as `OFFLINE`. */
  stop(): void {
    this.#wanted = false;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    const socket = this.#socket;
    this.#teardown();
    socket?.close(1000, 'stopped');
    this.status$.set('offline');
  }

  /** Reconnects now instead of waiting out the backoff (e.g. the network came back). */
  reconnectNow(): void {
    if (!this.#wanted || this.#socket) return;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#attempt = 0;
    void this.#connect();
  }

  onPacket(listener: PacketListener): Unsubscribe {
    return this.#packets.add(listener);
  }

  onTyping(listener: (typing: TypingSignal) => void): Unsubscribe {
    return this.#typing.add(listener);
  }

  onEvent(listener: (event: WsEvent) => void): Unsubscribe {
    return this.#events.add(listener);
  }

  send(packet: TransportPacket): Promise<SendResult> {
    if (this.status !== 'online') return Promise.resolve(OFFLINE);
    const requestId = this.#nextRequestId();
    return new Promise<SendResult>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        resolve({ ok: false, code: 'TIMEOUT', retryable: true });
      }, this.#options.sendTimeoutMs ?? 15_000);
      this.#pending.set(requestId, { resolve, timer });
      const sent = this.#sendFrame({ requestId, body: { case: 'send', value: { packet } } });
      if (sent !== true) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        resolve(sent);
      }
    });
  }

  sendTyping(typing: TypingSignal): boolean {
    if (this.status !== 'online' || typing.recipientDeviceIds.length === 0) return false;
    return (
      this.#sendFrame({
        requestId: 0,
        body: {
          case: 'typing',
          value: {
            recipientDeviceIds: typing.recipientDeviceIds.map((id) => uuidToBytes(id)),
            ...(typing.groupId ? { groupId: uuidToBytes(typing.groupId) } : {}),
            active: typing.active,
          },
        },
      }) === true
    );
  }

  // Connection

  async #connect(): Promise<void> {
    if (!this.#wanted || this.#socket) return;
    this.status$.set('connecting');
    let token: string | undefined;
    try {
      token = await this.#options.getAccessToken();
    } catch {
      token = undefined;
    }
    if (!this.#wanted || this.#socket) return;
    if (!token) {
      this.#scheduleReconnect();
      return;
    }

    let socket: WebSocketLike;
    try {
      socket = this.#createSocket(this.#options.url);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    this.#authError = undefined;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => {
      if (socket !== this.#socket) return;
      this.#authRequestId = this.#nextRequestId();
      this.#sendFrame({
        requestId: this.#authRequestId,
        body: { case: 'auth', value: { accessToken: token, protocolVersion: PROTOCOL_VERSION } },
      });
    };
    socket.onmessage = (event) => {
      if (socket === this.#socket) this.#onMessage(event.data);
    };
    socket.onclose = (event) => {
      if (socket === this.#socket) void this.#onClose(event.code);
    };
    socket.onerror = () => {
      // A close event always follows.
    };
    this.#authTimer = setTimeout(() => {
      if (socket === this.#socket && this.status !== 'online') this.#giveUp(socket, 'auth timeout');
    }, this.#options.authTimeoutMs ?? 10_000);
  }

  #onMessage(data: unknown): void {
    if (!(data instanceof ArrayBuffer)) return; // frames are binary protobuf
    this.#lastReceivedAt = this.#now();
    let frame: ServerFrame;
    try {
      frame = decodeServerFrame(new Uint8Array(data), this.#codecOptions());
    } catch {
      return; // e.g. a Deliver that expired in flight: the mailbox drops it
    }
    const { body } = frame;
    switch (body.case) {
      case 'authOk':
        if (frame.requestId === this.#authRequestId) this.#authenticated(body.value);
        break;
      case 'accepted': {
        const status =
          body.value.status === Accepted_Status.DELIVERED_TRANSPORT
            ? 'delivered_transport'
            : 'stored';
        this.#settle(frame.requestId, { ok: true, status });
        break;
      }
      case 'error':
        if (frame.requestId !== 0 && frame.requestId === this.#authRequestId) {
          this.#authError = body.value.code;
          this.#events.emit({ type: 'auth_failed', code: body.value.code });
        } else {
          this.#settle(frame.requestId, {
            ok: false,
            code: body.value.code,
            retryable: body.value.retryable,
          });
        }
        break;
      case 'deliver': {
        const packet = body.value.packet;
        if (!packet) break;
        let acked = false;
        this.#packets.emit(packet, () => {
          if (acked) return;
          acked = true;
          this.#queueAck(packet);
        });
        break;
      }
      case 'typing':
        this.#typing.emit({
          recipientDeviceIds: [],
          senderDeviceId: bytesToUuid(body.value.senderDeviceId),
          ...(body.value.groupId ? { groupId: bytesToUuid(body.value.groupId) } : {}),
          active: body.value.active,
        });
        break;
      case 'otkLow':
        this.#events.emit({ type: 'otk_low', remaining: body.value.remaining });
        break;
      case 'revoked':
        this.#stopFor('revoked');
        break;
      default:
        // Pong only refreshes the liveness clock; Presence and Ephemeral arrive in later phases.
        break;
    }
  }

  #authenticated(ok: {
    userId: Uint8Array;
    deviceId: Uint8Array;
    serverTimeMs: bigint;
    heartbeatIntervalMs: number;
  }): void {
    clearTimeout(this.#authTimer);
    this.#attempt = 0;
    this.#heartbeatMs = ok.heartbeatIntervalMs > 0 ? ok.heartbeatIntervalMs : 25_000;
    this.#lastReceivedAt = this.#now();
    this.#startHeartbeat();
    this.status$.set('online');
    this.#events.emit({
      type: 'connected',
      userId: bytesToUuid(ok.userId),
      deviceId: bytesToUuid(ok.deviceId),
      serverTimeMs: Number(ok.serverTimeMs),
    });
  }

  async #onClose(code: number): Promise<void> {
    const authError = this.#authError;
    this.#teardown();
    this.status$.set('offline');
    this.#events.emit({ type: 'disconnected', code });
    if (!this.#wanted) return;

    if (code === WS_CLOSE_CODES.replaced) {
      this.#stopFor('replaced');
      return;
    }
    if (code === WS_CLOSE_CODES.revoked || authError === 'DEVICE_REVOKED') {
      this.#stopFor('revoked');
      return;
    }
    if (code === WS_CLOSE_CODES.unauthenticated && this.#options.refreshToken) {
      const refreshed = await this.#options.refreshToken().catch(() => false);
      if (refreshed && this.#wanted) {
        this.#attempt = 0;
        void this.#connect();
        return;
      }
    }
    // An overloaded server gets a longer pause.
    if (code === WS_CLOSE_CODES.overloaded) this.#attempt += 3;
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (!this.#wanted) return;
    this.status$.set('offline');
    this.#attempt++;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(
      () => {
        this.#reconnectTimer = undefined;
        void this.#connect();
      },
      backoffDelay(this.#attempt, this.#options.backoff),
    );
  }

  #stopFor(reason: 'revoked' | 'replaced'): void {
    this.stop();
    this.#events.emit({ type: reason });
  }

  #giveUp(socket: WebSocketLike, reason: string): void {
    try {
      socket.close(CLIENT_GAVE_UP, reason);
    } finally {
      // Some WebSocket implementations fire no close event for a socket that never opened.
      if (socket === this.#socket) void this.#onClose(CLIENT_GAVE_UP);
    }
  }

  /** Clears the socket's timers and answers every waiting send as `OFFLINE`. */
  #teardown(): void {
    clearTimeout(this.#authTimer);
    clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
    this.#flushAcks();
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
    this.#acks = [];
    const socket = this.#socket;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    }
    this.#socket = undefined;
    for (const [requestId, pending] of [...this.#pending]) {
      clearTimeout(pending.timer);
      this.#pending.delete(requestId);
      pending.resolve(OFFLINE);
    }
  }

  #startHeartbeat(): void {
    clearInterval(this.#heartbeat);
    const interval = this.#heartbeatMs;
    this.#heartbeat = setInterval(
      () => {
        const socket = this.#socket;
        if (!socket) return;
        const now = this.#now();
        // Missed two heartbeats and a margin: the connection is dead even if no close came.
        if (now - this.#lastReceivedAt > interval * 2 + 10_000) {
          this.#giveUp(socket, 'heartbeat timeout');
          return;
        }
        if (now - this.#lastSentAt >= interval) {
          this.#sendFrame({
            requestId: this.#nextRequestId(),
            body: { case: 'ping', value: { nonce: 0 } },
          });
        }
      },
      Math.max(1_000, Math.floor(interval / 2)),
    );
  }

  // Frames out

  #queueAck(packet: TransportPacket): void {
    let envelopeId: Uint8Array;
    try {
      envelopeId = decodeEnvelope(packet.payload, this.#codecOptions()).envelopeId;
    } catch {
      return; // the server checked the envelope before delivering it
    }
    this.#acks.push(envelopeId);
    if (this.#acks.length >= 50) {
      this.#flushAcks();
      return;
    }
    this.#ackTimer ??= setTimeout(() => this.#flushAcks(), this.#options.ackDelayMs ?? 20);
  }

  #flushAcks(): void {
    clearTimeout(this.#ackTimer);
    this.#ackTimer = undefined;
    if (this.#acks.length === 0) return;
    const envelopeIds = this.#acks;
    this.#acks = [];
    // Lost if the socket closed meanwhile: the mailbox redelivers and the engine dedupes.
    this.#sendFrame({ requestId: 0, body: { case: 'ack', value: { envelopeIds } } });
  }

  #settle(requestId: number, result: SendResult): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#pending.delete(requestId);
    pending.resolve(result);
  }

  /** True when sent; otherwise why not, as a send result. */
  #sendFrame(frame: ClientFrameInit): true | SendResult {
    const socket = this.#socket;
    if (!socket || socket.readyState !== OPEN) return OFFLINE;
    let bytes: Uint8Array;
    try {
      bytes = encodeClientFrame(create(ClientFrameSchema, frame), this.#codecOptions());
    } catch (error) {
      const code =
        error instanceof ProtocolError
          ? error.code === 'EXPIRED'
            ? 'ENVELOPE_EXPIRED'
            : error.code === 'OVERSIZED'
              ? 'ENVELOPE_TOO_LARGE'
              : 'MALFORMED_FRAME'
          : 'MALFORMED_FRAME';
      return { ok: false, code, retryable: false };
    }
    try {
      // A copy backed by a plain ArrayBuffer, as every WebSocket implementation accepts.
      socket.send(new Uint8Array(bytes).buffer);
    } catch {
      return OFFLINE;
    }
    this.#lastSentAt = this.#now();
    return true;
  }

  #nextRequestId(): number {
    this.#requestId = this.#requestId >= 0xffff_fffe ? 1 : this.#requestId + 1;
    return this.#requestId;
  }

  #codecOptions(): { envelopeMaxBytes?: number; nowMs: number } {
    const { envelopeMaxBytes } = this.#options;
    return { ...(envelopeMaxBytes ? { envelopeMaxBytes } : {}), nowMs: this.#now() };
  }
}
