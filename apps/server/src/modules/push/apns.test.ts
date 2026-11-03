import { decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { pino } from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { PUSH_CALL, PUSH_WAKE, PushTokenRequestSchema } from '@pingdost/shared-types';

import { ApnsSender, apnsRequest, isInvalidApnsToken } from './apns';
import type { PushTarget } from './repo';
import { PushService, type WakeResult } from './service';
import { apnsKeyPair, startFakeApns, type FakeApns } from '../../../test/fake-apns';
import type { Clock } from '../../infra/clock';
import { Metrics } from '../../infra/metrics';

const ALERT = 'a'.repeat(64);
const VOIP = 'b'.repeat(64);
const TARGET: PushTarget = { provider: 'apns', address: ALERT, voip: VOIP };
const keys = apnsKeyPair();
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

let fake: FakeApns;
let clockMs = NOW;
const clock: Clock = { now: () => clockMs };
const senders: ApnsSender[] = [];

function sender(): ApnsSender {
  const created = new ApnsSender({
    keyId: 'KEY1234567',
    teamId: 'TEAM123456',
    privateKeyPem: keys.privateKeyPem,
    bundleId: 'com.pingdost.app',
    ttlSeconds: 3_600,
    clock,
    origins: fake.origins,
  });
  senders.push(created);
  return created;
}

beforeAll(async () => {
  fake = await startFakeApns();
});

afterEach(async () => {
  await Promise.all(senders.splice(0).map((created) => created.close()));
  fake.calls.length = 0;
  fake.reply = () => ({ status: 200 });
  clockMs = NOW;
});

afterAll(() => fake.close());

describe('apnsRequest', () => {
  it('makes a wake a constant alert with content-available and nothing else', () => {
    const request = apnsRequest(TARGET, PUSH_WAKE, {
      bundleId: 'com.pingdost.app',
      ttlSeconds: 3_600,
      nowMs: NOW,
    });
    expect(request).toEqual({
      token: ALERT,
      voip: false,
      headers: {
        'apns-push-type': 'alert',
        'apns-topic': 'com.pingdost.app',
        'apns-priority': '10',
        'apns-expiration': String(NOW / 1_000 + 3_600),
        'apns-collapse-id': 'wake',
      },
      body: {
        aps: { alert: { body: 'New message' }, sound: 'default', 'content-available': 1 },
        t: 'wake',
      },
    });
  });

  it('sends a call to the VoIP token for 60 s, or as an alert without one', () => {
    const options = { bundleId: 'com.pingdost.app', ttlSeconds: 3_600, nowMs: NOW };
    expect(apnsRequest(TARGET, PUSH_CALL, options)).toEqual({
      token: VOIP,
      voip: true,
      headers: {
        'apns-push-type': 'voip',
        'apns-topic': 'com.pingdost.app.voip',
        'apns-priority': '10',
        'apns-expiration': String(NOW / 1_000 + 60),
      },
      body: { t: 'call' },
    });
    const fallback = apnsRequest({ address: ALERT }, PUSH_CALL, options);
    expect(fallback).toMatchObject({
      token: ALERT,
      voip: false,
      headers: { 'apns-push-type': 'alert', 'apns-collapse-id': 'call' },
      body: { aps: { alert: { body: 'Incoming call' } }, t: 'call' },
    });
    expect(fallback.headers['apns-expiration']).toBe(String(NOW / 1_000 + 60));
  });

  it('deletes only tokens Apple says are dead, never over a config mistake', () => {
    expect(isInvalidApnsToken(410, 'Unregistered')).toBe(true);
    expect(isInvalidApnsToken(400, 'BadDeviceToken')).toBe(true);
    expect(isInvalidApnsToken(400, 'DeviceTokenNotForTopic')).toBe(false);
    expect(isInvalidApnsToken(400, 'TopicDisallowed')).toBe(false);
    expect(isInvalidApnsToken(400, 'PayloadTooLarge')).toBe(false);
    expect(isInvalidApnsToken(403, 'InvalidProviderToken')).toBe(false);
  });
});

describe('ApnsSender', () => {
  it('posts over HTTP/2 with an ES256 provider token Apple can verify', async () => {
    expect(await sender().send(TARGET, PUSH_WAKE)).toEqual({ result: 'sent' });
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call?.gateway).toBe('production');
    expect(call?.path).toBe(`/3/device/${ALERT}`);
    expect(call?.headers).toMatchObject({
      ':method': 'POST',
      'apns-push-type': 'alert',
      'apns-topic': 'com.pingdost.app',
      'content-type': 'application/json',
    });
    expect(JSON.parse(call?.body ?? '')).toEqual({
      aps: { alert: { body: 'New message' }, sound: 'default', 'content-available': 1 },
      t: 'wake',
    });

    const jwt = String(call?.headers.authorization).replace(/^bearer /, '');
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    const { payload } = await jwtVerify(jwt, await importSPKI(keys.publicKeyPem, 'ES256'), {
      issuer: 'TEAM123456',
      currentDate: new Date(NOW),
    });
    expect(payload).toEqual({ iss: 'TEAM123456', iat: NOW / 1_000 });
  });

  it('uses the sandbox gateway for development tokens', async () => {
    await sender().send({ ...TARGET, sandbox: true }, PUSH_CALL);
    expect(fake.calls.map((call) => [call.gateway, call.path, call.headers['apns-topic']])).toEqual(
      [['sandbox', `/3/device/${VOIP}`, 'com.pingdost.app.voip']],
    );
  });

  it('reuses one provider token for 50 minutes, then signs a new one', async () => {
    const apns = sender();
    await apns.send(TARGET, PUSH_WAKE);
    clockMs += 49 * 60_000;
    await apns.send(TARGET, PUSH_WAKE);
    clockMs += 2 * 60_000;
    await apns.send(TARGET, PUSH_WAKE);
    const tokens = fake.calls.map((call) => call.headers.authorization);
    expect(tokens[0]).toBe(tokens[1]);
    expect(tokens[2]).not.toBe(tokens[1]);
  });

  it('maps Apple’s answers to outcomes', async () => {
    const apns = sender();
    const cases: [number, string | undefined, unknown][] = [
      [410, 'Unregistered', { result: 'invalid_token' }],
      [400, 'BadDeviceToken', { result: 'invalid_token' }],
      [400, 'DeviceTokenNotForTopic', { result: 'failed', status: 400 }],
      [403, 'ExpiredProviderToken', { result: 'failed', status: 403, retryAfterMs: 0 }],
      [429, 'TooManyRequests', { result: 'failed', status: 429, retryAfterMs: 1_000 }],
      [503, 'ServiceUnavailable', { result: 'failed', status: 503, retryAfterMs: 1_000 }],
    ];
    for (const [status, reason, outcome] of cases) {
      fake.reply = () => ({ status, ...(reason === undefined ? {} : { reason }) });
      expect(await apns.send({ provider: 'apns', address: ALERT }, PUSH_WAKE)).toEqual(outcome);
    }
    fake.reply = () => ({ status: 410, reason: 'Unregistered' });
    expect(await apns.send(TARGET, PUSH_CALL)).toEqual({ result: 'invalid_token', voip: true });
  });

  it('reports an unreachable gateway as transient', async () => {
    const apns = new ApnsSender({
      keyId: 'KEY1234567',
      teamId: 'TEAM123456',
      privateKeyPem: keys.privateKeyPem,
      bundleId: 'com.pingdost.app',
      ttlSeconds: 3_600,
      clock,
      timeoutMs: 2_000,
      origins: { production: 'http://127.0.0.1:9', sandbox: 'http://127.0.0.1:9' },
    });
    senders.push(apns);
    expect(await apns.send(TARGET, PUSH_WAKE)).toEqual({ result: 'failed', retryAfterMs: 1_000 });
  });
});

describe('PushService with APNs', () => {
  it('drops only the VoIP token when APNs rejects it', async () => {
    const deleted: string[] = [];
    const target: PushTarget = { ...TARGET };
    const metrics = new Metrics({
      redisCommands: () => 0,
      mongoMailbox: () => Promise.resolve({ count: 0, oldestAgeSeconds: 0 }),
    });
    const service = new PushService({
      tokens: {
        get: () => Promise.resolve(target),
        deleteInvalid: (_device, address) => {
          deleted.push(`address:${address}`);
          return Promise.resolve();
        },
        deleteInvalidVoip: (_device, voip) => {
          deleted.push(`voip:${voip}`);
          return Promise.resolve();
        },
      },
      senders: { apns: sender() },
      throttleMs: 10_000,
      clock,
      metrics,
      log: pino({ level: 'silent' }),
      isConnected: () => false,
    });
    fake.reply = (call) =>
      call.headers['apns-push-type'] === 'voip'
        ? { status: 410, reason: 'Unregistered' }
        : { status: 200 };
    service.ring('device-1');
    service.wake('device-1', false);
    await service.idle();
    expect(deleted).toEqual([`voip:${VOIP}`]);
    const results = async (metric: typeof metrics.pushWakes) =>
      (await metric.get()).values
        .filter((value) => value.value > 0)
        .map((value) => value.labels.result);
    expect(await results(metrics.callPushes)).toEqual(['invalid_token' satisfies WakeResult]);
    expect(await results(metrics.pushWakes)).toEqual(['sent' satisfies WakeResult]);
    await service.close();
  });
});

describe('APNs token registration', () => {
  it('accepts hex tokens with the environment, and refuses anything else', () => {
    const ok = PushTokenRequestSchema.safeParse({
      provider: 'apns',
      token: ALERT,
      voipToken: VOIP,
      environment: 'sandbox',
    });
    expect(ok.success).toBe(true);
    for (const bad of [
      { provider: 'apns', token: 'not-hex!', environment: 'production' },
      { provider: 'apns', token: 'ab', environment: 'production' },
      { provider: 'apns', token: ALERT },
      { provider: 'apns', token: ALERT, environment: 'staging' },
    ]) {
      expect(PushTokenRequestSchema.safeParse(bad).success).toBe(false);
    }
  });
});
