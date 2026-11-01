/**
 * The mesh simulation harness (Phase 23, ADR 0025): virtual phones, each a real engine with
 * real vodozemac, the real router, `NearbyPeerTransport` with its `MeshRelay`, an in-memory
 * radio and an in-memory relay store. A mobility schedule says who is in range of whom, and
 * when. The Internet is the fake server, switched off for "airplane mode".
 */
import { MemoryChunkStorage, MeshFileReceiver } from '@pingdost/attachments';
import type { CryptoProvider } from '@pingdost/crypto';
import { MemoryMeshPersistence, type MeshPolicy } from '@pingdost/mesh-protocol';
import { fromBase64 } from '@pingdost/protocol';
import { NearbyPeerTransport, TransportRouter, type MeshStatus } from '@pingdost/transport';
import { connectFakeLinks, FakeLinks } from '@pingdost/transport/testing';

import { attachmentDecryptInput } from '../attachments';
import { createNearbyIdentity } from '../routing/identity';
import { createTestClient, FakeServer, type TestClient } from '../testing';

export interface SimPhone {
  name: string;
  client: TestClient;
  nearby: NearbyPeerTransport;
  radio: FakeLinks;
  persistence: MemoryMeshPersistence;
  /** Relay log lines (states and counts only). */
  log: string[];
  /** With `files`: the receiver, its chunk store, and verified files' ciphertext by ID. */
  receiver?: MeshFileReceiver;
  chunks?: MemoryChunkStorage;
  files: Map<string, Uint8Array>;
}

export interface SimPhoneOptions {
  /**
   * Receive mesh files (ADR 0027): a `MeshFileReceiver` over in-memory chunks that confirms
   * each verified file to the engine and keeps its ciphertext in `files`.
   */
  files?: boolean;
  relaying?: boolean;
  /** A relay store to start from (e.g. with a tampered packet in it). */
  persistence?: MemoryMeshPersistence;
  policy?: Partial<MeshPolicy>;
  blocked?: (userId: string) => boolean;
}

/** One step of a mobility schedule, `at` milliseconds after it starts. */
export type MobilityStep =
  | { at: number; meet: [SimPhone, SimPhone] }
  | { at: number; part: [SimPhone, SimPhone] }
  | { at: number; run: () => unknown };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class MeshSim {
  readonly phones: SimPhone[] = [];
  readonly #links = new Map<string, { radio: FakeLinks; id: number }>();
  readonly #started = new Set<SimPhone>();
  #airplane = false;

  constructor(
    private readonly crypto: CryptoProvider,
    readonly server = new FakeServer(),
  ) {}

  async phone(name: string, options: SimPhoneOptions = {}): Promise<SimPhone> {
    const radio = new FakeLinks();
    const persistence = options.persistence ?? new MemoryMeshPersistence();
    const log: string[] = [];
    const files = new Map<string, Uint8Array>();
    // Files: attachment ID → message ID, learnt from incoming mesh manifests.
    const messageOf = new Map<string, string>();
    // Set once the client exists; the receiver's hooks run later.
    const refs: { engine?: TestClient['engine']; nearby?: NearbyPeerTransport } = {};
    const chunks = options.files ? new MemoryChunkStorage() : undefined;
    const receiver = chunks
      ? new MeshFileReceiver(this.crypto, chunks, {
          verified: async (transferId, read) => {
            const parts: Uint8Array[] = [];
            for await (const part of read()) parts.push(part);
            const whole = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
            let offset = 0;
            for (const part of parts) {
              whole.set(part, offset);
              offset += part.length;
            }
            files.set(transferId, whole);
            const messageId = messageOf.get(transferId);
            if (messageId) await refs.engine?.confirmMeshFile(messageId);
          },
          // Paused, cancelled or complete: holders hear it at once.
          settled: () => refs.nearby?.mesh?.transfersChanged(),
        })
      : undefined;
    let nearby: NearbyPeerTransport | undefined;
    const down = this.server.apiDown;
    this.server.apiDown = false; // registering needs the server
    const client = await createTestClient(this.server, this.crypto, {
      ...(options.blocked ? { blocked: options.blocked } : {}),
      ...(process.env.ENGINE_LOG
        ? { log: (level, message, fields) => console.log(name, level, message, fields ?? '') }
        : {}),
      transport: ({ internet, userId, deviceId, account, store }) => {
        nearby = new NearbyPeerTransport({
          links: radio,
          identity: createNearbyIdentity({
            self: { userId, deviceId },
            crypto: this.crypto,
            account,
            store,
            ...(options.blocked ? { blocked: options.blocked } : {}),
          }),
          ackTimeoutMs: 300,
          handshakeTimeoutMs: 1_000,
          log: (message, fields) => {
            log.push(fields ? `${message} ${JSON.stringify(fields)}` : message);
            if (process.env.ENGINE_LOG) console.log(name, message, fields ?? '');
          },
          mesh: {
            persistence,
            relaying: options.relaying ?? false,
            policy: { ackTimeoutMs: 1_000, ...options.policy },
            ...(receiver ? { files: receiver } : {}),
          },
        });
        return new TransportRouter([internet, nearby]);
      },
    });
    this.server.apiDown = down;
    if (!nearby) throw new Error('no nearby transport');
    refs.engine = client.engine;
    refs.nearby = nearby;
    if (receiver) {
      // The app's part: an incoming mesh manifest tells the receiver what to check against.
      client.engine.subscribeAll((_, event) => {
        if (event.type !== 'message') return;
        const info = event.message.attachment;
        if (event.message.direction !== 'in' || !info?.mesh) return;
        messageOf.set(info.attachmentId, event.message.messageId);
        receiver.expect(info.attachmentId, {
          ...attachmentDecryptInput(info),
          chunkHashListSha256: fromBase64(info.chunkHashListSha256),
        });
      });
    }
    const phone: SimPhone = {
      name,
      client,
      nearby,
      radio,
      persistence,
      log,
      files,
      ...(receiver ? { receiver } : {}),
      ...(chunks ? { chunks } : {}),
    };
    this.phones.push(phone);
    if (this.#airplane) await this.#offline(phone);
    return phone;
  }

  /** Online once together: each caches the others' verified directories (and fallback keys). */
  async introduce(...phones: SimPhone[]): Promise<void> {
    this.server.apiDown = false;
    for (const p of phones) await this.#online(p);
    for (const p of phones) {
      for (const other of phones) {
        if (other !== p) await p.client.engine.refreshDevices(other.client.userId);
      }
    }
    if (this.#airplane) {
      this.server.apiDown = true;
      for (const p of phones) await this.#offline(p);
    }
  }

  /** Airplane mode with Bluetooth on, for every phone: no socket, no REST, nearby looking. */
  async airplane(): Promise<void> {
    this.#airplane = true;
    this.server.apiDown = true;
    for (const p of this.phones) await this.#offline(p);
  }

  async #offline(p: SimPhone): Promise<void> {
    await this.#online(p);
    p.client.transport.disconnect();
    await p.nearby.start();
  }

  /** The Internet is back for these phones. */
  internet(...phones: SimPhone[]): void {
    this.#airplane = false;
    this.server.apiDown = false;
    for (const p of phones) p.client.transport.connect();
  }

  meet(a: SimPhone, b: SimPhone): void {
    const [idA] = connectFakeLinks(a.radio, b.radio);
    this.#links.set(this.#key(a, b), { radio: a.radio, id: idA });
  }

  part(a: SimPhone, b: SimPhone): void {
    const key = this.#key(a, b);
    const link = this.#links.get(key);
    if (!link) return;
    this.#links.delete(key);
    link.radio.drop(link.id);
  }

  /** Runs a mobility schedule; resolves after its last step. */
  async run(schedule: MobilityStep[]): Promise<void> {
    const start = Date.now();
    for (const step of [...schedule].sort((x, y) => x.at - y.at)) {
      const wait = step.at - (Date.now() - start);
      if (wait > 0) await sleep(wait);
      if ('meet' in step) this.meet(...step.meet);
      else if ('part' in step) this.part(...step.part);
      else await step.run();
    }
  }

  meshOf(p: SimPhone): MeshStatus {
    const status = p.nearby.mesh?.status$.value;
    if (!status) throw new Error('no mesh');
    return status;
  }

  async stop(): Promise<void> {
    for (const p of this.phones.splice(0)) {
      p.nearby.dispose();
      await p.client.engine.stop();
    }
  }

  async #online(p: SimPhone): Promise<void> {
    p.client.transport.connect();
    if (!this.#started.has(p)) {
      this.#started.add(p);
      await p.client.engine.start();
    }
  }

  #key(a: SimPhone, b: SimPhone): string {
    return [a.name, b.name].sort().join('|');
  }
}
