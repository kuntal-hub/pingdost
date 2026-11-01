/**
 * Calls on the server (Phase 25, ADR 0028):
 * - `GET /v1/calls/turn-credentials`: STUN plus TURN with the TURN REST API pair; with the dev
 *   coturn up (`docker compose --profile calls up -d --wait`), the pair allocates a relay on
 *   it and a tampered or expired one is refused (skipped when coturn is not running);
 * - a call invite (EPHEMERAL with RING) to an offline device makes one content-free `call`
 *   push per window; other ephemeral packets and blocked senders make none;
 * - nothing is written for any of it (no call records, REQ §5.2).
 */
import { execFile } from 'node:child_process';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { CryptoProvider } from '@pingdost/crypto';
import { PacketFlag, PacketKind } from '@pingdost/protocol';
import type { TurnCredentialsResponse } from '@pingdost/shared-types';

import { cryptoProvider } from './devices';
import { bearer, json, registeredUser, startTestServer, type TestServer } from './helpers';
import { deviceSession, envelopePacket, TestSocket, type TestDeviceSession } from './ws';
import { systemClock } from '../src/infra/clock';
import { FcmSender } from '../src/modules/push/fcm';

const run = promisify(execFile);

/** The dev coturn's secret (docker-compose.yml, `calls` profile). */
const DEV_TURN_SECRET = 'pingdost-dev-only-turn-shared-secret-0123456789';
const COTURN = 'pingdost-coturn-1';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const fcmBodies: string[] = [];
const fakeGoogle = ((input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url === 'https://oauth2.googleapis.com/token') {
    return Promise.resolve(Response.json({ access_token: 'access', expires_in: 3600 }));
  }
  fcmBodies.push(typeof init?.body === 'string' ? init.body : '');
  return Promise.resolve(Response.json({ name: 'projects/pingdost-test/messages/1' }));
}) as typeof fetch;

let server: TestServer;
let crypto: CryptoProvider;
let coturnUp = false;

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    env: {
      STUN_URLS: 'stun:127.0.0.1:3478',
      TURN_URLS: 'turn:127.0.0.1:3478?transport=udp,turn:127.0.0.1:3478?transport=tcp',
      TURN_SHARED_SECRET: DEV_TURN_SECRET,
      TURN_CREDENTIAL_TTL_SECONDS: '600',
    },
    pushSenders: {
      fcm: new FcmSender({
        projectId: 'pingdost-test',
        serviceAccountJsonBase64: Buffer.from(
          JSON.stringify({
            client_email: 'fcm@test.iam.gserviceaccount.com',
            private_key: privateKey,
          }),
        ).toString('base64'),
        ttlSeconds: 3_600,
        clock: systemClock,
        fetch: fakeGoogle,
      }),
    },
  });
  try {
    const { stdout } = await run('docker', ['inspect', '-f', '{{.State.Health.Status}}', COTURN]);
    coturnUp = stdout.trim() === 'healthy';
  } catch {
    coturnUp = false;
  }
});

afterAll(() => server.close());

async function credentials(session: { accessToken: string }) {
  return server.app.inject({
    method: 'GET',
    url: '/v1/calls/turn-credentials',
    headers: bearer(session.accessToken),
  });
}

/** A TURN allocation on the dev coturn with this pair; true when a relay was allocated. */
async function allocates(username: string, credential: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await run(
      'docker',
      // -v prints the allocated relay address. -y (two clients) only gives uclient a peer: its
      // channel bind to the container's own address is then refused (denied-peer-ip), which is
      // the SSRF rule working.
      [
        'exec',
        COTURN,
        'turnutils_uclient',
        '-v',
        '-y',
        '-n',
        '1',
        '-m',
        '1',
        '-u',
        username,
        '-w',
        credential,
        '127.0.0.1',
      ],
      { timeout: 20_000 },
    );
    return `${stdout}${stderr}`.includes('Received relay addr');
  } catch (error) {
    const output = error as { stdout?: string; stderr?: string };
    return `${output.stdout ?? ''}${output.stderr ?? ''}`.includes('Received relay addr');
  }
}

describe('TURN credentials', () => {
  it('needs a device session and returns STUN plus a short-lived TURN pair', async () => {
    const anonymous = await server.app.inject({ method: 'GET', url: '/v1/calls/turn-credentials' });
    expect(anonymous.statusCode).toBe(401);
    const noDevice = await registeredUser(server);
    expect(json(await credentials(noDevice))).toMatchObject({ code: 'DEVICE_REQUIRED' });

    const alice = await deviceSession(server, crypto);
    const response = await credentials(alice);
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = json<TurnCredentialsResponse>(response);
    const now = Math.floor(server.clock.now() / 1_000);
    const [stun, turn] = body.iceServers;
    expect(stun).toEqual({ urls: ['stun:127.0.0.1:3478'] });
    expect(turn!.urls).toEqual([
      'turn:127.0.0.1:3478?transport=udp',
      'turn:127.0.0.1:3478?transport=tcp',
    ]);
    const [expiry, userId] = turn!.username!.split(':');
    expect(userId).toBe(alice.userId);
    expect(Number(expiry)).toBeGreaterThanOrEqual(now + 599);
    expect(Number(expiry)).toBeLessThanOrEqual(now + 601);
    expect(turn!.credential).toBe(
      createHmac('sha1', DEV_TURN_SECRET).update(turn!.username!).digest('base64'),
    );
    expect(body.ttlSeconds).toBe(600);
    expect(response.body).not.toContain(DEV_TURN_SECRET);
  });

  it('the pair allocates a relay on coturn; tampered or expired pairs do not', async (context) => {
    if (!coturnUp) context.skip(); // `docker compose --profile calls up -d --wait`
    const alice = await deviceSession(server, crypto);
    const turn = json<TurnCredentialsResponse>(await credentials(alice)).iceServers[1]!;
    expect(await allocates(turn.username!, turn.credential!)).toBe(true);
    expect(await allocates(turn.username!, Buffer.from('wrong').toString('base64'))).toBe(false);
    const expired = `${Math.floor(Date.now() / 1_000) - 60}:${alice.userId}`;
    const expiredCredential = createHmac('sha1', DEV_TURN_SECRET).update(expired).digest('base64');
    expect(await allocates(expired, expiredCredential)).toBe(false);
  }, 90_000);
});

describe('call pushes', () => {
  async function putToken(session: TestDeviceSession, token: string) {
    const reply = await server.app.inject({
      method: 'PUT',
      url: '/v1/push/token',
      headers: bearer(session.accessToken),
      payload: { provider: 'fcm', token },
    });
    expect(reply.statusCode).toBe(204);
  }

  async function ephemeral(
    socket: TestSocket,
    from: TestDeviceSession,
    to: TestDeviceSession,
    flags: number,
  ) {
    const built = envelopePacket(server, from.deviceId, to.deviceId, {
      kind: PacketKind.EPHEMERAL,
      ttlMs: 60_000,
      ciphertext: new TextEncoder().encode('v=0 SDP-MARKER a=candidate'),
    });
    built.packet.flags = flags;
    return socket.reply(
      socket.send({ body: { case: 'ephemeral', value: { packet: built.packet } } }),
    );
  }

  it('rings an offline callee device once per window with a content-free push', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    const carol = await deviceSession(server, crypto);
    await putToken(bob, 'token-call-bob');
    await putToken(carol, 'token-call-carol');
    const socket = await TestSocket.connect(server, alice);
    const before = fcmBodies.length;

    expect(await ephemeral(socket, alice, bob, PacketFlag.RING)).toMatchObject({
      case: 'error',
      value: { code: 'RECIPIENT_OFFLINE' },
    });
    await vi.waitFor(() => expect(fcmBodies.length).toBe(before + 1));
    const body = fcmBodies[before]!;
    expect(JSON.parse(body)).toEqual({
      message: {
        token: 'token-call-bob',
        data: { t: 'call' },
        android: { priority: 'HIGH', collapse_key: 'call', ttl: '60s' },
      },
    });
    for (const secret of ['SDP', alice.userId, alice.deviceId, bob.deviceId]) {
      expect(body).not.toContain(secret);
    }

    // The caller re-sends the invite: no second push inside the window.
    await ephemeral(socket, alice, bob, PacketFlag.RING);
    // Other ephemeral packets (ICE, history sync) never ring.
    await ephemeral(socket, alice, carol, 0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fcmBodies.length).toBe(before + 1);
    socket.close();
  });

  it('does not ring for a sender the callee blocked', async () => {
    const alice = await deviceSession(server, crypto);
    const bob = await deviceSession(server, crypto);
    await putToken(bob, 'token-call-blocker');
    const blocked = await server.app.inject({
      method: 'PUT',
      url: `/v1/blocks/${alice.userId}`,
      headers: bearer(bob.accessToken),
    });
    expect(blocked.statusCode).toBeLessThan(300);
    const socket = await TestSocket.connect(server, alice);
    const before = fcmBodies.length;
    expect(await ephemeral(socket, alice, bob, PacketFlag.RING)).toMatchObject({
      case: 'error',
      value: { code: 'RECIPIENT_OFFLINE' },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fcmBodies.length).toBe(before);
    socket.close();
  });
});
