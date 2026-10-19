/**
 * Chooses a transport per packet (REQ §4.3). Phase 9 has the Internet only; Phase 22 adds the
 * nearby transport and routing by recipient reachability. Incoming packets from every
 * transport reach the same listeners, each with its own transport's ACK.
 */
import type { TransportPacket } from '@pingdost/protocol';

import { Listeners, ValueStream, type ReadonlyValueStream } from './stream';
import type {
  PacketListener,
  SendResult,
  Transport,
  TransportKind,
  TransportStatus,
  TypingSignal,
  Unsubscribe,
} from './types';

const OFFLINE: SendResult = { ok: false, code: 'OFFLINE', retryable: true };

export class TransportRouter {
  readonly #transports: Transport[];
  readonly #status = new ValueStream<TransportStatus>('offline');
  readonly #packets = new Listeners<Parameters<PacketListener>>();
  readonly #typing = new Listeners<[TypingSignal]>();
  readonly #unsubscribe: Unsubscribe[] = [];

  /** `transports` in order of preference. */
  constructor(transports: Transport[]) {
    this.#transports = transports;
    for (const transport of transports) {
      this.#unsubscribe.push(
        transport.status$.subscribe(() => this.#updateStatus()),
        transport.onPacket((packet, ack) => this.#packets.emit(packet, ack)),
      );
      if (transport.onTyping) {
        this.#unsubscribe.push(transport.onTyping((typing) => this.#typing.emit(typing)));
      }
    }
    this.#updateStatus();
  }

  /** `online` when any transport is. */
  get status$(): ReadonlyValueStream<TransportStatus> {
    return this.#status;
  }

  /** The kinds that can carry packets now. */
  get online(): TransportKind[] {
    return this.#transports.filter((t) => t.status$.value === 'online').map((t) => t.kind);
  }

  /** Sends over the first online transport; `OFFLINE` when there is none. */
  send(packet: TransportPacket): Promise<SendResult> {
    const transport = this.#transports.find((t) => t.status$.value === 'online');
    return transport ? transport.send(packet) : Promise.resolve(OFFLINE);
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

  dispose(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
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
