// The browser's side of pairing (REQ §13.1, ADR 0019): a fresh Olm account, a pairing request
// shown as a QR code (renewed before it expires, with the same keys), polling with the secret
// that never leaves this tab, and, once the phone approved, the proof of possession that turns
// the request into this browser's device and tokens.
import type { PairingApi } from '@pingdost/api-client';
import type { CryptoProvider, OlmAccount } from '@pingdost/crypto/core';
import { deviceRegistrationMessage, encodePairingQr } from '@pingdost/protocol';
import type { RegisterDeviceResponse } from '@pingdost/shared-types';

/** How often the browser asks whether the phone approved. */
export const POLL_MS = 2_000;
/** A new QR code replaces the old one this long before it expires. */
export const RENEW_BEFORE_MS = 10_000;

export interface PairingDeps {
  provider: CryptoProvider;
  api: Pick<PairingApi, 'create' | 'status' | 'complete'>;
  /** This page's origin, shown to the user on the phone. */
  origin: string;
  /** e.g. "Chrome on Windows". */
  name: string;
  /** Shown as the QR code, with when it stops working. */
  onCode(code: { text: string; expiresAt: number }): void;
  /** The phone approved; the browser is finishing. */
  onApproved?(): void;
  /** Polling failed for a moment (offline); it keeps trying. */
  onOffline?(offline: boolean): void;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface Paired extends RegisterDeviceResponse {
  account: OlmAccount;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

class Stopped extends Error {
  constructor() {
    super('pairing stopped');
    this.name = 'Stopped';
  }
}

export function isStopped(error: unknown): boolean {
  return error instanceof Stopped;
}

/** Runs until linked (resolves) or `signal` aborts (rejects with a `Stopped` error). */
export async function pairBrowser(deps: PairingDeps, signal: AbortSignal): Promise<Paired> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const stopIfAborted = () => {
    if (signal.aborted) throw new Stopped();
  };
  const account = deps.provider.createAccount();
  const identityKeys = account.identityKeys();
  try {
    for (;;) {
      stopIfAborted();
      const request = await deps.api.create({ identityKeys, name: deps.name });
      deps.onCode({
        text: encodePairingQr({
          pairingId: request.pairingId,
          challenge: request.challenge,
          curve25519: identityKeys.curve25519,
          ed25519: identityKeys.ed25519,
          origin: deps.origin,
        }),
        expiresAt: request.expiresAt,
      });

      const renewAt = request.expiresAt - RENEW_BEFORE_MS;
      let approved: { deviceId: string; nonce: string } | undefined;
      // Poll until approved; once the code is about to expire, ask one last time.
      for (let last = false; !approved && !last;) {
        await sleep(POLL_MS, signal);
        stopIfAborted();
        last = now() >= renewAt;
        try {
          const status = await deps.api.status(request.pairingId, request.pollSecret, signal);
          deps.onOffline?.(false);
          if (status.status === 'approved' && status.deviceId && status.nonce) {
            approved = { deviceId: status.deviceId, nonce: status.nonce };
          } else if (status.status === 'expired') {
            last = true;
          }
        } catch (error) {
          stopIfAborted();
          const { kind } = error as { kind?: string };
          if (kind !== 'network' && kind !== 'timeout') throw error;
          deps.onOffline?.(true);
        }
      }
      if (!approved) continue; // a fresh code with the same keys

      deps.onApproved?.();
      const linked = await deps.api.complete(request.pairingId, {
        pollSecret: request.pollSecret,
        signature: account.sign(
          deviceRegistrationMessage(approved.nonce, approved.deviceId, identityKeys),
        ),
      });
      return { ...linked, account };
    }
  } catch (error) {
    account.dispose();
    throw error;
  }
}
