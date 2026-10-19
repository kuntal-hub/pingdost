/**
 * Publishes this device's one-time keys and fallback key (ADR 0003, ADR 0008), each signed
 * with the device's ed25519 key. The account is pickled before the upload, so a crash in
 * between re-sends the same keys (uploads are idempotent per key ID), and again after the
 * keys are marked published. Moved here from the Android app in Phase 9 so that every client
 * shares it.
 */
import type { OlmAccount, OneTimeKey } from '@pingdost/crypto/core';
import { signedKeyMessage } from '@pingdost/protocol/signing';
import {
  MAX_ONE_TIME_KEYS_PER_UPLOAD,
  type SignedKey,
  type UploadKeysRequest,
  type UserKeysResponse,
} from '@pingdost/shared-types';

/** Keys kept on the server after a top-up. */
export const ONE_TIME_KEY_TARGET = 50;
/** A top-up starts when the server holds fewer than this. */
export const ONE_TIME_KEY_MINIMUM = 20;
/** ADR 0003: the fallback key rotates at least weekly. */
export const FALLBACK_KEY_MAX_AGE_MS = 7 * 86_400_000;

export interface PublishKeysDeps {
  account: OlmAccount;
  deviceId: string;
  keys: {
    count: () => Promise<number>;
    upload: (body: UploadKeysRequest) => Promise<number>;
  };
  /** Re-pickles the account. */
  saveAccount(): Promise<void>;
  /** True when the server has no fallback key for this device yet (first setup). */
  needsFallbackKey?: boolean;
  /**
   * Replace the published fallback key with a new one. vodozemac keeps the previous key too,
   * so pre-key messages made from it still decrypt.
   */
  rotateFallbackKey?: boolean;
}

export interface PublishKeysResult {
  /** One-time keys sent in this run. */
  uploaded: number;
  fallbackUploaded: boolean;
  /** Unclaimed one-time keys on the server afterwards. */
  serverCount: number;
}

function sign(
  account: OlmAccount,
  kind: 'one_time' | 'fallback',
  deviceId: string,
  key: OneTimeKey,
): SignedKey {
  return {
    keyId: key.keyId,
    publicKey: key.publicKey,
    signature: account.sign(signedKeyMessage(kind, deviceId, key.keyId, key.publicKey)),
  };
}

/** Tops the server up to `ONE_TIME_KEY_TARGET` keys when it holds too few. */
export async function publishKeys(deps: PublishKeysDeps): Promise<PublishKeysResult> {
  const { account, deviceId } = deps;
  const serverCount = await deps.keys.count();
  let changed = false;

  // `fallbackKey()` returns only an unpublished key, e.g. one left by an interrupted run.
  let fallback = account.fallbackKey();
  if (!fallback && (deps.needsFallbackKey || deps.rotateFallbackKey)) {
    account.generateFallbackKey();
    fallback = account.fallbackKey();
    changed = true;
  }

  const pending = account.oneTimeKeys().length;
  const wanted =
    serverCount < ONE_TIME_KEY_MINIMUM
      ? Math.min(ONE_TIME_KEY_TARGET - serverCount, account.maxNumberOfOneTimeKeys())
      : 0;
  if (wanted > pending) {
    account.generateOneTimeKeys(wanted - pending);
    changed = true;
  }

  const oneTimeKeys = account.oneTimeKeys();
  if (oneTimeKeys.length === 0 && !fallback) {
    return { uploaded: 0, fallbackUploaded: false, serverCount };
  }
  if (changed) await deps.saveAccount();

  const signed = oneTimeKeys.map((key) => sign(account, 'one_time', deviceId, key));
  const batches: SignedKey[][] = [];
  for (let start = 0; start < signed.length; start += MAX_ONE_TIME_KEYS_PER_UPLOAD) {
    batches.push(signed.slice(start, start + MAX_ONE_TIME_KEYS_PER_UPLOAD));
  }
  if (batches.length === 0) batches.push([]); // the fallback key alone

  let count = serverCount;
  for (const [index, batch] of batches.entries()) {
    const fallbackKey =
      fallback && index === 0 ? sign(account, 'fallback', deviceId, fallback) : undefined;
    count = await deps.keys.upload({ oneTimeKeys: batch, ...(fallbackKey ? { fallbackKey } : {}) });
  }
  account.markKeysAsPublished();
  await deps.saveAccount();
  return {
    uploaded: oneTimeKeys.length,
    fallbackUploaded: fallback !== undefined,
    serverCount: count,
  };
}

export interface SyncKeysDeps extends Omit<PublishKeysDeps, 'needsFallbackKey'> {
  userId: string;
  /** GET /v1/keys/users/:userId. */
  directory(userId: string): Promise<UserKeysResponse>;
}

/**
 * Device setup and every start: asks the directory whether this device's fallback key is
 * published (so an interrupted first upload heals), then tops up the one-time keys.
 */
export async function syncKeys(deps: SyncKeysDeps): Promise<PublishKeysResult> {
  const directory = await deps.directory(deps.userId);
  const own = directory.devices.find((device) => device.deviceId === deps.deviceId);
  return publishKeys({ ...deps, needsFallbackKey: !own?.fallbackKey });
}
