/**
 * A headless PingDost device on the real stack (Phase 9): an account and device registered
 * over REST (the email code read from Mailpit), then the message engine with the WASM
 * `CryptoProvider`, an in-memory store and the gateway WebSocket. Used by the CLI and by the
 * server's engine integration tests.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import {
  authApi,
  createApiClient,
  devicesApi,
  keysApi,
  type ApiClient,
} from '@pingdost/api-client';
import type { CryptoProvider, OlmAccount, SigningKey } from '@pingdost/crypto';
import {
  MemoryEngineStore,
  MessageEngine,
  publishKeys,
  type EngineLogger,
  type EngineOptions,
} from '@pingdost/message-engine';
import { uuidv7 } from '@pingdost/protocol/ids';
import { deviceCertificateMessage, deviceRegistrationMessage } from '@pingdost/protocol/signing';
import type { AuthTokens, IdentityKeys } from '@pingdost/shared-types';
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
}

/** A device's keys before it is registered: what a linked device (Phase 16 pairing) needs. */
export interface NewDeviceKeys {
  deviceId: string;
  identityKeys: IdentityKeys;
  /** Signed by the account identity key. */
  deviceCertificate: string;
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
   * Another device of `owner`'s account. Until QR pairing exists (Phase 16), `bind` registers
   * the device out of band and returns tokens bound to it.
   */
  static async linkedDevice(
    options: SimClientOptions,
    owner: SimClient,
    bind: (device: NewDeviceKeys) => Promise<AuthTokens>,
  ): Promise<SimClient> {
    if (!owner.identity) throw new Error('only the primary device holds the identity key');
    const account = options.crypto.createAccount();
    const deviceId = uuidv7();
    const identityKeys = account.identityKeys();
    const tokens = await bind({
      deviceId,
      identityKeys,
      deviceCertificate: owner.identity.sign(deviceCertificateMessage(deviceId, identityKeys)),
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

  /** Tops up one-time keys (and the fallback key on first setup). */
  async publishKeys(needsFallbackKey = false): Promise<void> {
    await publishKeys({
      account: this.account,
      deviceId: this.deviceId,
      keys: keysApi(this.api),
      saveAccount: () => this.store.apply({ account: this.account.pickle(this.pickleKey) }),
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
      store: this.store,
      transport: router,
      api: { ...keys, keys },
      ...(options.settings ? { settings: options.settings } : {}),
      ...(options.receipts ? { receipts: options.receipts } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
    transport.onEvent((event) => {
      if (event.type === 'otk_low') void engine.replenishKeys().catch(() => undefined);
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
