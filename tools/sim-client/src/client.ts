/**
 * A headless PingDost device on the real stack (Phase 9): an account and device registered
 * over REST (the email code read from Mailpit), then the message engine with the WASM
 * `CryptoProvider`, an in-memory store and the gateway WebSocket. Used by the CLI and by the
 * server's engine integration tests.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import {
  authApi,
  circlesApi,
  createApiClient,
  devicesApi,
  groupsApi,
  keysApi,
  pairingApi,
  recoveryApi,
  type ApiClient,
} from '@pingdost/api-client';
import {
  approveTransfer,
  openTransferApproval,
  transferCode,
  transferOneTimeKey,
} from '@pingdost/backup';
import type { CryptoProvider, OlmAccount, SigningKey } from '@pingdost/crypto';
import {
  MemoryEngineStore,
  MessageEngine,
  publishKeys,
  type EngineLogger,
  type EngineOptions,
  type EngineStore,
} from '@pingdost/message-engine';
import { uuidv7 } from '@pingdost/protocol/ids';
import { parsePairingQr } from '@pingdost/protocol/pairing';
import {
  deviceCertificateMessage,
  deviceRegistrationMessage,
  pairingApprovalMessage,
} from '@pingdost/protocol/signing';
import type { AuthTokens } from '@pingdost/shared-types';
import { TransportRouter, WsTransport, type WebSocketFactory } from '@pingdost/transport';

export interface Endpoints {
  /** `http://host:port`. */
  api: string;
  /** `ws://host:port/v1/ws`. */
  ws: string;
  mailpit: string;
}

export interface SimClientOptions {
  endpoints: Endpoints;
  crypto: CryptoProvider;
  settings?: EngineOptions['settings'];
  receipts?: EngineOptions['receipts'];
  /** E.g. to capture every WebSocket frame. */
  createSocket?: WebSocketFactory;
  log?: EngineLogger;
  /** Another EngineStore for this device (default: in memory). */
  store?: EngineStore;
  /** History sync (ADR 0021): a browser-like device asks, a phone-like one serves files. */
  historySync?: EngineOptions['historySync'];
}

async function otpFor(mailpit: string, email: string): Promise<string> {
  const query = encodeURIComponent(`to:"${email}"`);
  for (let attempt = 0; attempt < 50; attempt++) {
    const search = (await (await fetch(`${mailpit}/api/v1/search?query=${query}`)).json()) as {
      messages: { ID: string }[];
    };
    const newest = search.messages[0];
    if (newest) {
      const message = (await (await fetch(`${mailpit}/api/v1/message/${newest.ID}`)).json()) as {
        Text: string;
      };
      const code = /\b(\d{6})\b/.exec(message.Text)?.[1];
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`no verification email for ${email} in Mailpit`);
}

export class SimClient {
  /** The in-memory store, unless options.store replaces it (e.g. the web's Dexie store). */
  readonly store = new MemoryEngineStore();
  readonly pickleKey = new Uint8Array(randomBytes(32));
  readonly api: ApiClient;
  transport: WsTransport;
  engine: MessageEngine;
  #router: TransportRouter;
  #tokens: AuthTokens;

  private constructor(
    private readonly options: SimClientOptions,
    readonly username: string,
    /** The account password (a simulated account; never a real one). */
    readonly password: string,
    readonly userId: string,
    readonly deviceId: string,
    readonly account: OlmAccount,
    /** The account identity key; only the primary device holds it. */
    readonly identity: SigningKey | undefined,
    readonly accountIdentityKey: string,
    tokens: AuthTokens,
  ) {
    this.#tokens = tokens;
    this.api = createApiClient({
      baseUrl: options.endpoints.api,
      getAccessToken: () => this.#tokens.accessToken,
      onRefresh: () => this.#refresh(),
      retries: 0,
    });
    [this.transport, this.#router, this.engine] = this.#makeEngine();
  }

  /** The current device-bound access token (load tests replay it in their own sockets). */
  get accessToken(): string {
    return this.#tokens.accessToken;
  }

  /**
   * Puts `other` in this user's circle through the real API (Phase 37): this one asks, the
   * other accepts. Users must be linked before they message or call each other one to one,
   * or one adds the other to a group.
   */
  async linkWith(other: SimClient): Promise<void> {
    if (other.userId === this.userId) return;
    if ((await circlesApi(this.api).request(other.userId)) === 'linked') return;
    await circlesApi(other.api).accept(this.userId);
  }

  /** Links every pair of `clients` (devices of the same user are skipped). */
  static async linkAll(...clients: SimClient[]): Promise<void> {
    for (let i = 0; i < clients.length; i++) {
      for (let j = i + 1; j < clients.length; j++) await clients[i]!.linkWith(clients[j]!);
    }
  }

  /** A new user with a primary device, its one-time keys and fallback key published. */
  static async register(options: SimClientOptions): Promise<SimClient> {
    const { endpoints, crypto } = options;
    const bearer: { token?: string } = {};
    const client = createApiClient({ baseUrl: endpoints.api, getAccessToken: () => bearer.token });
    const auth = authApi(client);
    const devices = devicesApi(client);

    const id = randomUUID().replaceAll('-', '').slice(0, 10);
    const username = `sim_${id}`;
    const email = `${username}@sim.pingdost.localhost`;
    const password = `sim password ${id}`;
    await auth.register({ username, email, password });
    const session = await auth.verifyEmail({ email, otp: await otpFor(endpoints.mailpit, email) });
    bearer.token = session.tokens.accessToken;

    const account = crypto.createAccount();
    const identity = crypto.createSigningKey();
    const deviceId = uuidv7();
    const keys = account.identityKeys();
    const { nonce } = await devices.challenge();
    const { tokens } = await devices.register({
      deviceId,
      platform: 'android',
      name: 'sim-client',
      identityKeys: keys,
      nonce,
      signature: account.sign(deviceRegistrationMessage(nonce, deviceId, keys)),
      deviceCertificate: identity.sign(deviceCertificateMessage(deviceId, keys)),
      accountIdentityKey: identity.publicKey(),
    });
    const sim = new SimClient(
      options,
      username,
      password,
      session.user.userId,
      deviceId,
      account,
      identity,
      identity.publicKey(),
      tokens,
    );
    await sim.publishKeys(true);
    return sim;
  }

  /**
   * Another device of `owner`'s account, linked the way a browser is (ADR 0019): a pairing
   * request, the owner's approval (its device signature and the account certificate), then
   * this device's proof of possession.
   */
  static async linkedDevice(
    options: SimClientOptions,
    owner: SimClient,
    name = 'sim-browser',
  ): Promise<SimClient> {
    if (!owner.identity) throw new Error('only the primary device holds the identity key');
    const account = options.crypto.createAccount();
    const deviceId = uuidv7();
    const identityKeys = account.identityKeys();
    const browser = pairingApi(createApiClient({ baseUrl: options.endpoints.api, retries: 0 }));
    const request = await browser.create({ identityKeys, name });
    const { pairingId, challenge } = request;
    await owner.#approve(pairingId, challenge, deviceId, identityKeys);
    const status = await browser.status(pairingId, request.pollSecret);
    if (status.status !== 'approved' || !status.nonce) throw new Error('pairing not approved');
    const { tokens } = await browser.complete(pairingId, {
      pollSecret: request.pollSecret,
      signature: account.sign(deviceRegistrationMessage(status.nonce, deviceId, identityKeys)),
    });
    const sim = new SimClient(
      options,
      owner.username,
      owner.password,
      owner.userId,
      deviceId,
      account,
      undefined,
      owner.accountIdentityKey,
      tokens,
    );
    await sim.publishKeys(true);
    return sim;
  }

  /**
   * A new phone for `old`'s account (ADR 0022), logged in with the same password:
   * - `transfer`: `old` (the active primary, still running) approves it after the codes match;
   * - `restore`: an email code, and the account identity key from a backup;
   * - `fresh`: an email code and a new account identity key (every old device is revoked).
   */
  static async newPhone(
    options: SimClientOptions,
    old: SimClient,
    how: { mode: 'transfer' } | { mode: 'restore'; identitySecret: string } | { mode: 'fresh' },
  ): Promise<SimClient> {
    const { endpoints, crypto } = options;
    const bearer: { token?: string } = {};
    const client = createApiClient({
      baseUrl: endpoints.api,
      getAccessToken: () => bearer.token,
      retries: 0,
    });
    const session = await authApi(client).login({
      identifier: old.username,
      password: old.password,
    });
    bearer.token = session.tokens.accessToken;
    const recovery = recoveryApi(client);
    const account = crypto.createAccount();
    const deviceId = uuidv7();
    const keys = account.identityKeys();
    let identity: SigningKey;
    let tokens: AuthTokens;
    if (how.mode === 'transfer') {
      const { requestId } = await recovery.start({
        deviceId,
        platform: 'android',
        name: 'sim-client (new phone)',
        identityKeys: keys,
        oneTimeKey: transferOneTimeKey(account, deviceId),
      });
      const shown = transferCode(crypto, requestId, deviceId, keys);
      await old.approveTransfer(requestId, shown);
      const status = await recovery.status(requestId);
      if (status.status !== 'approved' || !status.approval) throw new Error('not approved');
      identity = openTransferApproval(crypto, account, status.approval, {
        requestId,
        userId: old.userId,
        deviceId,
        accountIdentityKey: old.accountIdentityKey,
      });
      ({ tokens } = await recovery.complete(requestId, {
        signature: account.sign(deviceRegistrationMessage(status.approval.nonce, deviceId, keys)),
      }));
    } else {
      identity =
        how.mode === 'restore'
          ? crypto.restoreSigningKey(how.identitySecret)
          : crypto.createSigningKey();
      await recovery.sendReplaceCode();
      const otp = await otpFor(endpoints.mailpit, `${old.username}@sim.pingdost.localhost`);
      const { nonce } = await devicesApi(client).challenge();
      ({ tokens } = await recovery.replace({
        mode: how.mode,
        otp,
        deviceId,
        platform: 'android',
        name: 'sim-client (new phone)',
        identityKeys: keys,
        nonce,
        signature: account.sign(deviceRegistrationMessage(nonce, deviceId, keys)),
        deviceCertificate: identity.sign(deviceCertificateMessage(deviceId, keys)),
        accountIdentityKey: identity.publicKey(),
      }));
    }
    const sim = new SimClient(
      options,
      old.username,
      old.password,
      old.userId,
      deviceId,
      account,
      identity,
      identity.publicKey(),
      tokens,
    );
    await sim.publishKeys(true);
    return sim;
  }

  /**
   * As the primary phone: approves the pending phone-change request `requestId`, if the code
   * this phone computes matches `expectedCode` (what the new phone shows).
   */
  async approveTransfer(requestId: string, expectedCode: string): Promise<void> {
    if (!this.identity) throw new Error('only the primary phone can approve a new phone');
    const recovery = recoveryApi(this.api);
    const request = (await recovery.pending()).requests.find((r) => r.requestId === requestId);
    if (!request) throw new Error('no such pending request');
    const code = transferCode(
      this.options.crypto,
      requestId,
      request.deviceId,
      request.identityKeys,
    );
    if (code !== expectedCode) throw new Error('the codes differ: refusing');
    await recovery.approve(
      requestId,
      approveTransfer(this.options.crypto, this.account, this.identity, this.userId, request),
    );
  }
  /** As the primary phone: approves a browser for this account (ADR 0019). */
  async #approve(
    pairingId: string,
    challenge: string,
    deviceId: string,
    keys: { curve25519: string; ed25519: string },
  ): Promise<void> {
    if (!this.identity) throw new Error('only the primary device can approve a browser');
    const phone = pairingApi(this.api);
    const details = await phone.inspect({ pairingId, challenge });
    if (details.identityKeys.ed25519 !== keys.ed25519) {
      throw new Error('the server shows other keys than the code');
    }
    await phone.approve({
      pairingId,
      challenge,
      deviceId,
      webKeys: keys,
      signature: this.account.sign(pairingApprovalMessage(pairingId, challenge, deviceId, keys)),
      deviceCertificate: this.identity.sign(deviceCertificateMessage(deviceId, keys)),
    });
  }

  /**
   * Approves the browser showing this pairing code, as the phone's scanner would. Returns the
   * device ID it gave the browser.
   */
  async approveBrowser(code: string): Promise<string> {
    const qr = parsePairingQr(code);
    const deviceId = uuidv7();
    await this.#approve(qr.pairingId, qr.challenge, deviceId, {
      curve25519: qr.curve25519,
      ed25519: qr.ed25519,
    });
    return deviceId;
  }

  /** Tops up one-time keys (and the fallback key on first setup). */
  async publishKeys(needsFallbackKey = false): Promise<void> {
    await publishKeys({
      account: this.account,
      deviceId: this.deviceId,
      keys: keysApi(this.api),
      saveAccount: () => this.engineStore.apply({ account: this.account.pickle(this.pickleKey) }),
      needsFallbackKey,
    });
  }

  /** Connects and starts the engine. */
  async start(): Promise<void> {
    this.transport.start();
    await this.engine.start();
  }

  async stop(): Promise<void> {
    this.transport.stop();
    await this.engine.stop();
  }

  /** Like an app restart: a new engine and socket on the same store and account. */
  async restart(): Promise<void> {
    await this.stop();
    this.#router.dispose();
    [this.transport, this.#router, this.engine] = this.#makeEngine();
    await this.start();
  }

  /** The store the engine runs on. */
  get engineStore(): EngineStore {
    return this.options.store ?? this.store;
  }

  #makeEngine(): [WsTransport, TransportRouter, MessageEngine] {
    const { options } = this;
    const transport = new WsTransport({
      url: options.endpoints.ws,
      getAccessToken: () => this.#tokens.accessToken,
      refreshToken: () => this.#refresh(),
      backoff: { baseMs: 200, maxMs: 2_000 },
      ...(options.createSocket ? { createSocket: options.createSocket } : {}),
    });
    const router = new TransportRouter([transport]);
    const keys = keysApi(this.api);
    const engine = new MessageEngine({
      self: {
        userId: this.userId,
        deviceId: this.deviceId,
        accountIdentityKey: this.accountIdentityKey,
      },
      crypto: options.crypto,
      account: this.account,
      pickleKey: this.pickleKey,
      store: this.engineStore,
      transport: router,
      api: { ...keys, keys, groups: groupsApi(this.api) },
      ...(options.settings ? { settings: options.settings } : {}),
      ...(options.receipts ? { receipts: options.receipts } : {}),
      ...(options.historySync ? { historySync: options.historySync } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
    transport.onEvent((event) => {
      if (event.type === 'otk_low') void engine.replenishKeys().catch(() => undefined);
      if (event.type === 'group_changed')
        void engine.syncGroup(event.groupId).catch(() => undefined);
    });
    return [transport, router, engine];
  }

  async #refresh(): Promise<boolean> {
    try {
      const auth = authApi(createApiClient({ baseUrl: this.options.endpoints.api }));
      this.#tokens = await auth.refresh(this.#tokens.refreshToken);
      return true;
    } catch {
      return false;
    }
  }
}
