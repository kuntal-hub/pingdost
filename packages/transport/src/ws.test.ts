import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  Accepted_Status,
  create,
  CryptoType,
  decodeClientFrame,
  encodeEnvelope,
  encodeServerFrame,
  EnvelopeSchema,
  PacketKind,
  PROTOCOL_VERSION,
  ServerFrameSchema,
  TransportPacketSchema,
  uuidToBytes,
  uuidv7,
  uuidv7Bytes,
  type ClientFrame,
  type MessageInitShape,
  type TransportPacket,
} from '@pingdost/protocol';

import { backoffDelay } from './backoff';
import { TransportRouter } from './router';
import { ValueStream } from './stream';
import type { Transport, TransportStatus } from './types';
import { WsTransport, type WebSocketLike, type WsEvent } from './ws';

const USER_ID = uuidv7();
const DEVICE_ID = uuidv7();

/** An in-memory socket; the test plays the gateway. */
class FakeSocket implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  readonly frames: ClientFrame[] = [];
  closedWith: number | undefined;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data: ArrayBuffer): void {
    this.frames.push(decodeClientFrame(new Uint8Array(data)));
  }

  close(code = 1000): void {
    this.closedWith = code;
    this.serverClose(code);
  }

  /** The server closes the socket. */
  serverClose(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }

  reply(frame: MessageInitShape<typeof ServerFrameSchema>): void {
    this.onmessage?.({
      data: new Uint8Array(encodeServerFrame(create(ServerFrameSchema, frame))).buffer,
    });
  }

  authOk(heartbeatIntervalMs = 25_000): void {
    const auth = this.frames.find((frame) => frame.body.case === 'auth');
    this.reply({
      requestId: auth?.requestId ?? 0,
      body: {
        case: 'authOk',
        value: {
          userId: uuidToBytes(USER_ID),
          deviceId: uuidToBytes(DEVICE_ID),
          serverTimeMs: BigInt(Date.now()),
          heartbeatIntervalMs,
        },
      },
    });
  }
}

const sockets: FakeSocket[] = [];
const transports: WsTransport[] = [];

function transport(options: Partial<ConstructorParameters<typeof WsTransport>[0]> = {}) {
  const ws = new WsTransport({
    url: 'ws://test/v1/ws',
    getAccessToken: () => 'token',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    backoff: { baseMs: 5, maxMs: 20 },
    ...options,
  });
  transports.push(ws);
  return ws;
}

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Starts a transport and completes the handshake on its socket. */
async function online(ws: WsTransport, heartbeatIntervalMs?: number): Promise<FakeSocket> {
  const count = sockets.length;
  ws.start();
  await until(() => sockets.length > count);
  const socket = sockets.at(-1)!;
  socket.open();
  socket.authOk(heartbeatIntervalMs);
  await until(() => ws.status === 'online');
  return socket;
}

function envelopePacket(): TransportPacket {
  const now = Date.now();
  return create(TransportPacketSchema, {
    version: PROTOCOL_VERSION,
    packetId: uuidv7Bytes(),
    kind: PacketKind.ENVELOPE,
    dst: uuidToBytes(DEVICE_ID),
    createdAtMs: BigInt(now),
    expiresAtMs: BigInt(now + 60_000),
    payload: encodeEnvelope(
      create(EnvelopeSchema, {
        envelopeId: uuidv7Bytes(),
        senderDeviceId: uuidv7Bytes(),
        recipientDeviceId: uuidToBytes(DEVICE_ID),
        cryptoType: CryptoType.OLM,
        ciphertext: new Uint8Array([1, 2, 3]),
      }),
    ),
  });
}

afterEach(() => {
  for (const ws of transports.splice(0)) ws.stop();
  sockets.length = 0;
});

describe('WsTransport', () => {
  it('authenticates with the token in the first frame, then goes online', async () => {
    const ws = transport();
    const events: WsEvent[] = [];
    ws.onEvent((event) => events.push(event));
    const socket = await online(ws);
    expect(socket.binaryType).toBe('arraybuffer');
    const [first] = socket.frames;
    expect(first?.body.case).toBe('auth');
    expect(first?.body.value).toMatchObject({
      accessToken: 'token',
      protocolVersion: PROTOCOL_VERSION,
    });
    expect(events[0]).toMatchObject({ type: 'connected', userId: USER_ID, deviceId: DEVICE_ID });
  });

  it('answers sends with the matching Accepted or ServerError', async () => {
    const ws = transport();
    const socket = await online(ws);
    const first = ws.send(envelopePacket());
    const second = ws.send(envelopePacket());
    const [, a, b] = socket.frames;
    socket.reply({
      requestId: b!.requestId,
      body: {
        case: 'error',
        value: { code: 'MAILBOX_UNAVAILABLE', retryable: true, message: 'x' },
      },
    });
    socket.reply({
      requestId: a!.requestId,
      body: {
        case: 'accepted',
        value: {
          packetId: uuidv7Bytes(),
          envelopeId: uuidv7Bytes(),
          status: Accepted_Status.STORED,
        },
      },
    });
    expect(await first).toEqual({ ok: true, status: 'stored' });
    expect(await second).toEqual({ ok: false, code: 'MAILBOX_UNAVAILABLE', retryable: true });
  });

  it('reports OFFLINE before connecting, and for sends cut off by a close', async () => {
    const ws = transport();
    expect(await ws.send(envelopePacket())).toMatchObject({ ok: false, code: 'OFFLINE' });
    const socket = await online(ws);
    const pending = ws.send(envelopePacket());
    socket.serverClose(1006);
    expect(await pending).toMatchObject({ ok: false, code: 'OFFLINE', retryable: true });
  });

  it('times out a send that gets no answer', async () => {
    const ws = transport({ sendTimeoutMs: 20 });
    await online(ws);
    expect(await ws.send(envelopePacket())).toEqual({
      ok: false,
      code: 'TIMEOUT',
      retryable: true,
    });
  });

  it('refuses an expired packet without sending it', async () => {
    const ws = transport();
    const socket = await online(ws);
    const packet = envelopePacket();
    packet.expiresAtMs = BigInt(Date.now() - 1);
    packet.createdAtMs = BigInt(Date.now() - 10);
    expect(await ws.send(packet)).toEqual({
      ok: false,
      code: 'ENVELOPE_EXPIRED',
      retryable: false,
    });
    expect(socket.frames).toHaveLength(1);
  });

  it('hands deliveries to listeners and batches their ACKs', async () => {
    const ws = transport();
    const socket = await online(ws);
    const received: TransportPacket[] = [];
    ws.onPacket((packet, ack) => {
      received.push(packet);
      ack();
      ack(); // a second call is ignored
    });
    const packets = [envelopePacket(), envelopePacket(), envelopePacket()];
    for (const packet of packets) socket.reply({ body: { case: 'deliver', value: { packet } } });
    expect(received).toHaveLength(3);
    await until(() => socket.frames.some((frame) => frame.body.case === 'ack'));
    const acks = socket.frames.filter((frame) => frame.body.case === 'ack');
    expect(acks).toHaveLength(1);
    expect(acks[0]?.body.case === 'ack' && acks[0].body.value.envelopeIds).toHaveLength(3);
  });

  it('reconnects with backoff after the connection drops', async () => {
    const ws = transport();
    const socket = await online(ws);
    socket.serverClose(1006);
    expect(ws.status).toBe('offline');
    await until(() => sockets.length === 2);
    sockets[1]!.open();
    sockets[1]!.authOk();
    await until(() => ws.status === 'online');
  });

  it('refreshes the token after close code 4001, then reconnects', async () => {
    let token = 'old';
    const refreshToken = vi.fn(() => {
      token = 'new';
      return Promise.resolve(true);
    });
    const ws = transport({ getAccessToken: () => token, refreshToken });
    const socket = await online(ws);
    socket.serverClose(4001);
    await until(() => sockets.length === 2);
    expect(refreshToken).toHaveBeenCalledOnce();
    sockets[1]!.open();
    const auth = sockets[1]!.frames[0];
    expect(auth?.body.case === 'auth' && auth.body.value.accessToken).toBe('new');
  });

  it('stops for good when replaced (4002) or revoked', async () => {
    const replacedWs = transport();
    const events: WsEvent['type'][] = [];
    replacedWs.onEvent((event) => events.push(event.type));
    (await online(replacedWs)).serverClose(4002);
    expect(events).toContain('replaced');

    const revokedWs = transport();
    revokedWs.onEvent((event) => events.push(event.type));
    revokedWs.start();
    await until(() => sockets.length === 2);
    const socket = sockets[1]!;
    socket.open();
    socket.reply({
      requestId: socket.frames[0]!.requestId,
      body: { case: 'error', value: { code: 'DEVICE_REVOKED', retryable: false, message: 'x' } },
    });
    socket.serverClose(4001);
    expect(events).toContain('revoked');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sockets).toHaveLength(2);
    expect(revokedWs.status).toBe('offline');
  });

  it('pings while idle', async () => {
    const ws = transport();
    const socket = await online(ws, 1_000);
    await until(() => socket.frames.some((frame) => frame.body.case === 'ping'), 2_500);
  });

  it('sends typing to the named devices only while online', async () => {
    const ws = transport();
    const typing = { recipientDeviceIds: [uuidv7()], senderDeviceId: '', active: true };
    expect(ws.sendTyping(typing)).toBe(false);
    const socket = await online(ws);
    expect(ws.sendTyping(typing)).toBe(true);
    expect(socket.frames.at(-1)?.body.case).toBe('typing');
  });
});

describe('WsTransport presence', () => {
  it('sends the foreground state and watch list, again after a reconnect', async () => {
    const ws = transport();
    const events: WsEvent[] = [];
    ws.onEvent((event) => events.push(event));
    ws.setPresence(true); // offline: remembered
    ws.watchPresence([USER_ID, USER_ID]);
    const socket = await online(ws);
    const sent = socket.frames.filter((frame) => frame.body.case === 'presence');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body.value).toMatchObject({
      online: true,
      watchUserIds: [uuidToBytes(USER_ID)],
    });
    socket.reply({
      body: { case: 'presence', value: { userId: uuidToBytes(USER_ID), online: true } },
    });
    expect(events.at(-1)).toEqual({ type: 'presence', userId: USER_ID, online: true });

    socket.serverClose(1006);
    await until(() => sockets.length === 2);
    sockets[1]!.open();
    sockets[1]!.authOk();
    await until(() => ws.status === 'online');
    expect(sockets[1]!.frames.some((frame) => frame.body.case === 'presence')).toBe(true);
  });
});

describe('backoffDelay', () => {
  it('doubles from the base up to the cap, with jitter in [0.5, 1)', () => {
    const low = () => 0;
    const high = () => 0.999_999;
    expect(backoffDelay(1, { baseMs: 100, random: low })).toBe(50);
    expect(backoffDelay(1, { baseMs: 100, random: high })).toBe(100);
    expect(backoffDelay(4, { baseMs: 100, random: high })).toBe(800);
    expect(backoffDelay(40, { baseMs: 100, maxMs: 1_000, random: high })).toBe(1_000);
  });
});

describe('TransportRouter', () => {
  it('sends over the first online transport and reports OFFLINE otherwise', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true as const, status: 'stored' as const }));
    const internet: Transport & { status$: ValueStream<TransportStatus> } = {
      kind: 'internet',
      status$: new ValueStream<TransportStatus>('offline'),
      send,
      onPacket: () => () => undefined,
    };
    const router = new TransportRouter([internet]);
    expect(await router.send(envelopePacket())).toMatchObject({ code: 'OFFLINE' });
    internet.status$.set('connecting');
    expect(router.status$.value).toBe('connecting');
    internet.status$.set('online');
    expect(router.status$.value).toBe('online');
    expect(router.online).toEqual(['internet']);
    expect(await router.send(envelopePacket())).toEqual({ ok: true, status: 'stored' });
    expect(send).toHaveBeenCalledOnce();
  });
});
