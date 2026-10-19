/** The WebSocket gateway: auth, one socket per device, the online path, relays and limits. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import { Accepted_Status, PROTOCOL_VERSION, uuidToBytes } from '@pingdost/protocol';

import { cryptoProvider, signedOneTimeKeys } from './devices';
import { bearer, json, registeredUser, startTestServer, type TestServer } from './helpers';
import { deviceSession, envelopePacket, TestSocket, type TestDeviceSession } from './ws';

const METRICS_TOKEN = 'metrics-token-for-tests-0123456789abcdef';

let server: TestServer;
let crypto: CryptoProvider;

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    env: { METRICS_TOKEN },
    // A small envelope limit, so an envelope the client codec still encodes is too large here.
    delivery: { settings: { onlineAckTimeoutMs: 400, envelopeMaxBytes: 4_096 } },
    gateway: { authTimeoutMs: 400 },
  });
});

afterAll(async () => {
  await server.close();
});

async function pair(): Promise<[TestDeviceSession, TestDeviceSession]> {
  return [await deviceSession(server, crypto), await deviceSession(server, crypto)];
}

describe('authentication', () => {
  it('needs an Auth frame in time and a valid device-bound token', async () => {
    const silent = await TestSocket.open(server);
    expect(await silent.next('error')).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(await silent.closed()).toBe(4001);

    const forged = await TestSocket.open(server);
    const requestId = forged.send({
      body: {
        case: 'auth',
        value: { accessToken: 'not-a-jwt', protocolVersion: PROTOCOL_VERSION },
      },
    });
    expect((await forged.next('error', { requestId })).code).toMatch(
      /TOKEN_INVALID|UNAUTHENTICATED/,
    );
    expect(await forged.closed()).toBe(4001);

    const [alice] = await pair();
    const early = await TestSocket.open(server);
    const ping = early.send({ body: { case: 'ping', value: { nonce: 1 } } });
    expect(await early.next('error', { requestId: ping })).toMatchObject({
      code: 'UNAUTHENTICATED',
    });

    const socket = await TestSocket.connect(server, alice);
    const pong = socket.send({ body: { case: 'ping', value: { nonce: 7 } } });
    expect(await socket.next('pong', { requestId: pong })).toMatchObject({ nonce: 7 });
    socket.close();
  });

  it('refuses sessions without a device', async () => {
    const session = await registeredUser(server);
    const socket = await TestSocket.open(server);
    const requestId = socket.send({
      body: {
        case: 'auth',
        value: { accessToken: session.accessToken, protocolVersion: PROTOCOL_VERSION },
      },
    });
    expect(await socket.next('error', { requestId })).toMatchObject({ code: 'DEVICE_REQUIRED' });
    expect(await socket.closed()).toBe(4001);
  });

  it('keeps one socket per device: the newer one replaces the old', async () => {
    const [alice] = await pair();
    const first = await TestSocket.connect(server, alice);
    const second = await TestSocket.connect(server, alice);
    expect(await first.next('error')).toMatchObject({ code: 'CONNECTION_REPLACED' });
    expect(await first.closed()).toBe(4002);
    const pong = second.send({ body: { case: 'ping', value: { nonce: 2 } } });
    await second.next('pong', { requestId: pong });
    second.close();
  });

  it('sends Revoked and closes when the device is revoked', async () => {
    const [alice] = await pair();
    const socket = await TestSocket.connect(server, alice);
    const revoked = await server.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${alice.deviceId}`,
      headers: bearer(alice.accessToken),
    });
    expect(revoked.statusCode).toBe(204);
    expect((await socket.next('revoked')).revokedAtMs).toBeGreaterThan(0n);
    expect(await socket.closed()).toBe(4003);
  });
});

describe('send', () => {
  it('delivers online and answers DELIVERED_TRANSPORT after the transport ACK', async () => {
    const [alice, bob] = await pair();
    const aliceSocket = await TestSocket.connect(server, alice);
    const bobSocket = await TestSocket.connect(server, bob);

    const { packet, envelopeId } = envelopePacket(server, alice.deviceId, bob.deviceId);
    const requestId = aliceSocket.sendPacket(packet);
    const deliver = await bobSocket.next('deliver');
    expect(deliver.packet?.packetId).toEqual(packet.packetId);
    bobSocket.ack([envelopeId]);

    const reply = await aliceSocket.reply(requestId);
    expect(reply).toMatchObject({
      case: 'accepted',
      value: { status: Accepted_Status.DELIVERED_TRANSPORT, envelopeId: uuidToBytes(envelopeId) },
    });
    // Nothing was stored.
    expect(await server.mongo.db.collection('pending_envelopes').countDocuments()).toBe(0);
    expect(
      await server.redis.client().exists(`${server.mailbox.redisKeyPrefix}env:${envelopeId}`),
    ).toBe(0);
    aliceSocket.close();
    bobSocket.close();
  });

  it('falls back to the mailbox when the online recipient does not ACK in time', async () => {
    const [alice, bob] = await pair();
    const aliceSocket = await TestSocket.connect(server, alice);
    const bobSocket = await TestSocket.connect(server, bob);
    const { packet, envelopeId } = envelopePacket(server, alice.deviceId, bob.deviceId);
    const requestId = aliceSocket.sendPacket(packet);
    await bobSocket.next('deliver');
    expect(await aliceSocket.reply(requestId)).toMatchObject({
      case: 'accepted',
      value: { status: Accepted_Status.STORED },
    });
    expect(
      await server.redis.client().exists(`${server.mailbox.redisKeyPrefix}env:${envelopeId}`),
    ).toBe(1);
    aliceSocket.close();
    bobSocket.close();
  });

  it('rejects spoofed senders, unknown recipients, expired and oversized envelopes', async () => {
    const [alice, bob] = await pair();
    const socket = await TestSocket.connect(server, alice);

    const spoofed = envelopePacket(server, alice.deviceId, bob.deviceId, {
      senderDeviceId: bob.deviceId,
    });
    expect(await socket.reply(socket.sendPacket(spoofed.packet))).toMatchObject({
      case: 'error',
      value: { code: 'FORBIDDEN', retryable: false },
    });

    const stranger = envelopePacket(server, alice.deviceId, '01920000-0000-7000-8000-00000000dead');
    expect(await socket.reply(socket.sendPacket(stranger.packet))).toMatchObject({
      case: 'error',
      value: { code: 'RECIPIENT_UNKNOWN' },
    });

    const oversized = envelopePacket(server, alice.deviceId, bob.deviceId, {
      ciphertext: new Uint8Array(10_000),
    });
    // The frame codec rejects it before any handler runs, so the error has no request ID.
    socket.sendPacket(oversized.packet);
    expect(await socket.next('error', { requestId: 0 })).toMatchObject({
      code: 'ENVELOPE_TOO_LARGE',
    });

    const shortLived = envelopePacket(server, alice.deviceId, bob.deviceId, { ttlMs: 1_000 });
    const sentAt = server.clock.now();
    server.clock.advance(2_000);
    // The client still thinks it is valid; the server's clock says it expired.
    socket.sendPacket(shortLived.packet, sentAt);
    expect(await socket.next('error', { requestId: 0 })).toMatchObject({
      code: 'ENVELOPE_EXPIRED',
    });
    socket.close();
  });

  it('relays typing and ephemeral packets to online devices only, never storing them', async () => {
    const [alice, bob] = await pair();
    const aliceSocket = await TestSocket.connect(server, alice);
    const bobSocket = await TestSocket.connect(server, bob);

    aliceSocket.send({
      requestId: 0,
      body: {
        case: 'typing',
        value: { recipientDeviceIds: [uuidToBytes(bob.deviceId)], active: true },
      },
    });
    expect(await bobSocket.next('typing')).toMatchObject({
      senderDeviceId: uuidToBytes(alice.deviceId),
      active: true,
    });

    const ephemeral = envelopePacket(server, alice.deviceId, bob.deviceId, { kind: 5 });
    aliceSocket.send({ body: { case: 'ephemeral', value: { packet: ephemeral.packet } } });
    expect((await bobSocket.next('ephemeral')).packet?.packetId).toEqual(ephemeral.packet.packetId);

    bobSocket.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const offline = envelopePacket(server, alice.deviceId, bob.deviceId, { kind: 5 });
    const requestId = aliceSocket.send({
      body: { case: 'ephemeral', value: { packet: offline.packet } },
    });
    expect(await aliceSocket.next('error', { requestId })).toMatchObject({
      code: 'RECIPIENT_OFFLINE',
    });
    expect(
      await server.mongo.db
        .collection('pending_envelopes')
        .countDocuments({ _id: offline.envelopeId as never }),
    ).toBe(0);
    aliceSocket.close();
  });
});

describe('one-time key notices', () => {
  it('sends OtkLow on connect and after claims leave too few keys', async () => {
    const [alice] = await pair();
    const socket = await TestSocket.connect(server, alice);
    expect(await socket.next('otkLow')).toMatchObject({ remaining: 0 });
    socket.close();
  });

  it('stays quiet with enough keys, then notices when claims leave too few', async () => {
    const [alice, bob] = await pair();
    const upload = await server.app.inject({
      method: 'POST',
      url: '/v1/keys/otks',
      headers: bearer(alice.accessToken),
      payload: { oneTimeKeys: signedOneTimeKeys(alice.device, 25) },
    });
    expect(json(upload)).toEqual({ count: 25 });
    const socket = await TestSocket.connect(server, alice);
    await expect(socket.next('otkLow', { timeoutMs: 300 })).rejects.toThrow();

    for (let claims = 0; claims < 6; claims++) {
      const claim = await server.app.inject({
        method: 'POST',
        url: '/v1/keys/claim',
        headers: bearer(bob.accessToken),
        payload: { deviceIds: [alice.deviceId] },
      });
      expect(claim.statusCode).toBe(200);
    }
    // 19 left after the sixth claim: below the threshold of 20.
    expect(await socket.next('otkLow')).toMatchObject({ remaining: 19 });
    socket.close();
  });
});

describe('/metrics', () => {
  it('needs the token and exposes the mailbox metrics', async () => {
    expect((await server.app.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401);
    const response = await server.app.inject({
      method: 'GET',
      url: '/metrics',
      headers: bearer(METRICS_TOKEN),
    });
    expect(response.statusCode).toBe(200);
    for (const name of [
      'pingdost_envelopes_accepted_total',
      'pingdost_envelope_duplicates_total',
      'pingdost_mailbox_migrations_total',
      'pingdost_mailbox_migration_failures_total',
      'pingdost_mailbox_expired_deleted_total',
      'pingdost_mailbox_redis_stage_count',
      'pingdost_mailbox_redis_oldest_age_seconds',
      'pingdost_mailbox_due_backlog',
      'pingdost_mailbox_due_overdue',
      'pingdost_mailbox_mongo_pending_count',
      'pingdost_mailbox_mongo_oldest_age_seconds',
      'pingdost_redis_commands',
      'pingdost_ws_connections',
    ]) {
      expect(response.body).toContain(name);
    }
  });
});
