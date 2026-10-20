/**
 * Web pairing (REQ §13.1, §19.5; ADR 0019) end to end with real keys: the browser's request,
 * the primary phone's inspection and approval (device signature plus account certificate),
 * the browser's proof of possession, and every refusal: expired, replayed, wrong challenge,
 * non-primary approver, double approval, polling without the secret, bad signatures, rate limit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CryptoProvider, SigningKey } from '@pingdost/crypto';
import {
  deviceCertificateMessage,
  deviceRegistrationMessage,
  pairingApprovalMessage,
  uuidv7,
} from '@pingdost/protocol';
import {
  PAIRING_SECRET_HEADER,
  type CreatePairingResponse,
  type DeviceSummary,
  type PairingStatusResponse,
  type RegisterDeviceResponse,
} from '@pingdost/shared-types';

import { cryptoProvider, newDevice, registerDevice, type TestDevice } from './devices';
import { bearer, json, registeredUser, startTestServer, type TestServer } from './helpers';

let server: TestServer;
let crypto: CryptoProvider;
const revoked: string[] = [];

beforeAll(async () => {
  crypto = await cryptoProvider();
  server = await startTestServer({ onDeviceRevoked: [(deviceId) => revoked.push(deviceId)] });
});

afterAll(async () => {
  await server.close();
});

interface Phone {
  userId: string;
  accessToken: string;
  device: TestDevice;
  identity: SigningKey;
}

async function phone(): Promise<Phone> {
  const session = await registeredUser(server);
  const device = newDevice(crypto);
  const identity = crypto.createSigningKey();
  const { tokens } = await registerDevice(server, session.accessToken, device, identity);
  return { userId: session.userId, accessToken: tokens.accessToken, device, identity };
}

/** A browser: its own Olm account and a fresh pairing request. */
async function browser(name = 'Chrome on Windows') {
  const device = newDevice(crypto);
  const response = await server.app.inject({
    method: 'POST',
    url: '/v1/pairing/requests',
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/150' },
    payload: { identityKeys: device.keys, name },
  });
  expect(response.statusCode).toBe(201);
  return { device, request: json<CreatePairingResponse>(response) };
}

type Browser = Awaited<ReturnType<typeof browser>>;

function approval(owner: Phone, web: Browser, overrides: Record<string, unknown> = {}) {
  const deviceId = (overrides.deviceId as string | undefined) ?? uuidv7();
  return {
    pairingId: web.request.pairingId,
    challenge: web.request.challenge,
    deviceId,
    webKeys: web.device.keys,
    signature: owner.device.account.sign(
      pairingApprovalMessage(
        web.request.pairingId,
        web.request.challenge,
        deviceId,
        web.device.keys,
      ),
    ),
    deviceCertificate: owner.identity.sign(deviceCertificateMessage(deviceId, web.device.keys)),
    ...overrides,
  };
}

function approve(accessToken: string, payload: object) {
  return server.app.inject({
    method: 'POST',
    url: '/v1/pairing/approve',
    headers: bearer(accessToken),
    payload,
  });
}

function poll(pairingId: string, secret?: string) {
  return server.app.inject({
    method: 'GET',
    url: `/v1/pairing/requests/${pairingId}`,
    headers: secret === undefined ? {} : { [PAIRING_SECRET_HEADER]: secret },
  });
}

function complete(
  web: Browser,
  status: PairingStatusResponse,
  overrides: Record<string, unknown> = {},
) {
  return server.app.inject({
    method: 'POST',
    url: `/v1/pairing/requests/${web.request.pairingId}/complete`,
    payload: {
      pollSecret: web.request.pollSecret,
      signature: web.device.account.sign(
        deviceRegistrationMessage(status.nonce!, status.deviceId!, web.device.keys),
      ),
      ...overrides,
    },
  });
}

const code = (response: { body: string }) => (JSON.parse(response.body) as { code?: string }).code;

async function linked(owner: Phone, web: Browser): Promise<RegisterDeviceResponse> {
  expect((await approve(owner.accessToken, approval(owner, web))).statusCode).toBe(204);
  const status = json<PairingStatusResponse>(
    await poll(web.request.pairingId, web.request.pollSecret),
  );
  const done = await complete(web, status);
  expect(done.statusCode).toBe(201);
  return json<RegisterDeviceResponse>(done);
}

describe('web pairing', () => {
  it('links a browser only after the phone approves and the browser proves its keys', async () => {
    const owner = await phone();
    const web = await browser();

    // The QR code carries no secret; polling needs the one the browser kept.
    expect(
      json<PairingStatusResponse>(await poll(web.request.pairingId, web.request.pollSecret)),
    ).toEqual({
      status: 'pending',
    });

    const inspected = await server.app.inject({
      method: 'POST',
      url: '/v1/pairing/inspect',
      headers: bearer(owner.accessToken),
      payload: { pairingId: web.request.pairingId, challenge: web.request.challenge },
    });
    expect(json(inspected)).toMatchObject({
      name: 'Chrome on Windows',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/150',
      identityKeys: web.device.keys,
    });

    const deviceId = uuidv7();
    expect((await approve(owner.accessToken, approval(owner, web, { deviceId }))).statusCode).toBe(
      204,
    );
    // Nothing is registered until the browser completes.
    expect(
      await server.mongo.db.collection('devices').countDocuments({ _id: deviceId as never }),
    ).toBe(0);

    const status = json<PairingStatusResponse>(
      await poll(web.request.pairingId, web.request.pollSecret),
    );
    expect(status).toMatchObject({ status: 'approved', deviceId });
    const done = await complete(web, status);
    expect(done.statusCode).toBe(201);
    const { device, tokens } = json<RegisterDeviceResponse>(done);
    expect(device).toMatchObject({ deviceId, platform: 'web', role: 'linked', status: 'active' });

    // The browser's tokens are bound to it; the phone lists it; contacts see it in the directory.
    const devices = await server.app.inject({
      method: 'GET',
      url: '/v1/devices',
      headers: bearer(tokens.accessToken),
    });
    expect(
      json<{ devices: DeviceSummary[] }>(devices)
        .devices.map((d) => d.role)
        .sort(),
    ).toEqual(['linked', 'primary']);
    const directory = await server.app.inject({
      method: 'GET',
      url: `/v1/keys/users/${owner.userId}`,
      headers: bearer(owner.accessToken),
    });
    expect(JSON.stringify(json(directory))).toContain(web.device.keys.ed25519);
    expect(
      await server.mongo.db.collection('security_events').countDocuments({
        userId: owner.userId,
        type: { $in: ['pairing_approve', 'device_link'] },
      }),
    ).toBe(2);

    // Single use: neither the approval nor the completion can be replayed.
    expect(code(await approve(owner.accessToken, approval(owner, web)))).toBe(
      'PAIRING_ALREADY_USED',
    );
    expect(code(await complete(web, status))).toBe('PAIRING_ALREADY_USED');
    expect(code(await poll(web.request.pairingId, web.request.pollSecret))).toBe(
      'PAIRING_ALREADY_USED',
    );
  });

  it('refuses expired requests, and a QR code shown again after it expired', async () => {
    const owner = await phone();
    const web = await browser();
    server.clock.advance(server.config.WEB_PAIRING_TTL_SECONDS * 1_000 + 1);
    try {
      expect(
        json<PairingStatusResponse>(await poll(web.request.pairingId, web.request.pollSecret)),
      ).toEqual({
        status: 'expired',
      });
      const late = await approve(owner.accessToken, approval(owner, web));
      expect(late.statusCode).toBe(410);
      expect(code(late)).toBe('PAIRING_EXPIRED');
    } finally {
      server.clock.advance(-(server.config.WEB_PAIRING_TTL_SECONDS * 1_000 + 1));
    }
  });

  it('refuses a wrong challenge, polling without the secret, and a guessed ID', async () => {
    const owner = await phone();
    const web = await browser();
    const wrong = await approve(
      owner.accessToken,
      approval(owner, web, { challenge: 'A'.repeat(43) }),
    );
    expect(code(wrong)).toBe('PAIRING_NOT_FOUND');
    expect(code(await poll(web.request.pairingId))).toBe('PAIRING_NOT_FOUND');
    expect(code(await poll(web.request.pairingId, 'B'.repeat(43)))).toBe('PAIRING_NOT_FOUND');
    expect(code(await poll(uuidv7(), web.request.pollSecret))).toBe('PAIRING_NOT_FOUND');
    // The browser cannot complete what nobody approved.
    const early = await complete(web, {
      status: 'approved',
      deviceId: uuidv7(),
      nonce: 'C'.repeat(43),
    });
    expect(code(early)).toBe('CONFLICT');
  });

  it('accepts approval only from the primary phone, once', async () => {
    const owner = await phone();
    const first = await browser();
    const { tokens: webTokens } = await linked(owner, first);

    // A linked browser cannot link another browser.
    const second = await browser('Firefox on Linux');
    const fromWeb = await approve(webTokens.accessToken, approval(owner, second));
    expect(fromWeb.statusCode).toBe(403);

    // A session without a device cannot either.
    const bare = await registeredUser(server);
    expect((await approve(bare.accessToken, approval(owner, second))).statusCode).toBe(403);

    // Double approval: the second is refused, also from another account.
    const other = await phone();
    expect((await approve(owner.accessToken, approval(owner, second))).statusCode).toBe(204);
    expect(code(await approve(owner.accessToken, approval(owner, second)))).toBe(
      'PAIRING_ALREADY_USED',
    );
    expect(code(await approve(other.accessToken, approval(other, second)))).toBe(
      'PAIRING_ALREADY_USED',
    );
  });

  it('refuses bad signatures and keys that are not the ones requested', async () => {
    const owner = await phone();
    const web = await browser();
    const stranger = crypto.createSigningKey();
    const deviceId = uuidv7();

    const badCertificate = await approve(
      owner.accessToken,
      approval(owner, web, {
        deviceId,
        deviceCertificate: stranger.sign(deviceCertificateMessage(deviceId, web.device.keys)),
      }),
    );
    expect(code(badCertificate)).toBe('INVALID_SIGNATURE');

    const notPhone = await approve(
      owner.accessToken,
      approval(owner, web, {
        signature: stranger.sign(
          pairingApprovalMessage(
            web.request.pairingId,
            web.request.challenge,
            deviceId,
            web.device.keys,
          ),
        ),
        deviceId,
      }),
    );
    expect(code(notPhone)).toBe('INVALID_SIGNATURE');

    const swapped = await approve(
      owner.accessToken,
      approval(owner, web, { webKeys: newDevice(crypto).keys }),
    );
    expect(code(swapped)).toBe('VALIDATION_FAILED');

    // Approved, but the browser cannot prove it holds the keys: no device.
    expect((await approve(owner.accessToken, approval(owner, web))).statusCode).toBe(204);
    const status = json<PairingStatusResponse>(
      await poll(web.request.pairingId, web.request.pollSecret),
    );
    const impostor = newDevice(crypto);
    const fake = await complete(web, status, {
      signature: impostor.account.sign(
        deviceRegistrationMessage(status.nonce!, status.deviceId!, web.device.keys),
      ),
    });
    expect(code(fake)).toBe('INVALID_SIGNATURE');
    // The real browser still can.
    expect((await complete(web, status)).statusCode).toBe(201);
  });

  it('lets the phone revoke a linked browser: its sessions end and the gateway is told', async () => {
    const owner = await phone();
    const web = await browser();
    const { device, tokens } = await linked(owner, web);
    const revoke = await server.app.inject({
      method: 'DELETE',
      url: `/v1/devices/${device.deviceId}`,
      headers: bearer(owner.accessToken),
    });
    expect(revoke.statusCode).toBe(204);
    expect(revoked).toContain(device.deviceId);
    const refresh = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: tokens.refreshToken },
    });
    expect(refresh.statusCode).toBeGreaterThanOrEqual(400);
    const directory = await server.app.inject({
      method: 'GET',
      url: `/v1/keys/users/${owner.userId}`,
      headers: bearer(owner.accessToken),
    });
    expect(JSON.stringify(json(directory))).not.toContain(web.device.keys.ed25519);
  });

  it('allows the web origin through CORS and nobody else', async () => {
    const preflight = (origin: string) =>
      server.app.inject({
        method: 'OPTIONS',
        url: '/v1/pairing/requests',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type',
        },
      });
    const allowed = await preflight(server.config.WEB_ORIGIN);
    expect(allowed.headers['access-control-allow-origin']).toBe(server.config.WEB_ORIGIN);
    const other = await preflight('https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('web pairing rate limits', () => {
  it('limits how often one address can create requests', async () => {
    const limited = await startTestServer({
      routeLimits: { pairingCreate: { max: 2, timeWindow: 60_000 } },
    });
    try {
      const keys = newDevice(crypto).keys;
      const create = () =>
        limited.app.inject({
          method: 'POST',
          url: '/v1/pairing/requests',
          payload: { identityKeys: keys, name: 'Chrome' },
        });
      expect((await create()).statusCode).toBe(201);
      expect((await create()).statusCode).toBe(201);
      const third = await create();
      expect(third.statusCode).toBe(429);
    } finally {
      await limited.close();
    }
  });
});
