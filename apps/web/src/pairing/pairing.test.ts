import { beforeAll, describe, expect, it } from 'vitest';

import { browserName } from '@/session/browser-name';
import type { PairingApi } from '@pingdost/api-client';
import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import { deviceRegistrationMessage, parsePairingQr, uuidv7 } from '@pingdost/protocol';
import type {
  CreatePairingRequest,
  PairingStatusResponse,
  RegisterDeviceResponse,
} from '@pingdost/shared-types';

import { isStopped, pairBrowser, POLL_MS } from './pairing';

let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

/** The server and the phone, as far as the browser can tell. */
function fakeServer(clock: { now: number }) {
  const requests: (CreatePairingRequest & {
    pairingId: string;
    pollSecret: string;
    expiresAt: number;
  })[] = [];
  let approval: { deviceId: string; nonce: string; pairingId: string } | undefined;
  let offlinePolls = 0;
  const api: Pick<PairingApi, 'create' | 'status' | 'complete'> = {
    create: (body) => {
      const request = {
        ...body,
        pairingId: uuidv7(),
        pollSecret: 'secret-' + String(requests.length),
        expiresAt: clock.now + 120_000,
      };
      requests.push(request);
      return Promise.resolve({
        pairingId: request.pairingId,
        challenge: 'Q'.repeat(43),
        pollSecret: request.pollSecret,
        expiresAt: request.expiresAt,
      });
    },
    status: (pairingId, pollSecret): Promise<PairingStatusResponse> => {
      if (offlinePolls > 0) {
        offlinePolls--;
        return Promise.reject(Object.assign(new Error('offline'), { kind: 'network' }));
      }
      const request = requests.find((r) => r.pairingId === pairingId);
      if (!request || request.pollSecret !== pollSecret) return Promise.reject(new Error('404'));
      if (clock.now >= request.expiresAt) return Promise.resolve({ status: 'expired' });
      return Promise.resolve(
        approval?.pairingId === pairingId
          ? { status: 'approved', deviceId: approval.deviceId, nonce: approval.nonce }
          : { status: 'pending' },
      );
    },
    complete: (pairingId, body): Promise<RegisterDeviceResponse> => {
      const request = requests.find((r) => r.pairingId === pairingId)!;
      const ok =
        approval !== undefined &&
        body.pollSecret === request.pollSecret &&
        provider.verifyEd25519(
          request.identityKeys.ed25519,
          deviceRegistrationMessage(approval.nonce, approval.deviceId, request.identityKeys),
          body.signature,
        );
      if (!ok) return Promise.reject(new Error('INVALID_SIGNATURE'));
      return Promise.resolve({
        device: {
          deviceId: approval!.deviceId,
          platform: 'web',
          role: 'linked',
          name: request.name,
          status: 'active',
          createdAt: clock.now,
          lastSeenAt: null,
          revokedAt: null,
        },
        tokens: {
          accessToken: 'access',
          accessTokenExpiresAt: clock.now + 900_000,
          refreshToken: 'refresh',
          refreshTokenExpiresAt: clock.now + 86_400_000,
        },
      });
    },
  };
  return {
    api,
    requests,
    approveLatest: () => {
      approval = {
        pairingId: requests.at(-1)!.pairingId,
        deviceId: uuidv7(),
        nonce: 'N'.repeat(43),
      };
    },
    goOffline: (polls: number) => (offlinePolls = polls),
  };
}

function harness(onPoll: (server: ReturnType<typeof fakeServer>, polls: number) => void) {
  const clock = { now: 1_000_000 };
  const server = fakeServer(clock);
  const codes: string[] = [];
  const offline: boolean[] = [];
  let polls = 0;
  const deps = {
    provider,
    api: server.api,
    origin: 'http://localhost:5173',
    name: 'Chrome on Windows',
    onCode: (code: { text: string }) => codes.push(code.text),
    onOffline: (value: boolean) => offline.push(value),
    now: () => clock.now,
    sleep: (ms: number) => {
      clock.now += ms;
      polls++;
      onPoll(server, polls);
      return Promise.resolve();
    },
  };
  return { deps, server, codes, offline };
}

describe('pairBrowser (ADR 0019)', () => {
  it('renews the code before it expires with the same keys, then proves its keys', async () => {
    // Approve on the 70th poll: after the first code was renewed.
    const { deps, server, codes } = harness((s, polls) => polls === 70 && s.approveLatest());
    const linked = await pairBrowser(deps, new AbortController().signal);
    expect(codes.length).toBeGreaterThanOrEqual(2);
    const [first, second] = codes.map(parsePairingQr);
    expect(first!.pairingId).not.toBe(second!.pairingId);
    expect(first!.ed25519).toBe(second!.ed25519);
    expect(first!.origin).toBe('http://localhost:5173');
    // Renewed about 10 s before the 120 s expiry.
    expect(server.requests[1]!.expiresAt - server.requests[0]!.expiresAt).toBeLessThanOrEqual(
      120_000 - 10_000 + POLL_MS,
    );
    expect(linked.device).toMatchObject({ platform: 'web', name: 'Chrome on Windows' });
    expect(linked.account.identityKeys().ed25519).toBe(first!.ed25519);
    // The QR code holds no poll secret.
    for (const code of codes) expect(code).not.toContain('secret');
  });

  it('keeps polling through a dropped connection', async () => {
    const { deps, offline } = harness((s, polls) => {
      if (polls === 2) s.goOffline(3);
      if (polls === 8) s.approveLatest();
    });
    await pairBrowser(deps, new AbortController().signal);
    expect(offline).toContain(true);
    expect(offline.at(-1)).toBe(false);
  });

  it('stops when the page leaves', async () => {
    const controller = new AbortController();
    const { deps } = harness((_, polls) => polls === 3 && controller.abort());
    const error = await pairBrowser(deps, controller.signal).catch((e: unknown) => e);
    expect(isStopped(error)).toBe(true);
  });
});

describe('browserName', () => {
  it('names common browsers and systems', () => {
    expect(
      browserName(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36',
      ),
    ).toBe('Chrome on Windows');
    expect(
      browserName('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'),
    ).toBe('Firefox on Linux');
    expect(
      browserName(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
      ),
    ).toBe('Safari on macOS');
    expect(browserName('Mozilla/5.0 (Windows NT 10.0) Chrome/150.0 Safari/537.36 Edg/150.0')).toBe(
      'Edge on Windows',
    );
    expect(browserName('something')).toBe('Web browser');
  });
});
