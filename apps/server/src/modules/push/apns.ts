/**
 * APNs sender (ADR 0032): Apple's HTTP/2 provider API with token-based auth, over `node:http2`
 * and a `jose`-signed ES256 provider token, so no Apple or Firebase SDK is needed.
 *
 * - A wake is an `alert` push with a constant "New message" and `content-available`: iOS shows
 *   it even when the app was force-quit, and wakes a suspended app to fetch, decrypt and show
 *   its own notification (which then replaces the constant one). One collapse ID, so a burst
 *   shows one notice.
 * - A call goes to the PushKit VoIP token as `{"t":"call"}`; the app reports it to CallKit at
 *   once (iOS requires that for every VoIP push). A device without a VoIP token gets an
 *   "Incoming call" alert instead.
 * Neither carries a sender, a conversation, a message or an ID.
 */
import {
  connect,
  constants,
  type ClientHttp2Session,
  type IncomingHttpHeaders,
  type IncomingHttpStatusHeader,
} from 'node:http2';

import { importPKCS8, SignJWT, type CryptoKey } from 'jose';

import type { PushPayload } from '@pingdost/shared-types';

import { pushTtlSeconds, type PushSender, type SendOutcome } from './notifier';
import type { PushTarget } from './repo';
import type { Clock } from '../../infra/clock';

export const APNS_ORIGINS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

/** Apple refuses provider tokens older than an hour and throttles refreshes under 20 min. */
const PROVIDER_TOKEN_MAX_AGE_MS = 50 * 60_000;
/** An idle HTTP/2 session is closed after this. */
const SESSION_IDLE_MS = 10 * 60_000;

/** The visible text of the constant alerts. */
export const APNS_ALERT_TEXT = {
  wake: 'New message',
  call: 'Incoming call',
  circle: 'Circle update',
} as const;

export interface ApnsSenderOptions {
  keyId: string;
  teamId: string;
  /** The `.p8` key (PKCS#8 PEM, P-256). */
  privateKeyPem: string;
  /** The app's bundle ID: the topic of alerts; VoIP pushes use `<bundleId>.voip`. */
  bundleId: string;
  /** How long Apple keeps a wake for an offline phone. */
  ttlSeconds: number;
  clock: Clock;
  timeoutMs?: number;
  /** Tests point both at a local cleartext HTTP/2 server. */
  origins?: { production: string; sandbox: string };
}

export interface ApnsRequest {
  /** The device token the request goes to (the alert or the VoIP token). */
  token: string;
  voip: boolean;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** The request for one push: exactly what Apple receives, apart from the provider token. */
export function apnsRequest(
  target: Pick<PushTarget, 'address' | 'voip'>,
  payload: PushPayload,
  options: { bundleId: string; ttlSeconds: number; nowMs: number },
): ApnsRequest {
  const expiration = String(
    Math.floor(options.nowMs / 1_000) + pushTtlSeconds(payload, options.ttlSeconds),
  );
  if (payload.t === 'call' && target.voip) {
    return {
      token: target.voip,
      voip: true,
      headers: {
        'apns-push-type': 'voip',
        'apns-topic': `${options.bundleId}.voip`,
        'apns-priority': '10',
        'apns-expiration': expiration,
      },
      body: { t: 'call' },
    };
  }
  return {
    token: target.address,
    voip: false,
    headers: {
      'apns-push-type': 'alert',
      'apns-topic': options.bundleId,
      'apns-priority': '10',
      'apns-expiration': expiration,
      'apns-collapse-id': payload.t,
    },
    body: {
      aps: {
        alert: { body: APNS_ALERT_TEXT[payload.t] },
        sound: 'default',
        'content-available': 1,
      },
      t: payload.t,
    },
  };
}

/**
 * Whether APNs rejected the device token itself (delete it). `DeviceTokenNotForTopic` and
 * `TopicDisallowed` point at a wrong bundle ID in our config: deleting every token over them
 * would be worse.
 */
export function isInvalidApnsToken(status: number, reason: string | undefined): boolean {
  return status === 410 || (status === 400 && reason === 'BadDeviceToken');
}

interface ApnsResponse {
  status: number;
  reason?: string;
}

export class ApnsSender implements PushSender {
  readonly #timeoutMs: number;
  readonly #origins: { production: string; sandbox: string };
  readonly #sessions = new Map<string, ClientHttp2Session>();
  #key?: Promise<CryptoKey>;
  #providerToken?: { value: string; issuedAt: number };
  #closed = false;

  constructor(private readonly options: ApnsSenderOptions) {
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#origins = options.origins ?? APNS_ORIGINS;
  }

  async send(target: PushTarget, payload: PushPayload): Promise<SendOutcome> {
    const request = apnsRequest(target, payload, {
      bundleId: this.options.bundleId,
      ttlSeconds: this.options.ttlSeconds,
      nowMs: this.options.clock.now(),
    });
    const origin = target.sandbox ? this.#origins.sandbox : this.#origins.production;
    try {
      const { status, reason } = await this.#post(origin, request, await this.#token());
      if (status === 200) return { result: 'sent' };
      if (isInvalidApnsToken(status, reason)) {
        return request.voip ? { result: 'invalid_token', voip: true } : { result: 'invalid_token' };
      }
      if (
        status === 403 &&
        (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken')
      ) {
        // Sign a new provider token and retry once.
        this.#providerToken = undefined;
        return { result: 'failed', status, retryAfterMs: 0 };
      }
      if (status === 429 || status >= 500) return { result: 'failed', status, retryAfterMs: 1_000 };
      return { result: 'failed', status };
    } catch {
      // Network failure, timeout, GOAWAY or a key problem: transient.
      return { result: 'failed', retryAfterMs: 1_000 };
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(
      sessions.map(
        (session) =>
          new Promise<void>((resolve) => {
            if (session.closed || session.destroyed) return resolve();
            session.close(() => resolve());
          }),
      ),
    );
  }

  #session(origin: string): ClientHttp2Session {
    const open = this.#sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(origin);
    // Errors also fail the request in flight; the session is then replaced on the next send.
    session.on('error', () => undefined);
    session.on('goaway', () => this.#forget(origin, session));
    session.on('close', () => this.#forget(origin, session));
    session.setTimeout(SESSION_IDLE_MS, () => session.close());
    session.unref();
    this.#sessions.set(origin, session);
    return session;
  }

  #forget(origin: string, session: ClientHttp2Session): void {
    if (this.#sessions.get(origin) === session) this.#sessions.delete(origin);
  }

  #post(origin: string, request: ApnsRequest, providerToken: string): Promise<ApnsResponse> {
    if (this.#closed) return Promise.reject(new Error('APNs sender closed'));
    return new Promise((resolve, reject) => {
      const stream = this.#session(origin).request({
        [constants.HTTP2_HEADER_METHOD]: 'POST',
        [constants.HTTP2_HEADER_PATH]: `/3/device/${encodeURIComponent(request.token)}`,
        authorization: `bearer ${providerToken}`,
        'content-type': 'application/json',
        ...request.headers,
      });
      let status = 0;
      const chunks: Buffer[] = [];
      stream.setTimeout(this.#timeoutMs, () => {
        stream.close(constants.NGHTTP2_CANCEL);
        reject(new Error('APNs request timed out'));
      });
      stream.on('response', (headers: IncomingHttpHeaders & IncomingHttpStatusHeader) => {
        status = Number(headers[constants.HTTP2_HEADER_STATUS] ?? 0);
      });
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', reject);
      stream.on('end', () => {
        let reason: string | undefined;
        if (chunks.length > 0) {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { reason?: unknown };
            if (typeof body.reason === 'string') reason = body.reason;
          } catch {
            // Not JSON: the status alone decides.
          }
        }
        resolve({ status, ...(reason === undefined ? {} : { reason }) });
      });
      stream.end(JSON.stringify(request.body));
    });
  }

  async #token(): Promise<string> {
    const now = this.options.clock.now();
    const cached = this.#providerToken;
    if (cached && now - cached.issuedAt < PROVIDER_TOKEN_MAX_AGE_MS) return cached.value;
    this.#key ??= importPKCS8(this.options.privateKeyPem, 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.options.keyId })
      .setIssuer(this.options.teamId)
      .setIssuedAt(Math.floor(now / 1_000))
      .sign(await this.#key);
    this.#providerToken = { value, issuedAt: now };
    return value;
  }
}
