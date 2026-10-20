/**
 * Web pairing (REQ §6.2, §13.1, §19.5; ADR 0019). A browser becomes a linked device only when
 * the account's active primary phone approves it, using signatures and Olm keys only:
 * 1. the browser creates a request (its identity keys) and shows the QR code;
 * 2. the phone scans it, sees the browser's details, and approves: its device key signs the
 *    pairing, and the account identity key certifies the browser's keys (ADR 0003);
 * 3. the browser polls with its secret, then signs the server's nonce with its own key, and
 *    only then is it registered and given device-bound tokens.
 * Every request is single-use and expires quickly; replays, wrong challenges, a non-primary
 * approver and a second approval or completion are refused.
 */
import type { Collection } from 'mongodb';

import {
  deviceCertificateMessage,
  deviceRegistrationMessage,
  fromBase64,
  pairingApprovalMessage,
  ProtocolError,
  uuidv7,
} from '@pingdost/protocol';
import type {
  ApprovePairingRequest,
  CompletePairingRequest,
  CreatePairingRequest,
  CreatePairingResponse,
  IdentityKeys,
  InspectPairingRequest,
  InspectPairingResponse,
  PairingStatusResponse,
  RegisterDeviceResponse,
} from '@pingdost/shared-types';

import type { PairingDoc } from './repo';
import type { Clock } from '../../infra/clock';
import { verifyEd25519 } from '../../infra/ed25519';
import { AppError } from '../../infra/errors';
import { duplicateKeyField } from '../../infra/mongo';
import { randomToken, safeEqual, type Hasher } from '../../infra/secrets';
import type { AuthContext } from '../auth/guard';
import type { AuthCollections } from '../auth/repo';
import type { AuthService } from '../auth/service';
import { startOfDay, type DeviceCollections, type DeviceDoc } from '../device/repo';
import { toSummary } from '../device/service';
import type { RequestContext, SecurityEvents } from '../security/events';

/** After approval the browser has at least this long to complete. */
const COMPLETE_GRACE_MS = 60_000;

export interface PairingServiceDeps {
  requests: Collection<PairingDoc>;
  devices: DeviceCollections;
  auth: AuthCollections;
  authService: AuthService;
  events: SecurityEvents;
  hasher: Hasher;
  clock: Clock;
  ttlSeconds: number;
}

function keysValid(keys: IdentityKeys): boolean {
  try {
    return fromBase64(keys.curve25519).length === 32 && fromBase64(keys.ed25519).length === 32;
  } catch {
    return false;
  }
}

function sameKeys(a: IdentityKeys, b: IdentityKeys): boolean {
  return a.curve25519 === b.curve25519 && a.ed25519 === b.ed25519;
}

function signatureOk(publicKey: string, message: () => Uint8Array, signature: string): boolean {
  try {
    return verifyEd25519(publicKey, message(), signature);
  } catch (error) {
    if (error instanceof ProtocolError) return false;
    throw error;
  }
}

export class PairingService {
  constructor(private readonly d: PairingServiceDeps) {}

  #now(): number {
    return this.d.clock.now();
  }

  #secretOk(doc: PairingDoc, pollSecret: string): boolean {
    return safeEqual(this.d.hasher.hash('pairing', pollSecret), doc.pollSecretHash);
  }

  /** Step 1 (the browser, unauthenticated). */
  async create(
    input: CreatePairingRequest,
    context: RequestContext,
  ): Promise<CreatePairingResponse> {
    if (!keysValid(input.identityKeys)) {
      throw new AppError('VALIDATION_FAILED', { detail: 'Identity keys must be 32 bytes each.' });
    }
    const now = this.#now();
    const pollSecret = randomToken(32);
    const doc: PairingDoc = {
      _id: uuidv7(),
      challenge: randomToken(32),
      pollSecretHash: this.d.hasher.hash('pairing', pollSecret),
      identityKeys: {
        curve25519: input.identityKeys.curve25519,
        ed25519: input.identityKeys.ed25519,
      },
      name: input.name,
      userAgent: context.userAgent?.slice(0, 128) ?? null,
      state: 'pending',
      createdAt: new Date(now),
      expiresAt: new Date(now + this.d.ttlSeconds * 1_000),
      userId: null,
      deviceId: null,
      deviceCertificate: null,
      approvedBy: null,
      nonce: null,
      approvedAt: null,
      completedAt: null,
    };
    await this.d.requests.insertOne(doc);
    return {
      pairingId: doc._id,
      challenge: doc.challenge,
      pollSecret,
      expiresAt: doc.expiresAt.getTime(),
    };
  }

  /** The browser polls with its secret. */
  async status(pairingId: string, pollSecret: string): Promise<PairingStatusResponse> {
    const doc = await this.d.requests.findOne({ _id: pairingId });
    if (!doc || !this.#secretOk(doc, pollSecret)) throw new AppError('PAIRING_NOT_FOUND');
    if (doc.state === 'completed') throw new AppError('PAIRING_ALREADY_USED');
    if (doc.expiresAt.getTime() <= this.#now()) return { status: 'expired' };
    if (doc.state === 'approved' && doc.deviceId && doc.nonce) {
      return { status: 'approved', deviceId: doc.deviceId, nonce: doc.nonce };
    }
    return { status: 'pending' };
  }

  /** The caller's device, if it is the account's active primary phone. */
  async #primary(auth: AuthContext): Promise<DeviceDoc> {
    if (!auth.deviceId) throw new AppError('DEVICE_REQUIRED');
    const device = await this.d.devices.devices.findOne({
      _id: auth.deviceId,
      userId: auth.userId,
      status: 'active',
    });
    if (device?.role !== 'primary') {
      throw new AppError('FORBIDDEN', { detail: 'Only the primary phone can link a browser.' });
    }
    return device;
  }

  /** A pending, unexpired request whose challenge matches (the phone holds the QR code). */
  async #pending(pairingId: string, challenge: string): Promise<PairingDoc> {
    const doc = await this.d.requests.findOne({ _id: pairingId });
    // A wrong challenge says no more than a wrong ID.
    if (!doc || !safeEqual(doc.challenge, challenge)) throw new AppError('PAIRING_NOT_FOUND');
    if (doc.state !== 'pending') throw new AppError('PAIRING_ALREADY_USED');
    if (doc.expiresAt.getTime() <= this.#now()) throw new AppError('PAIRING_EXPIRED');
    return doc;
  }

  /** Step 2a (the phone, after scanning): what it is about to approve. */
  async inspect(auth: AuthContext, input: InspectPairingRequest): Promise<InspectPairingResponse> {
    await this.#primary(auth);
    const doc = await this.#pending(input.pairingId, input.challenge);
    return {
      name: doc.name,
      userAgent: doc.userAgent,
      identityKeys: doc.identityKeys,
      createdAt: doc.createdAt.getTime(),
      expiresAt: doc.expiresAt.getTime(),
    };
  }

  /** Step 2b (the phone): approves, once. The browser is registered when it completes. */
  async approve(
    auth: AuthContext,
    input: ApprovePairingRequest,
    context: RequestContext,
  ): Promise<void> {
    const phone = await this.#primary(auth);
    const doc = await this.#pending(input.pairingId, input.challenge);
    if (!sameKeys(input.webKeys, doc.identityKeys)) {
      throw new AppError('VALIDATION_FAILED', { detail: 'The browser keys do not match.' });
    }
    if (
      !signatureOk(
        phone.identityKeys.ed25519,
        () => pairingApprovalMessage(doc._id, doc.challenge, input.deviceId, doc.identityKeys),
        input.signature,
      )
    ) {
      throw new AppError('INVALID_SIGNATURE', { detail: 'The approval signature is invalid.' });
    }
    const user = await this.d.auth.users.findOne({ _id: auth.userId });
    if (!user?.accountIdentityKey) throw new AppError('FORBIDDEN');
    if (
      !signatureOk(
        user.accountIdentityKey,
        () => deviceCertificateMessage(input.deviceId, doc.identityKeys),
        input.deviceCertificate,
      )
    ) {
      throw new AppError('INVALID_SIGNATURE', { detail: 'The device certificate is invalid.' });
    }
    if (await this.d.devices.devices.findOne({ _id: input.deviceId })) {
      throw new AppError('CONFLICT', { detail: 'Device ID already in use.' });
    }

    const now = this.#now();
    const approved = await this.d.requests.updateOne(
      {
        _id: doc._id,
        state: 'pending',
        challenge: doc.challenge,
        expiresAt: { $gt: new Date(now) },
      },
      {
        $set: {
          state: 'approved',
          userId: auth.userId,
          deviceId: input.deviceId,
          deviceCertificate: input.deviceCertificate,
          approvedBy: phone._id,
          nonce: randomToken(32),
          approvedAt: new Date(now),
          expiresAt: new Date(Math.max(doc.expiresAt.getTime(), now + COMPLETE_GRACE_MS)),
        },
      },
    );
    // Someone approved (or it expired) in between: single use.
    if (approved.modifiedCount === 0) throw new AppError('PAIRING_ALREADY_USED');
    await this.d.events.record('pairing_approve', context, auth.userId);
  }

  /** Step 3 (the browser): proves its keys, then becomes a linked device with its tokens. */
  async complete(
    pairingId: string,
    input: CompletePairingRequest,
    context: RequestContext,
  ): Promise<RegisterDeviceResponse> {
    const doc = await this.d.requests.findOne({ _id: pairingId });
    if (!doc || !this.#secretOk(doc, input.pollSecret)) throw new AppError('PAIRING_NOT_FOUND');
    if (doc.state === 'completed') throw new AppError('PAIRING_ALREADY_USED');
    const now = this.#now();
    if (doc.expiresAt.getTime() <= now) throw new AppError('PAIRING_EXPIRED');
    const { userId, deviceId, nonce, deviceCertificate, approvedBy } = doc;
    if (doc.state !== 'approved' || !userId || !deviceId || !nonce || !deviceCertificate) {
      throw new AppError('CONFLICT', { detail: 'The phone has not approved this browser yet.' });
    }
    if (
      !signatureOk(
        doc.identityKeys.ed25519,
        () => deviceRegistrationMessage(nonce, deviceId, doc.identityKeys),
        input.signature,
      )
    ) {
      throw new AppError('INVALID_SIGNATURE', { detail: 'Proof of possession failed.' });
    }
    // The approving phone may have been replaced or revoked since.
    const phone = await this.d.devices.devices.findOne({
      _id: approvedBy ?? '',
      userId,
      role: 'primary',
      status: 'active',
    });
    if (!phone)
      throw new AppError('FORBIDDEN', { detail: 'The approving phone is no longer active.' });

    const claimed = await this.d.requests.updateOne(
      { _id: doc._id, state: 'approved', nonce, expiresAt: { $gt: new Date(now) } },
      { $set: { state: 'completed', completedAt: new Date(now) } },
    );
    if (claimed.modifiedCount === 0) throw new AppError('PAIRING_ALREADY_USED');

    const device: DeviceDoc = {
      _id: deviceId,
      userId,
      platform: 'web',
      role: 'linked',
      name: doc.name,
      identityKeys: doc.identityKeys,
      deviceCertificate,
      fallbackKey: null,
      keyVersion: 1,
      status: 'active',
      createdAt: new Date(now),
      revokedAt: null,
      lastSeenAt: startOfDay(now),
    };
    try {
      await this.d.devices.devices.insertOne(device);
    } catch (error) {
      if (duplicateKeyField(error) === '_id') {
        throw new AppError('CONFLICT', { detail: 'Device ID already in use.' });
      }
      throw error;
    }
    // Contacts and this user's devices refetch the directory and start encrypting to it.
    await this.d.auth.users.updateOne({ _id: userId }, { $inc: { keyVersion: 1 } });
    const tokens = await this.d.authService.linkedDeviceSession(userId, deviceId, context);
    await this.d.events.record('device_link', context, userId);
    return { device: toSummary(device), tokens };
  }
}
