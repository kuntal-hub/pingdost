/**
 * Replacing the primary phone (Phase 19, ADR 0022), through the real server:
 * - path (a): the old phone approves after the codes match; WS prompt; old phone revoked;
 *   refusals (replay, deny, expiry, other accounts, recent login, bad certificate);
 * - path (b): an email code and the backup's account key; then restore → SessionReset →
 *   the contact resends what the lost phone missed and chatting resumes (sim clients);
 * - path (c): an email code and a fresh account key: every device is revoked and the
 *   contact sees a new safety number;
 * - the per-account budget.
 */
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { keysApi } from '@pingdost/api-client';
import {
  BackupReader,
  BackupWriter,
  exportToBackup,
  generatePhrase,
  memorySink,
  memorySource,
  phraseEntropy,
  restoreFromBackup,
  transferOneTimeKey,
} from '@pingdost/backup';
import type { CryptoProvider } from '@pingdost/crypto';
import { MemoryEngineStore, type MessageRecord } from '@pingdost/message-engine';
import { deviceCertificateMessage } from '@pingdost/protocol';
import type {
  DeviceSummary,
  PrimaryTransferStatusResponse,
  StartPrimaryTransferResponse,
} from '@pingdost/shared-types';
import { SimClient, type SimClientOptions } from '@pingdost/sim-client';

import {
  challenge,
  cryptoProvider,
  newDevice,
  registerDevice,
  registrationBody,
  type TestDevice,
} from './devices';
import {
  bearer,
  json,
  MAILPIT_URL,
  otpFor,
  registeredUser,
  startTestServer,
  type TestServer,
} from './helpers';

let server: TestServer;
let crypto: CryptoProvider;
let port = 0;
const clients: SimClient[] = [];
const revoked: string[] = [];

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({
    onDeviceRevoked: [(deviceId) => revoked.push(deviceId)],
    throttles: { keyClaims: { limit: 10_000, windowMs: 3_600_000 } },
  });
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  port = (server.app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const client of clients) await client.stop().catch(() => undefined);
  await server.close();
});

const code = (response: { body: string }) => (JSON.parse(response.body) as { code?: string }).code;

function options(): SimClientOptions {
  return {
    endpoints: {
      api: `http://127.0.0.1:${port}`,
      ws: `ws://127.0.0.1:${port}/v1/ws`,
      mailpit: MAILPIT_URL,
    },
    crypto,
    settings: { directoryMaxAgeMs: 0, receiptDelayMs: 50, retry: { baseMs: 200, maxMs: 1_000 } },
  };
}

async function until(condition: () => boolean | Promise<boolean>, what: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// REST-level helpers

interface Account {
  user: Awaited<ReturnType<typeof registeredUser>>['user'];
  userId: string;
  phoneToken: string;
  phone: TestDevice;
  identity: ReturnType<CryptoProvider['createSigningKey']>;
}

async function account(): Promise<Account> {
  const session = await registeredUser(server);
  const phone = newDevice(crypto);
  const identity = crypto.createSigningKey();
  const { tokens } = await registerDevice(server, session.accessToken, phone, identity);
  return {
    user: session.user,
    userId: session.userId,
    phoneToken: tokens.accessToken,
    phone,
    identity,
  };
}

/** A fresh login (a new phone): returns its device-less tokens. */
async function login(owner: Account) {
  const response = await server.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { identifier: owner.user.username, password: owner.user.password },
  });
  expect(response.statusCode).toBe(200);
  return json<{ tokens: { accessToken: string; refreshToken: string } }>(response).tokens;
}

function start(token: string, device: TestDevice) {
  return server.app.inject({
    method: 'POST',
    url: '/v1/devices/primary-transfer',
    headers: bearer(token),
    payload: {
      deviceId: device.deviceId,
      platform: 'android',
      name: 'New phone',
      identityKeys: device.keys,
      oneTimeKey: transferOneTimeKey(device.account, device.deviceId),
    },
  });
}

function post(token: string, url: string, payload?: object) {
  return server.app.inject({
    method: 'POST',
    url,
    headers: bearer(token),
    ...(payload ? { payload } : {}),
  });
}

function status(token: string, requestId: string) {
  return server.app.inject({
    method: 'GET',
    url: `/v1/devices/primary-transfer/${requestId}`,
    headers: bearer(token),
  });
}

function approval(owner: Account, device: TestDevice) {
  const sealed = owner.phone.account
    .createOutboundSession(device.keys.curve25519, device.account.oneTimeKeys().at(-1)!.publicKey)
    .encrypt(new TextEncoder().encode('not checked by the server'));
  return {
    deviceCertificate: owner.identity.sign(deviceCertificateMessage(device.deviceId, device.keys)),
    sealed: Buffer.from(sealed.body).toString('base64'),
  };
}

async function devicesOf(token: string): Promise<DeviceSummary[]> {
  const response = await server.app.inject({
    method: 'GET',
    url: '/v1/devices',
    headers: bearer(token),
  });
  return json<{ devices: DeviceSummary[] }>(response).devices;
}

describe('path (a): the old phone approves', () => {
  it('moves the account to the new phone, with the WS prompt and the old phone revoked', async () => {
    const old = await SimClient.register(options());
    clients.push(old);
    const prompts: string[] = [];
    const ended: string[] = [];
    old.transport.onEvent((event) => {
      if (event.type === 'primary_transfer') prompts.push(event.requestId);
      if (event.type === 'revoked') ended.push('revoked');
    });
    await old.start();
    await until(() => old.transport.status === 'online', 'old phone online');

    const next = await SimClient.newPhone(options(), old, { mode: 'transfer' });
    clients.push(next);
    expect(prompts).toHaveLength(1);
    expect(next.deviceId).not.toBe(old.deviceId);
    expect(next.identity?.publicKey()).toBe(old.accountIdentityKey);
    await until(() => ended.length === 1, 'old phone revoked');
    expect(revoked).toContain(old.deviceId);

    // The directory lists only the new primary, under the same account key.
    const keys = await keysApi(next.api).directory(old.userId);
    expect(keys.accountIdentityKey).toBe(old.accountIdentityKey);
    expect(keys.devices.map((d) => [d.deviceId, d.role])).toEqual([[next.deviceId, 'primary']]);
  });

  it('refuses replays, a second decision, expiry, strangers and stale logins', async () => {
    const owner = await account();
    const stranger = await account();
    const fresh = await login(owner);
    const device = newDevice(crypto);
    const started = await start(fresh.accessToken, device);
    expect(started.statusCode).toBe(201);
    const { requestId } = json<StartPrimaryTransferResponse>(started);

    // Only the account's own devices see it; a device-less session cannot list.
    const listed = await server.app.inject({
      method: 'GET',
      url: '/v1/devices/primary-transfer',
      headers: bearer(owner.phoneToken),
    });
    expect(json<{ requests: { requestId: string }[] }>(listed).requests).toEqual([
      expect.objectContaining({ requestId, deviceId: device.deviceId }),
    ]);
    const strangerList = await server.app.inject({
      method: 'GET',
      url: '/v1/devices/primary-transfer',
      headers: bearer(stranger.phoneToken),
    });
    expect(json<{ requests: unknown[] }>(strangerList).requests).toEqual([]);
    const url = `/v1/devices/primary-transfer/${requestId}`;
    expect(
      code(await post(stranger.phoneToken, `${url}/approve`, approval(stranger, device))),
    ).toBe('TRANSFER_NOT_FOUND');
    expect(code(await post(fresh.accessToken, `${url}/approve`, approval(owner, device)))).toBe(
      'DEVICE_REQUIRED',
    );

    // A certificate from another account key is refused.
    const wrong = { ...approval(owner, device) };
    wrong.deviceCertificate = stranger.identity.sign(
      deviceCertificateMessage(device.deviceId, device.keys),
    );
    expect(code(await post(owner.phoneToken, `${url}/approve`, wrong))).toBe('INVALID_SIGNATURE');

    // Completing before approval is refused; then approve once.
    expect(code(await post(fresh.accessToken, `${url}/complete`, { signature: 'AAAA' }))).toBe(
      'CONFLICT',
    );
    expect(
      (await post(owner.phoneToken, `${url}/approve`, approval(owner, device))).statusCode,
    ).toBe(204);
    expect(code(await post(owner.phoneToken, `${url}/approve`, approval(owner, device)))).toBe(
      'TRANSFER_ALREADY_USED',
    );
    expect(code(await post(owner.phoneToken, `${url}/deny`))).toBe('TRANSFER_ALREADY_USED');

    // Only the requesting session polls; a bad proof of possession fails.
    expect((await status(owner.phoneToken, requestId)).statusCode).toBe(404);
    const approved = json<PrimaryTransferStatusResponse>(
      await status(fresh.accessToken, requestId),
    );
    expect(approved.status).toBe('approved');
    expect(code(await post(fresh.accessToken, `${url}/complete`, { signature: 'AAAA' }))).toBe(
      'INVALID_SIGNATURE',
    );
    const { deviceRegistrationMessage } = await import('@pingdost/protocol');
    const signature = device.account.sign(
      deviceRegistrationMessage(approved.approval!.nonce, device.deviceId, device.keys),
    );
    const done = await post(fresh.accessToken, `${url}/complete`, { signature });
    expect(done.statusCode).toBe(201);
    // Replayed completion.
    expect(code(await post(fresh.accessToken, `${url}/complete`, { signature }))).toBe('CONFLICT');
    expect(revoked).toContain(owner.phone.deviceId);
    const after = json<{ tokens: { accessToken: string } }>(done).tokens.accessToken;
    const devices = await devicesOf(after);
    expect(devices.filter((d) => d.status === 'active').map((d) => d.deviceId)).toEqual([
      device.deviceId,
    ]);
  });

  it('honours a denial and an expiry, and needs a recent login', async () => {
    const owner = await account();
    const fresh = await login(owner);
    const first = newDevice(crypto);
    const { requestId: denied } = json<StartPrimaryTransferResponse>(
      await start(fresh.accessToken, first),
    );
    expect(
      (await post(owner.phoneToken, `/v1/devices/primary-transfer/${denied}/deny`)).statusCode,
    ).toBe(204);
    expect(
      json<PrimaryTransferStatusResponse>(await status(fresh.accessToken, denied)).status,
    ).toBe('denied');
    expect(
      code(
        await post(
          owner.phoneToken,
          `/v1/devices/primary-transfer/${denied}/approve`,
          approval(owner, first),
        ),
      ),
    ).toBe('TRANSFER_ALREADY_USED');

    const second = newDevice(crypto);
    const { requestId: late } = json<StartPrimaryTransferResponse>(
      await start(fresh.accessToken, second),
    );
    server.clock.advance(11 * 60_000);
    try {
      expect(
        json<PrimaryTransferStatusResponse>(await status(fresh.accessToken, late)).status,
      ).toBe('expired');
      expect(
        code(
          await post(
            owner.phoneToken,
            `/v1/devices/primary-transfer/${late}/approve`,
            approval(owner, second),
          ),
        ),
      ).toBe('TRANSFER_EXPIRED');

      // Past 15 minutes the login is not recent, even with a refreshed access token.
      server.clock.advance(5 * 60_000);
      const refreshed = await server.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: fresh.refreshToken },
      });
      expect(refreshed.statusCode).toBe(200);
      const token = json<{ accessToken: string }>(refreshed).accessToken;
      expect(code(await start(token, newDevice(crypto)))).toBe('RECENT_LOGIN_REQUIRED');
      expect(code(await post(token, '/v1/devices/primary-replace/otp'))).toBe(
        'RECENT_LOGIN_REQUIRED',
      );
    } finally {
      server.clock.offsetMs = 0;
    }
    // A device-bound session is not a new phone.
    expect(code(await start(owner.phoneToken, newDevice(crypto)))).toBe('CONFLICT');
  });
});

describe('path (b): restore from a backup with an email code', () => {
  it('replaces the lost phone; the contact resends what it missed and chatting resumes', async () => {
    const alice = await SimClient.register(options());
    const bob = await SimClient.register(options());
    clients.push(alice, bob);
    await alice.linkWith(bob);
    await alice.start();
    await bob.start();
    const { conversationId } = await alice.engine.openDirectConversation(bob.userId);
    await alice.engine.sendText(conversationId, 'before the backup');
    await until(async () => (await bob.engine.listMessages(conversationId)).length === 1, 'first');

    // Bob's backup, kept by Bob.
    const words = generatePhrase();
    const sink = memorySink();
    const writer = await BackupWriter.create({
      crypto,
      entropy: phraseEntropy(words),
      sink,
      kdf: { memoryKib: 1024, iterations: 1, parallelism: 1 },
      manifest: {
        createdAt: Date.now(),
        userId: bob.userId,
        accountIdentityKey: bob.accountIdentityKey,
        app: 'sim-client',
        includesFiles: false,
      },
    });
    await exportToBackup({
      store: bob.engineStore,
      crypto,
      pickleKey: bob.pickleKey,
      writer,
      selfUserId: bob.userId,
      identitySecret: bob.identity!.exportSecret(),
    });
    await writer.finish();
    const file = sink.bytes();

    // Bob's phone is lost. Alice keeps writing.
    await bob.stop();
    const missed = await alice.engine.sendText(conversationId, 'while the phone was lost');
    await until(
      async () => (await alice.engine.getMessage(missed.messageId))?.state === 'sent_to_server',
      'missed message on the server',
    );

    // The new phone: the identity key from the backup, an email code, then the history.
    const reader = await BackupReader.open(crypto, memorySource(file), phraseEntropy(words));
    expect(reader.manifest.userId).toBe(bob.userId);
    const identitySecret = await reader.identitySecret();
    const store = new MemoryEngineStore();
    const bob2 = await SimClient.newPhone({ ...options(), store }, bob, {
      mode: 'restore',
      identitySecret,
    });
    clients.push(bob2);
    expect(revoked).toContain(bob.deviceId);
    const result = await restoreFromBackup({
      reader,
      store,
      crypto,
      pickleKey: bob2.pickleKey,
    });
    expect(result.peerUserIds).toEqual([alice.userId]);
    await bob2.start();
    expect(await bob2.engine.announceNewDevice(result.peerUserIds)).toBe(1);

    const bodies = async () =>
      (await bob2.engine.listMessages(conversationId)).map((m: MessageRecord) => m.body);
    await until(
      async () => (await bodies()).includes('while the phone was lost'),
      'missed message on the new phone',
    );
    expect((await bodies()).filter((b) => b === 'before the backup')).toHaveLength(1);
    await until(
      async () =>
        (await alice.engine.getMessage(missed.messageId))?.state ===
        'delivered_to_recipient_device',
      'missed message delivered',
    );
    const notices = (await alice.engine.listMessages(conversationId)).filter(
      (m) => m.kind === 'system',
    );
    expect(notices.map((m) => m.body)).toEqual(['primary_device_changed']);

    await bob2.engine.sendText(conversationId, 'back again');
    await until(
      async () =>
        (await alice.engine.listMessages(conversationId)).some((m) => m.body === 'back again'),
      'reply from the new phone',
    );
    reader.dispose();
  });

  it('needs the right code and the account key from the backup', async () => {
    const owner = await account();
    const fresh = await login(owner);
    expect((await post(fresh.accessToken, '/v1/devices/primary-replace/otp')).statusCode).toBe(204);
    const otp = await otpFor(owner.user.email, 2);
    const device = newDevice(crypto);
    const body = (otpCode: string, identity = owner.identity, nonce = '') => ({
      ...registrationBody(device, identity, nonce),
      mode: 'restore',
      otp: otpCode,
    });
    // Another account key: refused before the code is checked (the code stays usable).
    const other = crypto.createSigningKey();
    expect(
      code(
        await post(
          fresh.accessToken,
          '/v1/devices/primary-replace',
          body(otp, other, await challenge(server, fresh.accessToken)),
        ),
      ),
    ).toBe('IDENTITY_KEY_MISMATCH');
    const wrongCode = otp === '000000' ? '111111' : '000000';
    expect(
      code(
        await post(
          fresh.accessToken,
          '/v1/devices/primary-replace',
          body(wrongCode, owner.identity, await challenge(server, fresh.accessToken)),
        ),
      ),
    ).toBe('OTP_INVALID');
    const done = await post(
      fresh.accessToken,
      '/v1/devices/primary-replace',
      body(otp, owner.identity, await challenge(server, fresh.accessToken)),
    );
    expect(done.statusCode).toBe(201);
    expect(revoked).toContain(owner.phone.deviceId);
    // The session now has a device; and the code works once, even from another login.
    expect(code(await post(fresh.accessToken, '/v1/devices/primary-replace/otp'))).toBe('CONFLICT');
    const again = await login(owner);
    const replayed = newDevice(crypto);
    expect(
      code(
        await post(again.accessToken, '/v1/devices/primary-replace', {
          ...registrationBody(replayed, owner.identity, await challenge(server, again.accessToken)),
          mode: 'restore',
          otp,
        }),
      ),
    ).toBe('OTP_EXPIRED');
  });
});

describe('path (c): start fresh', () => {
  it('revokes every device and gives the account a new key; contacts see a new safety number', async () => {
    const alice = await SimClient.register(options());
    const carol = await SimClient.register(options());
    clients.push(alice, carol);
    await alice.linkWith(carol);
    await alice.start();
    await carol.start();
    const { conversationId } = await alice.engine.openDirectConversation(carol.userId);
    await alice.engine.sendText(conversationId, 'hello carol');
    await until(async () => (await carol.engine.listMessages(conversationId)).length === 1, 'hi');
    const browser = await SimClient.linkedDevice(options(), carol);
    clients.push(browser);
    await carol.stop();

    const carol2 = await SimClient.newPhone(options(), carol, { mode: 'fresh' });
    clients.push(carol2);
    expect(carol2.accountIdentityKey).not.toBe(carol.accountIdentityKey);
    expect(revoked).toEqual(expect.arrayContaining([carol.deviceId, browser.deviceId]));
    await carol2.start();

    await alice.engine.sendText(conversationId, 'are you there?');
    await until(
      async () =>
        (await carol2.engine.listMessages(conversationId)).some((m) => m.body === 'are you there?'),
      'message to the fresh phone',
    );
    const notices = (await alice.engine.listMessages(conversationId)).filter(
      (m) => m.kind === 'system',
    );
    expect(notices.map((m) => m.body)).toEqual(['safety_number_changed']);
    // No history came back: only the new message.
    expect((await carol2.engine.listMessages(conversationId)).map((m) => m.body)).toEqual([
      'are you there?',
    ]);
  });
});

describe('budgets', () => {
  it('limits phone-change attempts per account', async () => {
    const limited = await startTestServer({
      throttles: { phoneReplacements: { limit: 2, windowMs: 3_600_000 } },
    });
    try {
      const session = await registeredUser(limited);
      const phone = newDevice(crypto);
      await registerDevice(limited, session.accessToken, phone, crypto.createSigningKey());
      const fresh = await limited.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { identifier: session.user.username, password: session.user.password },
      });
      const token = json<{ tokens: { accessToken: string } }>(fresh).tokens.accessToken;
      const attempt = () =>
        limited.app.inject({
          method: 'POST',
          url: '/v1/devices/primary-replace/otp',
          headers: bearer(token),
        });
      // The second send is in the resend cooldown (also a 429), but not over the budget.
      expect((await attempt()).statusCode).toBe(204);
      expect(code(await attempt())).toBe('OTP_RESEND_COOLDOWN');
      expect(code(await attempt())).toBe('RATE_LIMITED');
    } finally {
      await limited.close();
    }
  });
});
