/**
 * FCM HTTP v1 sender (ADR 0015). OAuth uses the service account's JWT bearer grant, signed with
 * `jose`, so no Google SDK is needed. Each send is a high-priority data message whose only
 * data is the content-free payload, under one collapse key per payload type: wakes queued for
 * an offline phone collapse into one.
 */
import { importPKCS8, SignJWT, type CryptoKey } from 'jose';

import type { PushPayload } from '@pingdost/shared-types';

import { retryAfterMs, type PushSender, type SendOutcome } from './notifier';
import type { PushTarget } from './repo';
import type { Clock } from '../../infra/clock';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
/** Fixed rather than the JSON's `token_uri`, so the signed assertion only goes to Google. */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_URL = 'https://fcm.googleapis.com/v1/projects';
/** Access tokens are refreshed this long before they expire. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export interface FcmSenderOptions {
  projectId: string;
  /** The service account key JSON, base64 (`FCM_SERVICE_ACCOUNT_JSON_BASE64`). */
  serviceAccountJsonBase64: string;
  /** How long FCM keeps a wake for an offline phone. */
  ttlSeconds: number;
  clock: Clock;
  timeoutMs?: number;
  /** Tests pass a fake; production uses the global `fetch`. */
  fetch?: typeof fetch;
}

interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
}

/** The request body for one wake. FCM data values must be strings. */
export function fcmMessage(token: string, payload: PushPayload, ttlSeconds: number) {
  return {
    message: {
      token,
      data: { t: payload.t },
      android: { priority: 'HIGH', collapse_key: payload.t, ttl: `${ttlSeconds}s` },
    },
  };
}

export function parseServiceAccount(base64: string): ServiceAccount {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON_BASE64 is not base64-encoded JSON');
  }
  const { client_email: clientEmail, private_key: privateKey } = (json ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof clientEmail !== 'string' || typeof privateKey !== 'string') {
    throw new Error('FCM_SERVICE_ACCOUNT_JSON_BASE64 lacks client_email or private_key');
  }
  return { clientEmail, privateKey };
}

interface GoogleError {
  error?: {
    message?: string;
    details?: {
      '@type'?: string;
      errorCode?: string;
      fieldViolations?: { field?: string }[];
    }[];
  };
}

/**
 * Whether FCM rejected the registration token itself (delete it), as opposed to the request.
 * `INVALID_ARGUMENT` also covers payload mistakes, so it counts only when it names the token.
 */
export function isInvalidToken(status: number, body: GoogleError): boolean {
  const details = body.error?.details ?? [];
  const code = details.find((detail) => detail['@type']?.endsWith('.FcmError'))?.errorCode;
  if (code === 'UNREGISTERED' || code === 'SENDER_ID_MISMATCH') return true;
  // A bare 404 may be a wrong project ID: deleting every token over it would be worse.
  if (status !== 400 || (code !== undefined && code !== 'INVALID_ARGUMENT')) return false;
  const tokenField = details.some((detail) =>
    detail.fieldViolations?.some((violation) => violation.field === 'message.token'),
  );
  return tokenField || /registration token/i.test(body.error?.message ?? '');
}

export class FcmSender implements PushSender {
  readonly #account: ServiceAccount;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #key?: Promise<CryptoKey>;
  #accessToken?: { value: string; expiresAt: number };
  #refreshing?: Promise<string>;

  constructor(private readonly options: FcmSenderOptions) {
    this.#account = parseServiceAccount(options.serviceAccountJsonBase64);
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async send(target: PushTarget, payload: PushPayload): Promise<SendOutcome> {
    try {
      const accessToken = await this.#token();
      const response = await this.#fetch(
        `${FCM_URL}/${encodeURIComponent(this.options.projectId)}/messages:send`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(fcmMessage(target.address, payload, this.options.ttlSeconds)),
          signal: AbortSignal.timeout(this.#timeoutMs),
        },
      );
      if (response.ok) return { result: 'sent' };
      const body = (await response.json().catch(() => ({}))) as GoogleError;
      const { status } = response;
      if (status === 401) {
        // The access token was revoked or expired early: fetch a new one and retry.
        this.#accessToken = undefined;
        return { result: 'failed', status, retryAfterMs: 0 };
      }
      if (isInvalidToken(status, body)) return { result: 'invalid_token' };
      if (status === 429 || status >= 500) {
        const retryAfter = retryAfterMs(response.headers.get('retry-after'), Date.now());
        return { result: 'failed', status, retryAfterMs: retryAfter ?? 1_000 };
      }
      return { result: 'failed', status };
    } catch {
      // Network failure, timeout or an OAuth failure: transient.
      return { result: 'failed', retryAfterMs: 1_000 };
    }
  }

  async #token(): Promise<string> {
    const cached = this.#accessToken;
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > this.options.clock.now()) {
      return cached.value;
    }
    this.#refreshing ??= this.#fetchToken().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #fetchToken(): Promise<string> {
    this.#key ??= importPKCS8(this.#account.privateKey, 'RS256');
    const now = Math.floor(this.options.clock.now() / 1_000);
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.#account.clientEmail)
      .setAudience(TOKEN_URL)
      .setIssuedAt(now)
      .setExpirationTime(now + 3_600)
      .sign(await this.#key);
    const response = await this.#fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!response.ok) throw new Error(`FCM OAuth token request failed (${response.status})`);
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== 'string') throw new Error('FCM OAuth response has no token');
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3_600;
    this.#accessToken = {
      value: body.access_token,
      expiresAt: this.options.clock.now() + expiresIn * 1_000,
    };
    return body.access_token;
  }
}
