/**
 * An in-memory gateway, mailbox and key directory for engine unit tests (no sockets). It keeps
 * the server rules the engine relies on (ADR 0010): envelopes are deduped by envelope ID,
 * stay in the mailbox until the recipient ACKs them, go only to active devices, and one-time
 * keys are claimed once each (then the fallback key). The real server is exercised by the
 * integration tests in `apps/server/test/engine.int.test.ts`.
 */
import type { CryptoProvider, OlmAccount, SigningKey } from '@pingdost/crypto/core';
import {
  bytesToUuid,
  decodeEnvelope,
  deviceCertificateMessage,
  uuidv7,
  type TransportPacket,
} from '@pingdost/protocol';
import type {
  ClaimKeysResponse,
  SignedKey,
  UploadKeysRequest,
  UserKeysResponse,
} from '@pingdost/shared-types';
import {
  Listeners,
  ValueStream,
  type PacketListener,
  type SendResult,
  type Transport,
  type TransportStatus,
  type TypingSignal,
} from '@pingdost/transport';

import type { EngineOptions } from '../core';
import type { DirectoryApi } from '../directory';
import { MessageEngine } from '../engine';
import { publishKeys } from '../keys';
import { MemoryEngineStore } from '../memoryStore';
import type { EngineStore } from '../store';

/** What `ApiError` looks like to the engine: a shared error code. */
export class FakeApiError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

interface FakeDevice {
  deviceId: string;
  userId: string;
  curve25519: string;
  ed25519: string;
  certificate: string;
  oneTimeKeys: SignedKey[];
  fallbackKey: SignedKey | null;
  active: boolean;
}

interface FakeUser {
  userId: string;
  accountIdentityKey: string;
  keyVersion: number;
}

export class FakeServer {
  readonly users = new Map<string, FakeUser>();
  readonly devices = new Map<string, FakeDevice>();
  /** Recipient device → envelope ID → packet, until acknowledged. */
  readonly mailbox = new Map<string, Map<string, TransportPacket>>();
  /** Every packet the server accepted, for "ciphertext only" checks. */
  readonly accepted: TransportPacket[] = [];
  /** Answers used, in order, for the next sends instead of handling them. */
  readonly sendFaults: SendResult[] = [];
  /** Deliver every packet twice, as an online delivery plus a mailbox fetch can. */
  duplicateDeliveries = false;
  /** REST calls fail as if the server were unreachable. */
  apiDown = false;
  readonly #transports = new Map<string, FakeTransport>();

  addUser(identity: SigningKey): string {
    const userId = uuidv7();
    this.users.set(userId, { userId, accountIdentityKey: identity.publicKey(), keyVersion: 1 });
    return userId;
  }

  /** Registers a device certified by the account identity key. */
  addDevice(userId: string, identity: SigningKey, account: OlmAccount): string {
    const deviceId = uuidv7();
    const keys = account.identityKeys();
    this.devices.set(deviceId, {
      deviceId,
      userId,
      curve25519: keys.curve25519,
      ed25519: keys.ed25519,
      certificate: identity.sign(deviceCertificateMessage(deviceId, keys)),
      oneTimeKeys: [],
      fallbackKey: null,
      active: true,
    });
    this.#bump(userId);
    return deviceId;
  }

  revoke(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;
    device.active = false;
    this.mailbox.delete(deviceId);
    this.#transports.get(deviceId)?.disconnect();
    this.#bump(device.userId);
  }

  transport(deviceId: string): FakeTransport {
    let transport = this.#transports.get(deviceId);
    if (!transport) {
      transport = new FakeTransport(this, deviceId);
      this.#transports.set(deviceId, transport);
    }
    return transport;
  }

  /** The REST API as `deviceId` sees it. */
  api(deviceId: string): DirectoryApi & {
    keys: { count(): Promise<number>; upload(body: UploadKeysRequest): Promise<number> };
  } {
    const call = <T>(run: () => T): Promise<T> => {
      if (this.apiDown) return Promise.reject(new FakeApiError('UNAVAILABLE'));
      try {
        return Promise.resolve(run());
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    return {
      directory: (userId) => call(() => this.#directory(userId)),
      deviceOwner: (id) =>
        call(() => {
          const device = this.devices.get(id);
          if (!device?.active) throw new FakeApiError('NOT_FOUND');
          return { deviceId: id, userId: device.userId };
        }),
      claim: (deviceIds) => call(() => this.#claim(deviceIds)),
      keys: {
        count: () => call(() => this.#device(deviceId).oneTimeKeys.length),
        upload: (body) =>
          call(() => {
            const device = this.#device(deviceId);
            const known = new Set(device.oneTimeKeys.map((k) => k.keyId));
            device.oneTimeKeys.push(...body.oneTimeKeys.filter((k) => !known.has(k.keyId)));
            if (body.fallbackKey) device.fallbackKey = body.fallbackKey;
            return device.oneTimeKeys.length;
          }),
      },
    };
  }

  /** The gateway's `Send`. */
  send(from: string, packet: TransportPacket): SendResult {
    const fault = this.sendFaults.shift();
    if (fault) return fault;
    const envelope = decodeEnvelope(packet.payload);
    if (bytesToUuid(envelope.senderDeviceId) !== from) {
      return { ok: false, code: 'FORBIDDEN', retryable: false };
    }
    const to = bytesToUuid(envelope.recipientDeviceId);
    if (!this.devices.get(to)?.active) {
      return { ok: false, code: 'RECIPIENT_UNKNOWN', retryable: false };
    }
    const envelopeId = bytesToUuid(envelope.envelopeId);
    let box = this.mailbox.get(to);
    if (!box) {
      box = new Map();
      this.mailbox.set(to, box);
    }
    if (!box.has(envelopeId)) {
      box.set(envelopeId, packet);
      this.accepted.push(packet);
      const recipient = this.#transports.get(to);
      if (recipient?.status$.value === 'online') {
        recipient.deliver(packet);
        if (this.duplicateDeliveries) recipient.deliver(packet);
      }
    }
    return { ok: true, status: 'stored' };
  }

  ack(deviceId: string, envelopeId: string): void {
    this.mailbox.get(deviceId)?.delete(envelopeId);
  }

  /** On connect: everything pending for the device, oldest first. */
  pendingFor(deviceId: string): TransportPacket[] {
    return [...(this.mailbox.get(deviceId)?.values() ?? [])];
  }

  typing(from: string, typing: TypingSignal): boolean {
    for (const to of typing.recipientDeviceIds) {
      const recipient = this.#transports.get(to);
      if (recipient?.status$.value === 'online')
        recipient.typing({ ...typing, senderDeviceId: from });
    }
    return true;
  }

  #device(deviceId: string): FakeDevice {
    const device = this.devices.get(deviceId);
    if (!device?.active) throw new FakeApiError('DEVICE_REVOKED');
    return device;
  }

  #bump(userId: string): void {
    const user = this.users.get(userId);
    if (user) user.keyVersion++;
  }

  #directory(userId: string): UserKeysResponse {
    const user = this.users.get(userId);
    if (!user) throw new FakeApiError('NOT_FOUND');
    return {
      userId,
      accountIdentityKey: user.accountIdentityKey,
      keyVersion: user.keyVersion,
      devices: [...this.devices.values()]
        .filter((d) => d.userId === userId && d.active)
        .map((d) => ({
          deviceId: d.deviceId,
          platform: 'android' as const,
          role: 'primary' as const,
          identityKeys: { curve25519: d.curve25519, ed25519: d.ed25519 },
          deviceCertificate: d.certificate,
          fallbackKey: d.fallbackKey,
        })),
    };
  }

  #claim(deviceIds: string[]): ClaimKeysResponse {
    const keys: ClaimKeysResponse['keys'] = [];
    for (const deviceId of new Set(deviceIds)) {
      const device = this.devices.get(deviceId);
      if (!device?.active) continue;
      const key = device.oneTimeKeys.shift();
      if (key) keys.push({ deviceId, key, fallback: false });
      else if (device.fallbackKey) keys.push({ deviceId, key: device.fallbackKey, fallback: true });
    }
    return { keys };
  }
}

export class FakeTransport implements Transport {
  readonly kind = 'internet' as const;
  readonly status$ = new ValueStream<TransportStatus>('offline');
  readonly #packets = new Listeners<Parameters<PacketListener>>();
  readonly #typing = new Listeners<[TypingSignal]>();

  constructor(
    private readonly server: FakeServer,
    readonly deviceId: string,
  ) {}

  /** Comes online and receives the mailbox, as after `AuthOk`. */
  connect(): void {
    if (!this.server.devices.get(this.deviceId)?.active) return;
    this.status$.set('online');
    for (const packet of this.server.pendingFor(this.deviceId)) this.deliver(packet);
  }

  disconnect(): void {
    this.status$.set('offline');
  }

  send(packet: TransportPacket): Promise<SendResult> {
    if (this.status$.value !== 'online') {
      return Promise.resolve({ ok: false, code: 'OFFLINE', retryable: true });
    }
    return Promise.resolve(this.server.send(this.deviceId, packet));
  }

  onPacket(listener: PacketListener): () => void {
    return this.#packets.add(listener);
  }

  sendTyping(typing: TypingSignal): boolean {
    return this.status$.value === 'online' && this.server.typing(this.deviceId, typing);
  }

  onTyping(listener: (typing: TypingSignal) => void): () => void {
    return this.#typing.add(listener);
  }

  deliver(packet: TransportPacket): void {
    const envelopeId = bytesToUuid(decodeEnvelope(packet.payload).envelopeId);
    // Asynchronous, like a socket: the sender's `send` resolves first.
    setTimeout(() => {
      if (this.status$.value !== 'online') return;
      this.#packets.emit(packet, () => this.server.ack(this.deviceId, envelopeId));
    }, 0);
  }

  typing(signal: TypingSignal): void {
    this.#typing.emit(signal);
  }
}

export interface TestClient<S extends EngineStore = MemoryEngineStore> {
  userId: string;
  deviceId: string;
  identity: SigningKey;
  account: OlmAccount;
  pickleKey: Uint8Array;
  store: S;
  transport: FakeTransport;
  engine: MessageEngine;
  /** A new engine on the same store and account, as after an app restart. */
  restart(): Promise<MessageEngine>;
}

export interface TestClientOptions {
  /** Another device of this user (shares the account identity key). */
  sameUserAs?: TestClient;
  settings?: EngineOptions['settings'];
  receipts?: EngineOptions['receipts'];
  typingIndicators?: EngineOptions['typingIndicators'];
  blocked?: EngineOptions['blocked'];
  /** Publish this many one-time keys (default 5); 0 leaves only the fallback key. */
  oneTimeKeys?: number;
  now?: () => number;
  log?: EngineOptions['log'];
}

/** A registered device with published keys and an engine (not started, transport offline). */
export async function createTestClient<S extends EngineStore>(
  server: FakeServer,
  crypto: CryptoProvider,
  options: TestClientOptions & { store: S },
): Promise<TestClient<S>>;
export async function createTestClient(
  server: FakeServer,
  crypto: CryptoProvider,
  options?: TestClientOptions,
): Promise<TestClient>;
export async function createTestClient<S extends EngineStore>(
  server: FakeServer,
  crypto: CryptoProvider,
  options: TestClientOptions & { store?: S } = {},
): Promise<TestClient<S>> {
  const identity = options.sameUserAs?.identity ?? crypto.createSigningKey();
  const userId = options.sameUserAs?.userId ?? server.addUser(identity);
  const account = crypto.createAccount();
  const deviceId = server.addDevice(userId, identity, account);
  const store = options.store ?? (new MemoryEngineStore() as unknown as S);
  const pickleKey = new Uint8Array(32).fill(7);
  const api = server.api(deviceId);
  const keyCount = options.oneTimeKeys ?? 5;
  if (keyCount > 0) account.generateOneTimeKeys(keyCount);
  await publishKeys({
    account,
    deviceId,
    keys: {
      count: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
      upload: (body) => api.keys.upload(body),
    },
    saveAccount: () => store.apply({ account: account.pickle(pickleKey) }),
    needsFallbackKey: true,
  });
  const transport = server.transport(deviceId);
  const make = () =>
    new MessageEngine({
      self: { userId, deviceId, accountIdentityKey: identity.publicKey() },
      crypto,
      account,
      pickleKey,
      store,
      transport,
      api,
      settings: {
        receiptDelayMs: 0,
        retry: { baseMs: 20, maxMs: 100 },
        directoryMaxAgeMs: 0,
        ...options.settings,
      },
      ...(options.receipts ? { receipts: options.receipts } : {}),
      ...(options.typingIndicators ? { typingIndicators: options.typingIndicators } : {}),
      ...(options.blocked ? { blocked: options.blocked } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
  const client: TestClient<S> = {
    userId,
    deviceId,
    identity,
    account,
    pickleKey,
    store,
    transport,
    engine: make(),
    async restart() {
      await client.engine.stop();
      client.engine = make();
      return client.engine;
    },
  };
  return client;
}

/** Waits until `condition` holds (polling), or fails after `timeoutMs`. */
export async function eventually(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
