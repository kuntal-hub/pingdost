import { generateKeyPairSync } from 'node:crypto';

import { importSPKI, jwtVerify } from 'jose';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';

import { PUSH_WAKE, type PushPayload } from '@pingdost/shared-types';

import { FcmSender, fcmMessage, isInvalidToken, parseServiceAccount } from './fcm';
import type { PushSender, SendOutcome } from './notifier';
import type { PushTarget } from './repo';
import { PushService, type WakeResult } from './service';
import { WebPushSender } from './webpush';
import { systemClock } from '../../infra/clock';
import { Metrics } from '../../infra/metrics';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const SERVICE_ACCOUNT = Buffer.from(
  JSON.stringify({
    type: 'service_account',
    project_id: 'pingdost-test',
    client_email: 'fcm@pingdost-test.iam.gserviceaccount.com',
    private_key: privateKey,
  }),
).toString('base64');
const TOKEN = 'device-registration-token';
const FCM_TARGET: PushTarget = { provider: 'fcm', address: TOKEN };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A fake Google: an OAuth token endpoint plus an FCM endpoint answering with `fcm()`. */
function fakeGoogle(fcm: () => Response = () => json({ name: 'projects/x/messages/1' })) {
  const sends: { url: string; authorization: string | null; body: unknown }[] = [];
  let tokenRequests = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenRequests++;
      const form = new URLSearchParams(body);
      expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      const { payload } = await jwtVerify(
        form.get('assertion') ?? '',
        await importSPKI(publicKey, 'RS256'),
        { audience: 'https://oauth2.googleapis.com/token' },
      );
      expect(payload).toMatchObject({
        iss: 'fcm@pingdost-test.iam.gserviceaccount.com',
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
      });
      return json({ access_token: `access-${tokenRequests}`, expires_in: 3599 });
    }
    sends.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
      body: JSON.parse(body),
    });
    return fcm();
  });
  return { fetch: fetchFn as typeof fetch, sends, tokenRequests: () => tokenRequests };
}

function fcmSender(google: ReturnType<typeof fakeGoogle>): FcmSender {
  return new FcmSender({
    projectId: 'pingdost-test',
    serviceAccountJsonBase64: SERVICE_ACCOUNT,
    ttlSeconds: 1_209_600,
    clock: systemClock,
    fetch: google.fetch,
  });
}

function fcmError(status: number, errorCode?: string, extra: object = {}) {
  return json(
    {
      error: {
        code: status,
        message: 'error',
        details: errorCode
          ? [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }]
          : [],
        ...extra,
      },
    },
    status,
  );
}

describe('FCM sender', () => {
  it('sends a high-priority data message whose only data is the wake', async () => {
    const google = fakeGoogle();
    const sender = fcmSender(google);

    expect(await sender.send(FCM_TARGET, PUSH_WAKE)).toEqual({ result: 'sent' });
    expect(await sender.send(FCM_TARGET, PUSH_WAKE)).toEqual({ result: 'sent' });

    expect(google.tokenRequests()).toBe(1);
    expect(google.sends).toHaveLength(2);
    const [send] = google.sends;
    expect(send?.url).toBe('https://fcm.googleapis.com/v1/projects/pingdost-test/messages:send');
    expect(send?.authorization).toBe('Bearer access-1');
    // The entire request body: the token, `{t:"wake"}`, and delivery options. No content.
    expect(send?.body).toEqual({
      message: {
        token: TOKEN,
        data: { t: 'wake' },
        android: { priority: 'HIGH', collapse_key: 'wake', ttl: '1209600s' },
      },
    });
    expect(Object.keys(fcmMessage(TOKEN, PUSH_WAKE, 60).message)).toEqual([
      'token',
      'data',
      'android',
    ]);
  });

  it('maps FCM errors to delete, retry or give up', async () => {
    const cases: [Response, SendOutcome['result'], boolean][] = [
      [fcmError(404, 'UNREGISTERED'), 'invalid_token', false],
      [fcmError(403, 'SENDER_ID_MISMATCH'), 'invalid_token', false],
      [
        fcmError(400, 'INVALID_ARGUMENT', {
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.BadRequest',
              fieldViolations: [{ field: 'message.token' }],
            },
          ],
        }),
        'invalid_token',
        false,
      ],
      // A payload problem must not delete the token, nor may a bare 404 (wrong project).
      [fcmError(400, 'INVALID_ARGUMENT'), 'failed', false],
      [fcmError(404), 'failed', false],
      [fcmError(503, 'UNAVAILABLE'), 'failed', true],
      [fcmError(429, 'QUOTA_EXCEEDED'), 'failed', true],
    ];
    for (const [response, result, retryable] of cases) {
      const outcome = await fcmSender(fakeGoogle(() => response)).send(FCM_TARGET, PUSH_WAKE);
      expect(outcome.result).toBe(result);
      expect(outcome.result === 'failed' && outcome.retryAfterMs !== undefined).toBe(retryable);
    }
  });

  it('honours Retry-After and refreshes the access token after a 401', async () => {
    let calls = 0;
    const google = fakeGoogle(() => {
      calls++;
      if (calls === 1) return json({}, 503, { 'retry-after': '7' });
      if (calls === 2) return json({ error: { code: 401 } }, 401);
      return json({});
    });
    const sender = fcmSender(google);
    expect(await sender.send(FCM_TARGET, PUSH_WAKE)).toMatchObject({ retryAfterMs: 7_000 });
    expect(await sender.send(FCM_TARGET, PUSH_WAKE)).toMatchObject({ retryAfterMs: 0 });
    expect(await sender.send(FCM_TARGET, PUSH_WAKE)).toEqual({ result: 'sent' });
    expect(google.tokenRequests()).toBe(2);
  });

  it('treats network failures as transient and rejects a malformed service account', async () => {
    const sender = new FcmSender({
      projectId: 'p',
      serviceAccountJsonBase64: SERVICE_ACCOUNT,
      ttlSeconds: 60,
      clock: systemClock,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    expect(await sender.send(FCM_TARGET, PUSH_WAKE)).toMatchObject({
      result: 'failed',
      retryAfterMs: 1_000,
    });
    expect(() => parseServiceAccount(Buffer.from('{}').toString('base64'))).toThrow(/client_email/);
    expect(isInvalidToken(400, { error: { message: 'The registration token is not valid' } })).toBe(
      true,
    );
  });
});

describe('Web Push sender', () => {
  const target: PushTarget = {
    provider: 'webpush',
    address: 'https://push.example.com/abc',
    keys: { p256dh: 'p256dh', auth: 'auth' },
  };
  const options = {
    vapidPublicKey: 'public',
    vapidPrivateKey: 'private',
    subject: 'mailto:ops@pingdost.com',
    ttlSeconds: 3_600,
  };

  it('sends only the wake, at high urgency, under one topic', async () => {
    const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201 });
    const sender = new WebPushSender({ ...options, sendNotification });
    expect(await sender.send(target, PUSH_WAKE)).toEqual({ result: 'sent' });
    expect(sendNotification).toHaveBeenCalledWith(
      { endpoint: target.address, keys: target.keys },
      '{"t":"wake"}',
      expect.objectContaining({ urgency: 'high', topic: 'wake', TTL: 3_600 }),
    );
  });

  it('deletes gone subscriptions and retries server errors', async () => {
    const failWith = (status: number) =>
      new WebPushSender({
        ...options,
        sendNotification: () =>
          Promise.reject(new webpush.WebPushError('x', status, {}, '', target.address)),
      });
    expect((await failWith(410).send(target, PUSH_WAKE)).result).toBe('invalid_token');
    expect((await failWith(404).send(target, PUSH_WAKE)).result).toBe('invalid_token');
    expect(await failWith(502).send(target, PUSH_WAKE)).toMatchObject({ retryAfterMs: 1_000 });
    expect(await failWith(400).send(target, PUSH_WAKE)).toEqual({ result: 'failed', status: 400 });
  });
});

describe('PushService', () => {
  function setup(
    outcomes: SendOutcome[] = [],
    options: { connected?: boolean; throttleMs?: number } = {},
  ) {
    const sends: { deviceId: string; payload: PushPayload }[] = [];
    const deleted: string[] = [];
    const sender: PushSender = {
      send: (target, payload) => {
        sends.push({ deviceId: target.address, payload });
        return Promise.resolve(outcomes.shift() ?? { result: 'sent' });
      },
    };
    const metrics = new Metrics({
      redisCommands: () => 0,
      mongoMailbox: () => Promise.resolve({ count: 0, oldestAgeSeconds: 0 }),
    });
    const service = new PushService({
      tokens: {
        get: (deviceId) =>
          Promise.resolve(
            deviceId === 'no-token' ? undefined : { provider: 'fcm', address: deviceId },
          ),
        deleteInvalid: (deviceId) => {
          deleted.push(deviceId);
          return Promise.resolve();
        },
      },
      senders: { fcm: sender },
      throttleMs: options.throttleMs ?? 60,
      clock: systemClock,
      metrics,
      log: pino({ level: 'silent' }),
      isConnected: () => options.connected ?? false,
      retryBaseMs: 1,
    });
    const count = async (result: WakeResult) =>
      (await metrics.pushWakes.get()).values.find((value) => value.labels.result === result)
        ?.value ?? 0;
    return { service, sends, deleted, count };
  }

  it('wakes at once, then collapses a burst into one wake at the end of the window', async () => {
    const { service, sends, count } = setup();
    service.wake('d1', false);
    await service.idle();
    expect(sends).toEqual([{ deviceId: 'd1', payload: { t: 'wake' } }]);

    service.wake('d1', false);
    service.wake('d1', false);
    service.wake('d2', false);
    await service.idle();
    expect(sends.map((send) => send.deviceId)).toEqual(['d1', 'd2']);
    expect(await count('throttled')).toBe(2);

    await vi.waitFor(() => expect(sends).toHaveLength(3));
    expect(sends[2]?.deviceId).toBe('d1');
    await service.close();
  });

  it('skips the deferred wake when the device connected, and lets urgent wakes through', async () => {
    const { service, sends, count } = setup([], { connected: true });
    service.wake('d1', false);
    service.wake('d1', true);
    service.wake('d1', false);
    await service.idle();
    expect(sends).toHaveLength(2);
    await vi.waitFor(async () => expect(await count('skipped_connected')).toBe(1));
    expect(sends).toHaveLength(2);
    await service.close();
  });

  it('deletes rejected tokens, retries transient failures a bounded number of times', async () => {
    const { service, sends, deleted, count } = setup([
      { result: 'invalid_token' },
      { result: 'failed', retryAfterMs: 0 },
      { result: 'failed', retryAfterMs: 0 },
      { result: 'sent' },
      { result: 'failed', retryAfterMs: 0 },
      { result: 'failed', retryAfterMs: 0 },
      { result: 'failed', retryAfterMs: 0 },
      { result: 'failed', status: 400 },
    ]);
    for (const deviceId of ['gone', 'flaky', 'down', 'bad', 'no-token']) {
      service.wake(deviceId, false);
      await service.idle();
    }
    expect(deleted).toEqual(['gone']);
    expect(sends.map((send) => send.deviceId)).toEqual([
      'gone',
      ...['flaky', 'flaky', 'flaky'],
      ...['down', 'down', 'down'],
      'bad',
    ]);
    expect(await count('invalid_token')).toBe(1);
    expect(await count('sent')).toBe(1);
    expect(await count('failed')).toBe(2);
    expect(await count('no_token')).toBe(1);
    await service.close();
  });

  it('drops wakes after close', async () => {
    const { service, sends } = setup();
    await service.close();
    service.wake('d1', false);
    await service.idle();
    expect(sends).toEqual([]);
  });
});
