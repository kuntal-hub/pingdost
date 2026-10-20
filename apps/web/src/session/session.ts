// The linked browser's session (ADR 0019): its device record, tokens and Olm account sealed in
// IndexedDB (`vault.ts`), the API client that uses and refreshes the tokens, and the stage the
// app shows. Losing the session (unlinked here, revoked from the phone, or a refresh the
// server refuses) wipes everything this browser stored and returns to the pairing screen.
import { create } from 'zustand';

import { publicConfig } from '@/config';
import { database, wipeDatabase } from '@/db/db';
import { SealedRecords, vaultKey } from '@/db/vault';
import {
  accountApi,
  ApiError,
  authApi,
  createApiClient,
  devicesApi,
  keysApi,
  pairingApi,
} from '@pingdost/api-client';
import type { CryptoProvider, OlmAccount } from '@pingdost/crypto/core';
import { fromBase64, toBase64 } from '@pingdost/protocol';
import type { AuthTokens } from '@pingdost/shared-types';

export interface LinkedDevice {
  deviceId: string;
  userId: string;
  username: string | null;
  /** The account identity key (public) the phone certified this browser with. */
  accountIdentityKey: string | null;
  name: string;
  linkedAt: number;
}

export type Stage = 'loading' | 'unpaired' | 'paired';

interface SessionState {
  stage: Stage;
  device: LinkedDevice | undefined;
  /** Shown on the pairing screen, e.g. why this browser was unlinked. */
  notice: string | undefined;
}

export const useSession = create<SessionState>()(() => ({
  stage: 'loading',
  device: undefined,
  notice: undefined,
}));

const RECORDS = {
  device: 'device',
  tokens: 'tokens',
  account: 'olm-account',
  pickleKey: 'olm-pickle-key',
} as const;

let tokens: AuthTokens | undefined;
let records: Promise<SealedRecords> | undefined;
const signedOutListeners = new Set<() => void>();

function sealed(): Promise<SealedRecords> {
  records ??= (async () => new SealedRecords(database(), await vaultKey(database())))();
  return records;
}

const client = createApiClient({
  // Without a config the app shows the config error before any request is made.
  baseUrl: publicConfig?.apiUrl ?? 'http://invalid.localhost',
  getAccessToken: () => tokens?.accessToken,
  onRefresh: () => refreshTokens(),
});

export const api = {
  account: accountApi(client),
  auth: authApi(client),
  devices: devicesApi(client),
  keys: keysApi(client),
  pairing: pairingApi(client),
};

export function accessToken(): string | undefined {
  return tokens?.accessToken;
}

let refreshing: Promise<boolean> | undefined;

/** New tokens after `TOKEN_EXPIRED`; a refusal means this browser is no longer linked. */
export function refreshTokens(): Promise<boolean> {
  refreshing ??= (async () => {
    const current = tokens;
    if (!current) return false;
    try {
      const next = await api.auth.refresh(current.refreshToken);
      tokens = next;
      await (await sealed()).put(RECORDS.tokens, next);
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'http' && error.status < 500) {
        await signOut('This browser is no longer linked. Link it again from your phone.');
      }
      return false;
    }
  })().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}

/** Reads the stored session at start. */
export async function bootSession(): Promise<void> {
  try {
    const store = await sealed();
    const device = await store.get<LinkedDevice>(RECORDS.device);
    const saved = await store.get<AuthTokens>(RECORDS.tokens);
    if (device && saved) {
      tokens = saved;
      useSession.setState({ stage: 'paired', device });
      return;
    }
  } catch {
    // Unreadable (e.g. the vault key was cleared without the records): start over.
    await wipeDatabase().catch(() => undefined);
    records = undefined;
  }
  useSession.setState({ stage: 'unpaired', device: undefined });
}

/** Seals the account with its own pickle key (both inside the vault). */
export async function saveAccount(account: OlmAccount): Promise<void> {
  const store = await sealed();
  let key = await store.get<string>(RECORDS.pickleKey);
  if (!key) {
    key = toBase64(crypto.getRandomValues(new Uint8Array(32)));
    await store.put(RECORDS.pickleKey, key);
  }
  await store.put(RECORDS.account, { pickle: account.pickle(fromBase64(key)) });
}

export async function loadAccount(provider: CryptoProvider): Promise<OlmAccount | undefined> {
  const store = await sealed();
  const key = await store.get<string>(RECORDS.pickleKey);
  const saved = await store.get<{ pickle: string }>(RECORDS.account);
  return key && saved ? provider.restoreAccount(saved.pickle, fromBase64(key)) : undefined;
}

/** Uses fresh tokens for requests now, before anything is saved. */
export function adoptTokens(next: AuthTokens): void {
  tokens = next;
}

/** Pairing finished: the device and its tokens are saved; the next start resumes them. */
export async function savePairing(device: LinkedDevice, next: AuthTokens): Promise<void> {
  tokens = next;
  const store = await sealed();
  await store.put(RECORDS.tokens, next);
  await store.put(RECORDS.device, device);
}

export function enterApp(device: LinkedDevice): void {
  useSession.setState({ stage: 'paired', device, notice: undefined });
}

/** Called when the session ends, before the data is wiped (closes the connection). */
export function onSignedOut(listener: () => void): () => void {
  signedOutListeners.add(listener);
  return () => signedOutListeners.delete(listener);
}

/** Wipes this browser's PingDost data and shows the pairing screen. */
export async function signOut(notice?: string): Promise<void> {
  for (const listener of [...signedOutListeners]) listener();
  tokens = undefined;
  records = undefined;
  await wipeDatabase().catch(() => undefined);
  useSession.setState({ stage: 'unpaired', device: undefined, notice });
}

/**
 * Unlinks this browser: revokes its device on the server (any device may revoke itself),
 * then wipes it. Offline, the local data still goes, and the user is told to revoke it on the
 * phone too.
 */
export async function unlink(): Promise<void> {
  const device = useSession.getState().device;
  let notice = 'This browser was unlinked and its PingDost data deleted.';
  if (device) {
    try {
      await api.devices.revoke(device.deviceId);
    } catch {
      notice =
        "This browser's PingDost data was deleted, but the server could not be reached. Remove it from your phone's Devices list too.";
    }
  }
  await signOut(notice);
}
