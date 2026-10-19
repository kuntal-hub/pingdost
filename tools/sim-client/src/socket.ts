/** A gateway client on Node's built-in WebSocket, speaking the protobuf frames. */
import { randomBytes, randomUUID } from 'node:crypto';

import {
  bytesToUuid,
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
  type MessageInitShape,
  type ServerFrame,
  type TransportPacket,
} from '@pingdost/protocol';

type ClientFrameInit = MessageInitShape<typeof ClientFrameSchema>;

/** A packet with random bytes as "ciphertext", from one device to another. */
export function fakeEnvelope(
  from: string,
  to: string,
  messageId: string = randomUUID(),
): { packet: TransportPacket; envelopeId: string } {
  const envelopeId = envelopeIdFor(uuidToBytes(messageId), uuidToBytes(to));
  const now = Date.now();
  const packet = create(TransportPacketSchema, {
    version: PROTOCOL_VERSION,
    packetId: uuidv7Bytes(),
    kind: PacketKind.ENVELOPE,
    dst: uuidToBytes(to),
    createdAtMs: BigInt(now),
    expiresAtMs: BigInt(now + 14 * 86_400_000),
    payload: encodeEnvelope(
      create(EnvelopeSchema, {
        envelopeId,
        senderDeviceId: uuidToBytes(from),
        recipientDeviceId: uuidToBytes(to),
        cryptoType: CryptoType.OLM,
        ciphertext: new Uint8Array(randomBytes(256)),
      }),
    ),
  });
  return { packet, envelopeId: bytesToUuid(envelopeId) };
}

export class SimSocket {
  readonly #frames: ServerFrame[] = [];
  readonly #listeners = new Set<() => void>();
  #requestId = 0;
  #closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('message', (event) => {
      this.#frames.push(decodeServerFrame(new Uint8Array(event.data as ArrayBuffer)));
      this.#notify();
    });
    ws.addEventListener('close', () => {
      this.#closed = true;
      this.#notify();
    });
  }

  /** Opens a socket and authenticates with a device-bound access token. */
  static async connect(url: string, accessToken: string): Promise<SimSocket> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error(`cannot connect to ${url}`)), {
        once: true,
      });
    });
    const socket = new SimSocket(ws);
    const requestId = socket.send({
      body: { case: 'auth', value: { accessToken, protocolVersion: PROTOCOL_VERSION } },
    });
    const reply = await socket.take((frame) => frame.requestId === requestId, 5_000);
    if (reply?.body.case !== 'authOk') {
      throw new Error(
        `auth failed: ${reply?.body.case === 'error' ? reply.body.value.code : 'no reply'}`,
      );
    }
    return socket;
  }

  send(frame: ClientFrameInit): number {
    const requestId = frame.requestId ?? ++this.#requestId;
    // Copied into a plain ArrayBuffer-backed view, as the DOM WebSocket type wants.
    this.ws.send(
      new Uint8Array(encodeClientFrame(create(ClientFrameSchema, { ...frame, requestId }))),
    );
    return requestId;
  }

  /** Sends one envelope and resolves with the server's answer. */
  async sendEnvelope(packet: TransportPacket): Promise<ServerFrame['body']> {
    const requestId = this.send({ body: { case: 'send', value: { packet } } });
    const reply = await this.take((frame) => frame.requestId === requestId, 10_000);
    if (!reply) throw new Error('no reply to Send');
    return reply.body;
  }

  ack(envelopeIds: readonly string[]): void {
    this.send({
      requestId: 0,
      body: { case: 'ack', value: { envelopeIds: envelopeIds.map((id) => uuidToBytes(id)) } },
    });
  }

  /** Delivered envelope IDs, until none arrives for `quietMs`; each one is acknowledged. */
  async drain(quietMs: number): Promise<string[]> {
    const ids: string[] = [];
    for (;;) {
      const frame = await this.take((candidate) => candidate.body.case === 'deliver', quietMs);
      if (frame?.body.case !== 'deliver' || !frame.body.value.packet) return ids;
      const id = bytesToUuid(decodeEnvelope(frame.body.value.packet.payload).envelopeId);
      ids.push(id);
      this.ack([id]);
    }
  }

  async take(match: (frame: ServerFrame) => boolean, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.#frames.findIndex(match);
      if (index >= 0) return this.#frames.splice(index, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0 || this.#closed) return undefined;
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.#listeners.delete(done);
          resolve();
        };
        const timer = setTimeout(done, left);
        this.#listeners.add(done);
      });
    }
  }

  close(): void {
    this.ws.close();
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
