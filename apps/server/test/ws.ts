/**
 * WebSocket test client over `app.injectWS` (no network port), plus device and envelope
 * builders. Envelopes carry random bytes as "ciphertext": the server must never look inside.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import type WebSocket from 'ws';

import type { CryptoProvider } from '@pingdost/crypto';
import {
  ClientFrameSchema,
  create,
  CryptoType,
  decodeEnvelope,
  decodeServerFrame,
  encodeClientFrame,
  encodeEnvelope,
  EnvelopeSchema,
  envelopeIdFor,
  PacketKind,
  PROTOCOL_VERSION,
  TransportPacketSchema,
  uuidToBytes,
  uuidv7Bytes,
  bytesToUuid,
  type MessageInitShape,
  type ServerFrame,
  type TransportPacket,
} from '@pingdost/protocol';

import { newDevice, registerDevice, type TestDevice } from './devices';
import { registeredUser, type TestServer } from './helpers';

type ClientFrameInit = MessageInitShape<typeof ClientFrameSchema>;
type Body = ServerFrame['body'];
/** Server frame body values by their oneof case. */
type Frames = { [B in Exclude<Body, { case: undefined }> as B['case']]: B['value'] };
type Case = keyof Frames;
export type FrameOf<C extends Case> = Frames[C];

export interface TestDeviceSession {
  userId: string;
  deviceId: string;
  accessToken: string;
  /** The device's Olm account, to sign keys. */
  device: TestDevice;
}

/** A verified user with one registered primary device and a device-bound token. */
export async function deviceSession(
  server: TestServer,
  crypto: CryptoProvider,
): Promise<TestDeviceSession> {
  const session = await registeredUser(server);
  const device = newDevice(crypto);
  const { tokens } = await registerDevice(
    server,
    session.accessToken,
    device,
    crypto.createSigningKey(),
  );
  return {
    userId: session.userId,
    deviceId: device.deviceId,
    accessToken: tokens.accessToken,
    device,
  };
}

export interface EnvelopeOptions {
  messageId?: string;
  ttlMs?: number;
  ciphertext?: Uint8Array;
  /** Overrides the envelope's sender (to test spoofing). */
  senderDeviceId?: string;
  kind?: PacketKind;
  /** Group traffic: a Megolm envelope for this group (ADR 0016). */
  groupId?: string;
}

/** A TransportPacket holding an Envelope from `from` to `to`, and its envelope ID. */
export function envelopePacket(
  server: TestServer,
  from: string,
  to: string,
  options: EnvelopeOptions = {},
): { packet: TransportPacket; envelopeId: string; messageId: string } {
  const now = server.clock.now();
  const messageId = options.messageId ?? randomUUID();
  const envelopeId = envelopeIdFor(uuidToBytes(messageId), uuidToBytes(to));
  const envelope = create(EnvelopeSchema, {
    envelopeId,
    senderDeviceId: uuidToBytes(options.senderDeviceId ?? from),
    recipientDeviceId: uuidToBytes(to),
    cryptoType: options.groupId ? CryptoType.MEGOLM : CryptoType.OLM,
    ...(options.groupId
      ? { groupId: uuidToBytes(options.groupId), megolmSessionId: 'test-session' }
      : {}),
    ciphertext: options.ciphertext ?? new Uint8Array(randomBytes(200)),
  });
  const packet = create(TransportPacketSchema, {
    version: PROTOCOL_VERSION,
    packetId: uuidv7Bytes(),
    kind: options.kind ?? PacketKind.ENVELOPE,
    dst: uuidToBytes(to),
    createdAtMs: BigInt(now),
    expiresAtMs: BigInt(now + (options.ttlMs ?? 30 * 86_400_000)),
    hopBudget: 0,
    flags: 0,
    payload: encodeEnvelope(envelope),
  });
  return { packet, envelopeId: bytesToUuid(envelopeId), messageId };
}

export class TestSocket {
  readonly #frames: ServerFrame[] = [];
  readonly #listeners = new Set<() => void>();
  #requestId = 0;
  closeCode: number | undefined;

  private constructor(
    readonly ws: WebSocket,
    private readonly server: TestServer,
  ) {
    ws.on('message', (data: Buffer) => {
      this.#frames.push(
        decodeServerFrame(new Uint8Array(data), { nowMs: this.server.clock.now() }),
      );
      for (const listener of [...this.#listeners]) listener();
    });
    ws.on('close', (code: number) => {
      this.closeCode = code;
      for (const listener of [...this.#listeners]) listener();
    });
  }

  static async open(server: TestServer): Promise<TestSocket> {
    return new TestSocket(await server.app.injectWS('/v1/ws'), server);
  }

  /** Opens a socket and authenticates; returns it once `AuthOk` arrived. */
  static async connect(server: TestServer, session: TestDeviceSession): Promise<TestSocket> {
    const socket = await TestSocket.open(server);
    const requestId = socket.send({
      body: {
        case: 'auth',
        value: { accessToken: session.accessToken, protocolVersion: PROTOCOL_VERSION },
      },
    });
    await socket.next('authOk', { requestId });
    return socket;
  }

  /**
   * Sends a frame and returns its request ID. 
owMs is the client's clock for the codec's
   * expiry check (default: the server's test clock).
   */
  send(frame: ClientFrameInit, nowMs = this.server.clock.now()): number {
    const requestId = frame.requestId ?? ++this.#requestId;
    this.ws.send(encodeClientFrame(create(ClientFrameSchema, { ...frame, requestId }), { nowMs }));
    return requestId;
  }

  sendPacket(packet: TransportPacket, nowMs?: number): number {
    return this.send({ body: { case: 'send', value: { packet } } }, nowMs);
  }

  ack(envelopeIds: readonly string[]): void {
    this.send({
      requestId: 0,
      body: { case: 'ack', value: { envelopeIds: envelopeIds.map((id) => uuidToBytes(id)) } },
    });
  }

  /** The next frame of `kind` (and request ID), removed from the buffer. */
  next<C extends Case>(
    kind: C,
    options: { requestId?: number; timeoutMs?: number } = {},
  ): Promise<FrameOf<C>> {
    return this.#take(
      (frame) =>
        frame.body.case === kind &&
        (options.requestId === undefined || frame.requestId === options.requestId),
      options.timeoutMs ?? 5_000,
    ).then((found) => {
      if (!found) throw new Error(`no ${kind} frame within the timeout`);
      return found.body.value as FrameOf<C>;
    });
  }

  /** The answer to `requestId`: `Accepted` or `ServerError`. */
  async reply(requestId: number, timeoutMs = 5_000): Promise<ServerFrame['body']> {
    const found = await this.#take(
      (frame) =>
        frame.requestId === requestId &&
        (frame.body.case === 'accepted' || frame.body.case === 'error'),
      timeoutMs,
    );
    if (!found) throw new Error(`no reply to request ${requestId}`);
    return found.body;
  }

  /** Envelope IDs of every `Deliver` that arrives within `windowMs`. */
  async delivered(windowMs: number): Promise<string[]> {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    const ids: string[] = [];
    for (let i = this.#frames.length - 1; i >= 0; i--) {
      const frame = this.#frames[i];
      if (frame?.body.case !== 'deliver') continue;
      this.#frames.splice(i, 1);
      ids.unshift(envelopeIdOf(frame.body.value.packet));
    }
    return ids;
  }

  /** Resolves with the close code once the server closes the socket. */
  async closed(timeoutMs = 5_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === undefined) {
      if (Date.now() > deadline) throw new Error('the socket did not close');
      await this.#wait(deadline - Date.now());
    }
    return this.closeCode;
  }

  close(): void {
    this.ws.terminate();
  }

  async #take(match: (frame: ServerFrame) => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.#frames.findIndex(match);
      if (index >= 0) return this.#frames.splice(index, 1)[0];
      if (Date.now() >= deadline || this.closeCode !== undefined) return undefined;
      await this.#wait(deadline - Date.now());
    }
  }

  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#listeners.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.#listeners.add(done);
    });
  }
}

/** The envelope ID inside a delivered packet. */
export function envelopeIdOf(packet: TransportPacket | undefined): string {
  if (!packet) throw new Error('no packet');
  return bytesToUuid(decodeEnvelope(packet.payload).envelopeId);
}
