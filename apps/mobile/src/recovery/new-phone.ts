// This phone takes over an account that lives on another phone (or whose phone is lost),
// ADR 0022. Three ways, each from a recent login with no device yet:
// - transfer: the old phone approves after both show the same code; it seals the account key
//   to this phone over Olm. History stays on the old phone.
// - restore: a backup file and its phrase give the account key and the history; an email code
//   confirms. The old phone is signed out.
// - fresh: a new account key and no history; an email code confirms. Every other device is
//   signed out and contacts see a new safety number.
// Every way starts by clearing what this phone held and making a new Olm account and device
// ID: a restored phone is a new device (ADR 0003).
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { api, authStore } from '@/api';
import { wipeAttachmentFiles } from '@/attachments/storage';
import { restoreIntoPhone, type OpenedBackup } from '@/backup/restore';
import { getCryptoContext, type CryptoContext } from '@/crypto/bootstrap';
import { getOrCreateSecret, SECRET_ITEMS, SECURE_STORE_OPTIONS } from '@/crypto/secrets';
import { SETTING_KEYS, writeSetting } from '@/db/settings';
import { deviceName } from '@/device';
import { wipeChatData } from '@/engine/sqlite-store';
import {
  openTransferApproval,
  TransferError,
  transferCode,
  transferOneTimeKey,
} from '@pingdost/backup';
import type { SigningKey } from '@pingdost/crypto/core';
import { uuidv7 } from '@pingdost/protocol/ids';
import { deviceCertificateMessage, deviceRegistrationMessage } from '@pingdost/protocol/signing';
import type { AuthTokens, ReplacePrimaryMode } from '@pingdost/shared-types';

const platform = () => (Platform.OS === 'ios' ? 'ios' : 'android');

function session() {
  const current = authStore.getState().session;
  if (!current) throw new Error('not signed in');
  return current;
}

/** Clears this phone's chats, files and Olm account; returns a new device ID. */
async function freshDevice(): Promise<{ context: CryptoContext; deviceId: string }> {
  const context = await getCryptoContext();
  await wipeChatData(context.database.db);
  wipeAttachmentFiles();
  await context.store.resetAccount();
  return { context, deviceId: uuidv7() };
}

/** Keeps the account key and device on this phone, then binds the session (stage: ready). */
async function finish(
  context: CryptoContext,
  deviceId: string,
  identity: SigningKey,
  tokens: AuthTokens,
): Promise<void> {
  await SecureStore.setItemAsync(
    SECRET_ITEMS.accountIdentityKey,
    identity.exportSecret(),
    SECURE_STORE_OPTIONS,
  );
  await writeSetting(context.database.db, SETTING_KEYS.device, {
    deviceId,
    userId: session().user.userId,
  });
  await context.store.saveAccount();
  // The chat engine starts now and publishes this device's keys (`replenishKeys`).
  await authStore.getState().bindDevice(deviceId, tokens);
}

// Restore and fresh: an email code

export class BackupAccountMismatch extends Error {
  constructor(readonly reason: 'other_account' | 'old_key') {
    super(
      reason === 'other_account'
        ? 'This backup belongs to a different PingDost account.'
        : "This backup was made before the account's key changed (someone chose Start fresh since). It cannot be restored.",
    );
    this.name = 'BackupAccountMismatch';
  }
}

export interface RestorePlan {
  opened: OpenedBackup;
  identitySecret: string;
  verified: { records: number };
}

/**
 * Checks the opened backup against the signed-in account and reads it end to end (nothing
 * changes on the server or the phone yet).
 */
export async function planRestore(opened: OpenedBackup): Promise<RestorePlan> {
  const { manifest, reader } = opened;
  if (manifest.userId !== session().user.userId) throw new BackupAccountMismatch('other_account');
  const { accountIdentityKey } = await api.account.me();
  if (manifest.accountIdentityKey !== accountIdentityKey) {
    throw new BackupAccountMismatch('old_key');
  }
  const identitySecret = await reader.identitySecret();
  const { provider } = await getCryptoContext();
  const identity = provider.restoreSigningKey(identitySecret);
  const matches = identity.publicKey() === accountIdentityKey;
  identity.dispose();
  if (!matches) throw new BackupAccountMismatch('old_key');
  const verified = await reader.verify();
  return { opened, identitySecret, verified };
}

/** Emails the account a 6-digit code for `replacePhone`. */
export function sendReplaceCode(): Promise<void> {
  return api.recovery.sendReplaceCode();
}

/**
 * Makes this phone the account's phone with the email code: from the backup (`restore`, with
 * a plan) or with a new account key (`fresh`). The restore writes the history before the
 * session is bound, so the chat engine starts on the complete database.
 */
export async function replacePhone(
  mode: ReplacePrimaryMode,
  otp: string,
  plan: RestorePlan | null,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  if (mode === 'restore' && !plan) throw new Error('restore needs a plan');
  const { context, deviceId } = await freshDevice();
  const identity = plan
    ? context.provider.restoreSigningKey(plan.identitySecret)
    : context.provider.createSigningKey();
  try {
    const account = context.store.account;
    const keys = account.identityKeys();
    const { nonce } = await api.devices.challenge();
    const { tokens } = await api.recovery.replace({
      mode,
      otp,
      deviceId,
      platform: platform(),
      name: deviceName(),
      identityKeys: keys,
      nonce,
      signature: account.sign(deviceRegistrationMessage(nonce, deviceId, keys)),
      deviceCertificate: identity.sign(deviceCertificateMessage(deviceId, keys)),
      accountIdentityKey: identity.publicKey(),
    });
    if (plan) {
      const pickleKey = await getOrCreateSecret(SECRET_ITEMS.pickleKey);
      await restoreIntoPhone(plan.opened, plan.verified, pickleKey, onProgress);
    }
    await finish(context, deviceId, identity, tokens);
  } finally {
    identity.dispose();
  }
}

// Transfer: the old phone approves

export interface TransferRequest {
  requestId: string;
  deviceId: string;
  /** "123 456": the old phone must show the same. */
  code: string;
  expiresAt: number;
}

export async function startTransfer(): Promise<TransferRequest> {
  const { context, deviceId } = await freshDevice();
  const account = context.store.account;
  const oneTimeKey = transferOneTimeKey(account, deviceId);
  await context.store.saveAccount();
  const identityKeys = account.identityKeys();
  const { requestId, expiresAt } = await api.recovery.start({
    deviceId,
    platform: platform(),
    name: deviceName(),
    identityKeys,
    oneTimeKey,
  });
  return {
    requestId,
    deviceId,
    code: transferCode(context.provider, requestId, deviceId, identityKeys),
    expiresAt,
  };
}

export type TransferOutcome = 'pending' | 'denied' | 'expired' | 'done';

/** Polls once; when approved, opens the account key, completes and binds the session. */
export async function checkTransfer(request: TransferRequest): Promise<TransferOutcome> {
  const status = await api.recovery.status(request.requestId);
  if (status.status === 'denied') return 'denied';
  if (status.status === 'expired') return 'expired';
  if (status.status !== 'approved' || !status.approval) return 'pending';
  const context = await getCryptoContext();
  const { accountIdentityKey } = await api.account.me();
  if (!accountIdentityKey) throw new TransferError('wrong_account', 'The account has no key.');
  const account = context.store.account;
  const identity = openTransferApproval(context.provider, account, status.approval, {
    requestId: request.requestId,
    userId: session().user.userId,
    deviceId: request.deviceId,
    accountIdentityKey,
  });
  try {
    // The one-time key is used up: keep the account as it is now.
    await context.store.saveAccount();
    const { tokens } = await api.recovery.complete(request.requestId, {
      signature: account.sign(
        deviceRegistrationMessage(status.approval.nonce, request.deviceId, account.identityKeys()),
      ),
    });
    await finish(context, request.deviceId, identity, tokens);
  } finally {
    identity.dispose();
  }
  return 'done';
}
