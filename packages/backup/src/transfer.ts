/**
 * Moving the account to a new phone with the old one's approval (ADR 0022, path a): the
 * crypto both phones run, so the app, the sim client and the tests share it.
 *
 * - Both phones show `transferCode(...)` over the request ID and the new phone's keys. The user
 *   compares them, so the server cannot swap in other keys.
 * - The old phone checks the new phone's one-time key signature, certifies its keys with the
 *   account identity key, and seals that key to the one-time key over Olm (a one-off outbound
 *   session that is never stored).
 * - The new phone opens the sealed message with its own account and checks the key it got
 *   against the account's public key and the certificate before using it.
 */
import type { CryptoProvider, OlmAccount, SigningKey } from '@pingdost/crypto/core';
import {
  decodePrimaryTransferPayload,
  deviceCertificateMessage,
  encodePrimaryTransferPayload,
  fromBase64,
  primaryTransferCode,
  primaryTransferCodeMessage,
  signedKeyMessage,
  toBase64,
} from '@pingdost/protocol';
import type {
  ApprovePrimaryTransferRequest,
  IdentityKeys,
  PendingPrimaryTransfer,
  PrimaryTransferStatusResponse,
  SignedKey,
} from '@pingdost/shared-types';

export class TransferError extends Error {
  constructor(
    readonly code: 'bad_one_time_key' | 'bad_approval' | 'wrong_account',
    message: string,
  ) {
    super(message);
    this.name = 'TransferError';
  }
}

/** The six digits ("123 456") both phones show for this request. */
export function transferCode(
  crypto: CryptoProvider,
  requestId: string,
  deviceId: string,
  keys: IdentityKeys,
): string {
  return primaryTransferCode(crypto.sha256(primaryTransferCodeMessage(requestId, deviceId, keys)));
}

/** The new phone's one-time key, signed for the request (it is not published elsewhere). */
export function transferOneTimeKey(account: OlmAccount, deviceId: string): SignedKey {
  const before = new Set(account.oneTimeKeys().map((k) => k.keyId));
  account.generateOneTimeKeys(1);
  const key = account.oneTimeKeys().find((k) => !before.has(k.keyId));
  if (!key) throw new Error('no one-time key');
  // Kept unpublished in the account until the sealed message consumes it.
  return {
    keyId: key.keyId,
    publicKey: key.publicKey,
    signature: account.sign(signedKeyMessage('one_time', deviceId, key.keyId, key.publicKey)),
  };
}

/** The old phone (the active primary) approves `request`. */
export function approveTransfer(
  crypto: CryptoProvider,
  account: OlmAccount,
  identity: SigningKey,
  userId: string,
  request: PendingPrimaryTransfer,
): ApprovePrimaryTransferRequest {
  const { oneTimeKey, identityKeys, deviceId } = request;
  const signed = crypto.verifyEd25519(
    identityKeys.ed25519,
    signedKeyMessage('one_time', deviceId, oneTimeKey.keyId, oneTimeKey.publicKey),
    oneTimeKey.signature,
  );
  if (!signed) {
    throw new TransferError('bad_one_time_key', "The new phone's key is not signed by it.");
  }
  const session = account.createOutboundSession(identityKeys.curve25519, oneTimeKey.publicKey);
  try {
    const message = session.encrypt(
      encodePrimaryTransferPayload({
        requestId: request.requestId,
        userId,
        accountIdentityKeySecret: identity.exportSecret(),
      }),
    );
    if (message.type !== 'prekey') throw new Error('expected a pre-key message');
    return {
      deviceCertificate: identity.sign(deviceCertificateMessage(deviceId, identityKeys)),
      sealed: toBase64(message.body),
    };
  } finally {
    session.dispose();
  }
}

/**
 * The new phone opens the approval: the account identity key, checked against
 * `accountIdentityKey` (the account's public key) and the certificate it made. The account's
 * one-time key is consumed, so pickle the account afterwards.
 */
export function openTransferApproval(
  crypto: CryptoProvider,
  account: OlmAccount,
  approval: NonNullable<PrimaryTransferStatusResponse['approval']>,
  expected: { requestId: string; userId: string; deviceId: string; accountIdentityKey: string },
): SigningKey {
  let plaintext: Uint8Array;
  try {
    const opened = account.createInboundSession(approval.senderKey, {
      type: 'prekey',
      body: fromBase64(approval.sealed),
    });
    plaintext = opened.plaintext;
    opened.session.dispose();
  } catch {
    throw new TransferError('bad_approval', 'The approval could not be opened.');
  }
  let identity: SigningKey;
  try {
    const payload = decodePrimaryTransferPayload(plaintext);
    if (payload.requestId !== expected.requestId || payload.userId !== expected.userId) {
      throw new TransferError('bad_approval', 'The approval is for another request.');
    }
    identity = crypto.restoreSigningKey(payload.accountIdentityKeySecret);
  } catch (error) {
    if (error instanceof TransferError) throw error;
    throw new TransferError('bad_approval', 'The approval is malformed.');
  } finally {
    plaintext.fill(0);
  }
  const keys = account.identityKeys();
  const certified = crypto.verifyEd25519(
    expected.accountIdentityKey,
    deviceCertificateMessage(expected.deviceId, keys),
    approval.deviceCertificate,
  );
  if (identity.publicKey() !== expected.accountIdentityKey || !certified) {
    identity.dispose();
    throw new TransferError('wrong_account', 'The key does not belong to this account.');
  }
  return identity;
}
