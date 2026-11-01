/**
 * The WebRTC spike, automated (Phase 25, ADR 0028): two sim clients with real E2EE and real
 * WebRTC (werift on both sides) call each other through a listening test server.
 * - Direct: host candidates on this PC; setup time printed as `CALL_SPIKE {...}`.
 * - TURN-forced (both sides `relayOnly`) through the dev coturn, when it is up
 *   (`docker compose --profile calls up -d --wait`); skipped otherwise.
 * - Every WebSocket frame of both clients is scanned: no SDP or ICE text (only ciphertext),
 *   and Mongo sees no write for any of it (no call records).
 */
import { execFile } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

import type { CommandStartedEvent } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CallManager, CallSnapshot } from '@pingdost/call-engine';
import type { CryptoProvider } from '@pingdost/crypto';
import {
  capturingSocket,
  containsMarker,
  SimClient,
  simCalls,
  type SimClientOptions,
} from '@pingdost/sim-client';

import { cryptoProvider } from './devices';
import { freePort, MAILPIT_URL, startTestServer, type TestServer } from './helpers';

const run = promisify(execFile);
const DEV_TURN_SECRET = 'pingdost-dev-only-turn-shared-secret-0123456789';
/** SDP and ICE text that must never cross the socket in the clear. */
const MARKERS = ['v=0', 'a=candidate', 'a=fingerprint', 'a=ice-ufrag', 'candidate:', 'typ host'];
const MONGO_WRITES = new Set(['insert', 'update', 'delete', 'findAndModify', 'bulkWrite']);

let server: TestServer;
let crypto: CryptoProvider;
let port: number;
let coturnUp = false;
const frames: Uint8Array[] = [];
const clients: SimClient[] = [];
const managers: CallManager[] = [];
const mongoWrites: string[] = [];
let recording = false;

beforeAll(async () => {
  crypto = await cryptoProvider();
  port = await freePort();
  server = await startTestServer({
    env: {
      PUBLIC_API_URL: `http://127.0.0.1:${port}`,
      STUN_URLS: 'stun:127.0.0.1:3478',
      TURN_URLS: 'turn:127.0.0.1:3478?transport=udp',
      TURN_SHARED_SECRET: DEV_TURN_SECRET,
    },
    throttles: { keyClaims: { limit: 10_000, windowMs: 3_600_000 } },
    monitorMongo: true,
  });
  await server.app.listen({ host: '127.0.0.1', port });
  port = (server.app.server.address() as AddressInfo).port;
  server.mongo.client.on('commandStarted', (event: CommandStartedEvent) => {
    if (!recording || !MONGO_WRITES.has(event.commandName)) return;
    const target = String((event.command as Record<string, unknown>)[event.commandName]);
    // Not call data: a device's coarse last-seen stamp, and the one-time key claimed to open
    // the Olm session the signaling then uses.
    if (target !== 'devices' && target !== 'one_time_keys') {
      mongoWrites.push(`${event.commandName}:${target}`);
    }
  });
  try {
    const { stdout } = await run('docker', [
      'inspect',
      '-f',
      '{{.State.Health.Status}}',
      'pingdost-coturn-1',
    ]);
    coturnUp = stdout.trim() === 'healthy';
  } catch {
    coturnUp = false;
  }
});

afterAll(async () => {
  for (const manager of managers) await manager.dispose().catch(() => undefined);
  for (const client of clients) await client.stop().catch(() => undefined);
  await server.close();
});

function options(): SimClientOptions {
  return {
    endpoints: {
      api: `http://127.0.0.1:${port}`,
      ws: `ws://127.0.0.1:${port}/v1/ws`,
      mailpit: MAILPIT_URL,
    },
    crypto,
    createSocket: capturingSocket(frames),
    settings: { directoryMaxAgeMs: 60_000, retry: { baseMs: 200, maxMs: 1_000 } },
  };
}

async function until(condition: () => boolean, what: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function pair(relayOnly: boolean) {
  const alice = await SimClient.register(options());
  const bob = await SimClient.register(options());
  clients.push(alice, bob);
  await Promise.all([alice.start(), bob.start()]);
  const quiet = () => undefined;
  const caller = simCalls(alice, { relayOnly, log: quiet });
  const callee = simCalls(bob, { relayOnly, answerAfterMs: 200, log: quiet });
  managers.push(caller, callee);
  return { alice, bob, caller, callee };
}

async function call(relayOnly: boolean): Promise<CallSnapshot> {
  const { bob, caller, callee } = await pair(relayOnly);
  recording = true;
  const startedAt = Date.now();
  await caller.dial(bob.userId, { video: true });
  await until(
    () => caller.call?.state === 'connected' && callee.call?.state === 'connected',
    'a connected call',
  );
  const connected = caller.call!;
  // Media flows for a moment, then the caller hangs up and both record "completed".
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await caller.hangup();
  await until(() => callee.call?.state === 'ended', 'the hang-up');
  recording = false;
  expect(caller.call?.outcome).toBe('completed');
  expect(callee.call?.outcome).toBe('completed');
  console.log(
    `CALL_SPIKE ${JSON.stringify({
      path: relayOnly ? 'turn-forced' : 'direct',
      dialToConnectedMs: connected.connectedAt! - startedAt,
      answerToConnectedMs: connected.connectedAt! - connected.answeredAt!,
    })}`,
  );
  return connected;
}

describe('WebRTC calls between two sim clients', () => {
  it('connects directly, with only ciphertext signaling and no writes', async () => {
    const before = frames.length;
    await call(false);
    const sent = frames.slice(before);
    expect(sent.length).toBeGreaterThan(5);
    for (const frame of sent) {
      for (const marker of MARKERS) expect(containsMarker(frame, marker), marker).toBe(false);
    }
    expect(mongoWrites).toEqual([]);
  }, 60_000);

  it('connects through TURN when both sides force the relay', async (context) => {
    if (!coturnUp) context.skip(); // `docker compose --profile calls up -d --wait`
    const call_ = await call(true);
    expect(call_.relayOnly).toBe(true);
    expect(mongoWrites).toEqual([]);
  }, 60_000);
});
