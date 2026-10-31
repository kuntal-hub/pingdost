/**
 * Replacing the primary phone (REQ §6.2, §6.3; ADR 0022). Three ways, all audited and
 * rate-limited, all from a new phone with a recent login and no device yet:
 *
 * (a) **Approve from the old phone.** The new phone files a request with its keys and a
 *     signed one-time key. The account's devices are told (WS frame, push wake). The active
 *     primary, after the user compares a check code on both screens, certifies the new keys
 *     with the account identity key and seals that key to the new phone over Olm. The new
 *     phone proves its keys against a fresh nonce; only then is the old primary revoked and
 *     the new one registered. Linked browsers cannot approve (they hold no account key) but
 *     may deny. Single use, short-lived (TTL index).
 * (b) **Restore from a backup + an email code.** The backup's account key certifies the new
 *     phone; the old primary is revoked. Same safety number.
 * (c) **Start fresh + an email code.** A new account key: every device is revoked, contacts
 *     see a new safety number, and nothing comes back.
 *
 * The server stores public keys, the certificate and the sealed Olm message (ciphertext to
 * the new phone's one-time key, deleted with the request). Never a private key.
 */
import type { Collection, Db } from 'mongodb';

import {
  deviceCertificateMessage,
  deviceRegistrationMessage,
  fromBase64,
  ProtocolError,
  signedKeyMessage,
  uuidv7,
} from '@pingdost/protocol';
import {
  RECENT_LOGIN_SECONDS,
  type ApprovePrimaryTransferRequest,
  type CompletePrimaryTransferRequest,
  type DevicePlatform,
  type IdentityKeys,
  type ListPrimaryTransfersResponse,
  type PrimaryTransferStatusResponse,
  type RegisterDeviceResponse,
  type ReplacePrimaryRequest,
  type SignedKey,
  type StartPrimaryTransferRequest,
  type StartPrimaryTransferResponse,
} from '@pingdost/shared-types';

import type { DeviceCollections, DeviceDoc } from './repo';
import { DeviceService } from './service';
import type { Clock } from '../../infra/clock';
import { WindowCounter } from '../../infra/counters';
import { verifyEd25519 } from '../../infra/ed25519';
import { AppError } from '../../infra/errors';
import type { IndexSetup } from '../../infra/mongo';
import { randomToken } from '../../infra/secrets';
import type { Budget } from '../../infra/throttles';
import type { AuthContext } from '../auth/guard';
import type { AuthCollections } from '../auth/repo';
import type { AuthService } from '../auth/service';
import type { RequestContext, SecurityEvents } from '../security/events';

export type PrimaryTransferState = 'pending' | 'approved' | 'denied' | 'completed';

export interface PrimaryTransferDoc {
  /** UUIDv7: the request ID. */
  _id: string;
  userId: string;
  /** Only the session that filed it may poll and complete it. */
  sessionId: string;
  deviceId: string;
  platform: Extract<DevicePlatform, 'android' | 'ios'>;
  name: string;
  identityKeys: IdentityKeys;
  oneTimeKey: SignedKey;
  state: PrimaryTransferState;
  createdAt: Date;
  /** The TTL index deletes the request soon after. */
  expiresAt: Date;
  // Set when the primary approves:
  approvedBy: string | null;
  deviceCertificate: string | null;
  /** The approver's Curve25519 key and its Olm pre-key message (base64) to the new phone. */
  senderKey: string | null;
  sealed: string | null;
  nonce: string | null;
  approvedAt: Date | null;
  closedAt: Date | null;
}

export function primaryTransfers(db: Db): Collection<PrimaryTransferDoc> {
  return db.collection<PrimaryTransferDoc>('primary_transfer_requests');
}

export const primaryTransferIndexes: IndexSetup = async (db) => {
  const requests = primaryTransfers(db);
  await requests.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await requests.createIndex({ userId: 1, state: 1 });
};

/** A request lives this long; approval leaves the new phone at least `COMPLETE_GRACE_MS`. */
export const TRANSFER_TTL_MS = 10 * 60_000;
const COMPLETE_GRACE_MS = 2 * 60_000;
const MAX_PENDING_PER_ACCOUNT = 3;

export interface PrimaryTransferDeps {
  requests: Collection<PrimaryTransferDoc>;
  devices: DeviceCollections;
  auth: AuthCollections;
  authService: AuthService;
  deviceService: DeviceService;
  events: SecurityEvents;
  clock: Clock;
  /** Starts and replacements per account (on top of the per-IP route limits). */
  budget: Budget;
  /** The account's devices are told about a new request (WS frame, and a wake for phones). */
  onRequested?: (userId: string, requestId: string, expiresAt: number) => void;
}

function signatureOk(publicKey: string, message: () => Uint8Array, signature: string): boolean {
  try {
    return verifyEd25519(publicKey, message(), signature);
  } catch (error) {
    if (error instanceof ProtocolError) return false;
    throw error;
  }
}

function keysValid(keys: IdentityKeys): boolean {
  try {
    return fromBase64(keys.curve25519).length === 32 && fromBase64(keys.ed25519).length === 32;
  } catch {
    return false;
  }
}

export class PrimaryTransferService {
  readonly #budget: WindowCounter;

  constructor(private readonly d: PrimaryTransferDeps) {
    this.#budget = new WindowCounter(d.budget.limit, d.budget.windowMs, d.clock);
  }

  #now(): number {
    return this.d.clock.now();
  }

  /** The new phone: a recent login, no device yet, an active account. */
  async #newPhone(auth: AuthContext): Promise<void> {
    if (auth.deviceId) {
      throw new AppError('CONFLICT', { detail: 'This session already has a device.' });
    }
    await this.d.authService.requireRecentLogin(auth.sessionId, RECENT_LOGIN_SECONDS);
    const budget = this.#budget.hit(auth.userId);
    if (!budget.allowed) {
      throw new AppError('RATE_LIMITED', { retryAfterSeconds: budget.retryAfterSeconds });
    }
  }

  async #activePrimary(userId: string): Promise<DeviceDoc | null> {
    return this.d.devices.devices.findOne({ userId, role: 'primary', status: 'active' });
  }

  // (a) Approve from the old phone

  async start(
    auth: AuthContext,
    input: StartPrimaryTransferRequest,
    context: RequestContext,
  ): Promise<StartPrimaryTransferResponse> {
    await this.#newPhone(auth);
    if (!keysValid(input.identityKeys)) {
      throw new AppError('VALIDATION_FAILED', { detail: 'Identity keys must be 32 bytes each.' });
    }
    const { oneTimeKey } = input;
    if (
      !signatureOk(
        input.identityKeys.ed25519,
        () => signedKeyMessage('one_time', input.deviceId, oneTimeKey.keyId, oneTimeKey.publicKey),
        oneTimeKey.signature,
      )
    ) {
      throw new AppError('INVALID_SIGNATURE', { detail: 'The one-time key is not signed.' });
    }
    if (!(await this.#activePrimary(auth.userId))) {
      throw new AppError('CONFLICT', {
        detail: 'There is no phone to approve this: register this phone directly.',
      });
    }
    if (await this.d.devices.devices.findOne({ _id: input.deviceId })) {
      throw new AppError('CONFLICT', { detail: 'Device ID already in use.' });
    }
    const now = this.#now();
    const pending = await this.d.requests.countDocuments({
      userId: auth.userId,
      state: 'pending',
      expiresAt: { $gt: new Date(now) },
    });
    if (pending >= MAX_PENDING_PER_ACCOUNT) {
      throw new AppError('RATE_LIMITED', { retryAfterSeconds: TRANSFER_TTL_MS / 1000 });
    }
    const doc: PrimaryTransferDoc = {
      _id: uuidv7(),
      userId: auth.userId,
      sessionId: auth.sessionId,
      deviceId: input.deviceId,
      platform: input.platform,
      name: input.name,
      identityKeys: {
        curve25519: input.identityKeys.curve25519,
        ed25519: input.identityKeys.ed25519,
      },
      oneTimeKey: {
        keyId: oneTimeKey.keyId,
        publicKey: oneTimeKey.publicKey,
        signature: oneTimeKey.signature,
      },
      state: 'pending',
      createdAt: new Date(now),
      expiresAt: new Date(now + TRANSFER_TTL_MS),
      approvedBy: null,
      deviceCertificate: null,
      senderKey: null,
      sealed: null,
      nonce: null,
      approvedAt: null,
      closedAt: null,
    };
    await this.d.requests.insertOne(doc);
    await this.d.events.record('primary_transfer_request', context, auth.userId);
    this.d.onRequested?.(auth.userId, doc._id, doc.expiresAt.getTime());
    return { requestId: doc._id, expiresAt: doc.expiresAt.getTime() };
  }

  /** The new phone polls its own request. */
  async status(auth: AuthContext, requestId: string): Promise<PrimaryTransferStatusResponse> {
    const doc = await this.d.requests.findOne({
      _id: requestId,
      userId: auth.userId,
      sessionId: auth.sessionId,
    });
    if (!doc) throw new AppError('TRANSFER_NOT_FOUND');
    if (doc.state === 'completed') return { status: 'completed', approval: null };
    if (doc.state === 'denied') return { status: 'denied', approval: null };
    if (doc.expiresAt.getTime() <= this.#now()) return { status: 'expired', approval: null };
    if (
      doc.state === 'approved' &&
      doc.nonce &&
      doc.deviceCertificate &&
      doc.senderKey &&
      doc.sealed
    ) {
      return {
        status: 'approved',
        approval: {
          nonce: doc.nonce,
          deviceCertificate: doc.deviceCertificate,
          senderKey: doc.senderKey,
          sealed: doc.sealed,
        },
      };
    }
    return { status: 'pending', approval: null };
  }

  /** The account's devices: what is waiting for a decision. */
  async pending(auth: AuthContext): Promise<ListPrimaryTransfersResponse> {
    await this.#device(auth);
    const docs = await this.d.requests
      .find({ userId: auth.userId, state: 'pending', expiresAt: { $gt: new Date(this.#now()) } })
      .sort({ createdAt: 1 })
      .toArray();
    return {
      requests: docs.map((doc) => ({
        requestId: doc._id,
        deviceId: doc.deviceId,
        platform: doc.platform,
        name: doc.name,
        identityKeys: doc.identityKeys,
        oneTimeKey: doc.oneTimeKey,
        createdAt: doc.createdAt.getTime(),
        expiresAt: doc.expiresAt.getTime(),
      })),
    };
  }

  async #device(auth: AuthContext): Promise<DeviceDoc> {
    if (!auth.deviceId) throw new AppError('DEVICE_REQUIRED');
    const device = await this.d.devices.devices.findOne({
      _id: auth.deviceId,
      userId: auth.userId,
      status: 'active',
    });
    if (!device) throw new AppError('DEVICE_REQUIRED');
    return device;
  }

  async #pendingDoc(auth: AuthContext, requestId: string): Promise<PrimaryTransferDoc> {
    const doc = await this.d.requests.findOne({ _id: requestId, userId: auth.userId });
    if (!doc) throw new AppError('TRANSFER_NOT_FOUND');
    if (doc.state !== 'pending') throw new AppError('TRANSFER_ALREADY_USED');
    if (doc.expiresAt.getTime() <= this.#now()) throw new AppError('TRANSFER_EXPIRED');
    return doc;
  }

  /** The active primary certifies the new keys and seals the account key to them. */
  async approve(
    auth: AuthContext,
    requestId: string,
    input: ApprovePrimaryTransferRequest,
    context: RequestContext,
  ): Promise<void> {
    const phone = await this.#device(auth);
    if (phone.role !== 'primary') {
      throw new AppError('FORBIDDEN', { detail: 'Only your current phone can approve this.' });
    }
    const doc = await this.#pendingDoc(auth, requestId);
    const user = await this.d.auth.users.findOne({ _id: auth.userId });
    if (!user?.accountIdentityKey) throw new AppError('FORBIDDEN');
    const certificateOk = signatureOk(
      user.accountIdentityKey,
      () => deviceCertificateMessage(doc.deviceId, doc.identityKeys),
      input.deviceCertificate,
    );
    if (!certificateOk) {
      throw new AppError('INVALID_SIGNATURE', { detail: 'The device certificate is invalid.' });
    }
    const now = this.#now();
    const approved = await this.d.requests.updateOne(
      { _id: doc._id, state: 'pending', expiresAt: { $gt: new Date(now) } },
      {
        $set: {
          state: 'approved',
          approvedBy: phone._id,
          deviceCertificate: input.deviceCertificate,
          senderKey: phone.identityKeys.curve25519,
          sealed: input.sealed,
          nonce: randomToken(32),
          approvedAt: new Date(now),
          expiresAt: new Date(Math.max(doc.expiresAt.getTime(), now + COMPLETE_GRACE_MS)),
        },
      },
    );
    if (approved.modifiedCount === 0) throw new AppError('TRANSFER_ALREADY_USED');
    await this.d.events.record('primary_transfer_approve', context, auth.userId);
  }

  /** Any device of the account says no. */
  async deny(auth: AuthContext, requestId: string, context: RequestContext): Promise<void> {
    await this.#device(auth);
    const doc = await this.#pendingDoc(auth, requestId);
    const denied = await this.d.requests.updateOne(
      { _id: doc._id, state: 'pending' },
      { $set: { state: 'denied', closedAt: new Date(this.#now()) } },
    );
    if (denied.modifiedCount === 0) throw new AppError('TRANSFER_ALREADY_USED');
    await this.d.events.record('primary_transfer_deny', context, auth.userId);
  }

  /** The new phone proves its keys; the approver is revoked and the new phone registered. */
  async complete(
    auth: AuthContext,
    requestId: string,
    input: CompletePrimaryTransferRequest,
    context: RequestContext,
  ): Promise<RegisterDeviceResponse> {
    if (auth.deviceId) {
      throw new AppError('CONFLICT', { detail: 'This session already has a device.' });
    }
    const doc = await this.d.requests.findOne({
      _id: requestId,
      userId: auth.userId,
      sessionId: auth.sessionId,
    });
    if (!doc) throw new AppError('TRANSFER_NOT_FOUND');
    const now = this.#now();
    if (doc.state === 'completed' || doc.state === 'denied') {
      throw new AppError('TRANSFER_ALREADY_USED');
    }
    if (doc.expiresAt.getTime() <= now) throw new AppError('TRANSFER_EXPIRED');
    const { nonce, deviceCertificate, approvedBy } = doc;
    if (doc.state !== 'approved' || !nonce || !deviceCertificate || !approvedBy) {
      throw new AppError('CONFLICT', { detail: 'Your other phone has not approved this yet.' });
    }
    if (
      !signatureOk(
        doc.identityKeys.ed25519,
        () => deviceRegistrationMessage(nonce, doc.deviceId, doc.identityKeys),
        input.signature,
      )
    ) {
      throw new AppError('INVALID_SIGNATURE', { detail: 'Proof of possession failed.' });
    }
    const approver = await this.d.devices.devices.findOne({
      _id: approvedBy,
      userId: auth.userId,
      role: 'primary',
      status: 'active',
    });
    if (!approver) {
      throw new AppError('FORBIDDEN', { detail: 'The approving phone is no longer active.' });
    }
    const claimed = await this.d.requests.updateOne(
      { _id: doc._id, state: 'approved', nonce, expiresAt: { $gt: new Date(now) } },
      { $set: { state: 'completed', closedAt: new Date(now), sealed: null } },
    );
    if (claimed.modifiedCount === 0) throw new AppError('TRANSFER_ALREADY_USED');

    await this.d.deviceService.revokeDevice(approver, context);
    const result = await this.d.deviceService.insertPrimary(auth, {
      deviceId: doc.deviceId,
      platform: doc.platform,
      name: doc.name,
      identityKeys: doc.identityKeys,
      deviceCertificate,
    });
    await this.d.events.record('primary_transfer_complete', context, auth.userId);
    return result;
  }

  // (b) and (c) An email code

  async sendReplaceOtp(auth: AuthContext): Promise<void> {
    await this.#newPhone(auth);
    await this.d.authService.sendAccountOtp(auth.userId, 'primary_replace');
  }

  async replace(
    auth: AuthContext,
    input: ReplacePrimaryRequest,
    context: RequestContext,
  ): Promise<RegisterDeviceResponse> {
    await this.#newPhone(auth);
    const user = await this.d.auth.users.findOne({ _id: auth.userId });
    if (user?.status !== 'active') throw new AppError('FORBIDDEN');
    const fresh = input.mode === 'fresh';
    const accountKey = fresh ? input.accountIdentityKey : user.accountIdentityKey;
    if (!accountKey) {
      throw new AppError('VALIDATION_FAILED', {
        detail: fresh
          ? 'Starting fresh needs the new account identity key.'
          : 'This account has no identity key yet: register the phone directly.',
      });
    }
    if (!fresh && input.accountIdentityKey && input.accountIdentityKey !== accountKey) {
      throw new AppError('IDENTITY_KEY_MISMATCH');
    }
    // Signatures before the code, so a typo in the backup choice does not burn the code.
    const check = DeviceService.registrationValid(input, accountKey);
    if (check === 'proof') {
      throw new AppError('INVALID_SIGNATURE', { detail: 'Proof of possession failed.' });
    }
    if (check === 'certificate') {
      throw new AppError(fresh ? 'INVALID_SIGNATURE' : 'IDENTITY_KEY_MISMATCH', {
        detail: 'The device certificate is not from this account key.',
      });
    }
    if (await this.d.devices.devices.findOne({ _id: input.deviceId })) {
      throw new AppError('CONFLICT', { detail: 'Device ID already in use.' });
    }
    // The nonce first: a new one is cheap, a new email code is not.
    await this.d.deviceService.consumeChallenge(auth.userId, input.nonce);
    await this.d.authService.checkAccountOtp(auth.userId, 'primary_replace', input.otp, context);

    // (b): only the primary goes; linked browsers stay (they are certified by the same key).
    // (c): everything goes, since every certificate was made by the old key.
    const toRevoke = await this.d.devices.devices
      .find(
        fresh
          ? { userId: auth.userId, status: 'active' }
          : { userId: auth.userId, role: 'primary', status: 'active' },
      )
      .toArray();
    for (const device of toRevoke) await this.d.deviceService.revokeDevice(device, context);
    if (fresh) {
      await this.d.auth.users.updateOne(
        { _id: auth.userId },
        { $set: { accountIdentityKey: accountKey, updatedAt: new Date(this.#now()) } },
      );
    }
    const result = await this.d.deviceService.insertPrimary(auth, input);
    await this.d.events.record(fresh ? 'identity_reset' : 'primary_replace', context, auth.userId);
    return result;
  }
}
