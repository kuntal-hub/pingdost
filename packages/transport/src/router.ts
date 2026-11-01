/**
 * Chooses a transport per packet (REQ §4.3, §11.1 mode 3; ADR 0024):
 * 1. the first online transport that reaches every device: the Internet (WebSocket);
 * 2. otherwise the first online transport that reaches the recipient device now: nearby;
 * 3. otherwise the first online transport that carries it into the mesh (ADR 0025: held on
 *    this device and handed to relays);
 * 4. otherwise `NO_ROUTE` when some transport is up (the packet waits for a nearby route), or
 *    `OFFLINE` when none is.
 * `onRoutesChanged` fires whenever a route may have appeared, so the sender flushes then. The
 * same envelope may still travel both ways (a nearby ACK lost, then the Internet back): the
 * recipient dedupes by envelope and message ID. Incoming packets from every transport reach
 * the same listeners, each with its own transport's ACK.
 */
import { bytesToUuid, UUID_BYTES, type TransportPacket } from '@pingdost/protocol';

import { Listeners, ValueStream, type ReadonlyValueStream } from './stream';
import type {
  PacketListener,
  RelayedEvent,
  Route,
  SendResult,
  Transport,
  TransportKind,
  TransportStatus,
  TypingSignal,
  Unsubscribe,
} from './types';

const OFFLINE: SendResult = { ok: false, code: 'OFFLINE', retryable: true };
const NO_ROUTE: SendResult = { ok: false, code: 'NO_ROUTE', retryable: true };

export class TransportRouter {
  readonly #transports: Transport[];
  readonly #status = new ValueStream<TransportStatus>('offline');
  readonly #packets = new Listeners<Parameters<PacketListener>>();
  readonly #typing = new Listeners<[TypingSignal]>();
  readonly #ephemeral = new Listeners<[TransportPacket]>();
  readonly #routes = new Listeners<[]>();
  readonly #relayed = new Listeners<[RelayedEvent]>();
  readonly #unsubscribe: Unsubscribe[] = [];

  /** `transports` in order of preference. */
  constructor(transports: Transport[]) {
    this.#transports = transports;
    for (const transport of transports) {
      this.#unsubscribe.push(
        transport.status$.subscribe(() => {
          this.#updateStatus();
          this.#routes.emit();
        }),
        transport.onPacket((packet, ack) => this.#packets.emit(packet, ack)),
      );
      if (transport.onTyping) {
        this.#unsubscribe.push(transport.onTyping((typing) => this.#typing.emit(typing)));
      }
      if (transport.onEphemeral) {
        this.#unsubscribe.push(transport.onEphemeral((packet) => this.#ephemeral.emit(packet)));
      }
      if (transport.onReachability) {
        this.#unsubscribe.push(transport.onReachability(() => this.#routes.emit()));
      }
      if (transport.onRelayed) {
        this.#unsubscribe.push(transport.onRelayed((event) => this.#relayed.emit(event)));
      }
    }
    this.#updateStatus();
  }

  /** `online` when any transport is (for nearby: while it is looking for peers). */
  get status$(): ReadonlyValueStream<TransportStatus> {
    return this.#status;
  }

  /** The kinds that can carry packets now. */
  get online(): TransportKind[] {
    return this.#transports.filter((t) => t.status$.value === 'online').map((t) => t.kind);
  }

  /** How a packet to `deviceId` would go now. */
  route(deviceId: string): Route {
    const picked = this.#pick(deviceId);
    if (picked) return picked.mesh ? 'mesh' : picked.transport.kind;
    return this.#anyOnline() ? 'unreachable' : 'offline';
  }

  /** Relays accepted an envelope that a transport holds for the mesh. */
  onRelayed(listener: (event: RelayedEvent) => void): Unsubscribe {
    return this.#relayed.add(listener);
  }

  /** The sender is done with these envelopes: every transport drops what it still holds. */
  withdraw(envelopeIds: readonly string[]): void {
    if (envelopeIds.length === 0) return;
    for (const transport of this.#transports) transport.withdraw?.(envelopeIds);
  }

  /** Fires when a transport's status or nearby reach changes: queued packets may go now. */
  onRoutesChanged(listener: () => void): Unsubscribe {
    return this.#routes.add(listener);
  }

  /** Over the preferred transport that reaches `packet.dst`; the result names the path. */
  async send(packet: TransportPacket): Promise<SendResult> {
    const deviceId = packet.dst.length === UUID_BYTES ? bytesToUuid(packet.dst) : undefined;
    const picked = this.#pick(deviceId);
    if (!picked) return this.#anyOnline() ? NO_ROUTE : OFFLINE;
    const result = await picked.transport.send(packet);
    return result.ok ? { ...result, via: result.via ?? picked.transport.kind } : result;
  }

  onPacket(listener: PacketListener): Unsubscribe {
    return this.#packets.add(listener);
  }

  sendTyping(typing: TypingSignal): boolean {
    const transport = this.#transports.find(
      (t) => t.status$.value === 'online' && t.sendTyping !== undefined,
    );
    return transport?.sendTyping?.(typing) ?? false;
  }

  onTyping(listener: (typing: TypingSignal) => void): Unsubscribe {
    return this.#typing.add(listener);
  }

  /** Over the first online transport that relays ephemeral packets; `OFFLINE` if none. */
  sendEphemeral(packet: TransportPacket): Promise<SendResult> {
    const transport = this.#transports.find(
      (t) => t.status$.value === 'online' && t.sendEphemeral !== undefined,
    );
    return transport?.sendEphemeral?.(packet) ?? Promise.resolve(OFFLINE);
  }

  onEphemeral(listener: (packet: TransportPacket) => void): Unsubscribe {
    return this.#ephemeral.add(listener);
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
  }

  /** Transports that reach every device first, then those that reach this one, then the mesh. */
  #pick(deviceId: string | undefined): { transport: Transport; mesh: boolean } | undefined {
    const online = this.#transports.filter((t) => t.status$.value === 'online');
    const everywhere = online.find((t) => t.reaches === undefined);
    if (everywhere) return { transport: everywhere, mesh: false };
    if (deviceId === undefined) return undefined;
    const direct = online.find((t) => t.reaches?.(deviceId) === true);
    if (direct) return { transport: direct, mesh: false };
    const mesh = online.find((t) => t.carries?.(deviceId) === true);
    return mesh ? { transport: mesh, mesh: true } : undefined;
  }

  #anyOnline(): boolean {
    return this.#transports.some((t) => t.status$.value === 'online');
  }

  #updateStatus(): void {
    const statuses = this.#transports.map((t) => t.status$.value);
    this.#status.set(
      statuses.includes('online')
        ? 'online'
        : statuses.includes('connecting')
          ? 'connecting'
          : 'offline',
    );
  }
}
