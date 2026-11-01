/**
 * The transport-neutral interface (REQ §4.3, ARCHITECTURE A4): the message engine hands
 * encrypted `TransportPacket`s to a transport and gets packets back, without knowing whether
 * they travel over the Internet WebSocket or, from Phase 22, a nearby link.
 */
import type { TransportPacket } from '@pingdost/protocol';

import type { ReadonlyValueStream } from './stream';

export type TransportKind = 'internet' | 'nearby';

/** The path that carried a packet to its next hop: a mesh relay is a path of nearby. */
export type TransportPath = TransportKind | 'mesh';

/** `online` means the transport can carry packets now (for the WebSocket: after `AuthOk`). */
export type TransportStatus = 'offline' | 'connecting' | 'online';

export type Unsubscribe = () => void;

/** Codes a transport reports on its own, besides the server's `ErrorCode`s. */
export type TransportErrorCode =
  /** No usable connection: the packet was not sent. */
  | 'OFFLINE'
  /** Sent, but no answer in time; the packet may or may not have arrived. */
  | 'TIMEOUT'
  /**
   * A transport is up, but none reaches this device now (the Internet is down and the device
   * is not in nearby range): the packet waits for a nearby route (REQ §8.3). Not sent.
   */
  | 'NO_ROUTE';

/**
 * The outcome of one `send`. `ok` means the next hop holds the packet: the server's
 * `Accepted`, or the recipient device's own nearby ACK. Never delivery to the recipient's
 * user, which only an E2EE receipt shows (REQ §8.3).
 *
 * `held` (ADR 0025): the mesh relay on this device took it and will hand it to relays as they
 * come into range. Nothing left the phone yet, so the sender keeps its copy too; relays that
 * accept it are reported through `onRelayed`.
 */
export type SendResult =
  | {
      ok: true;
      status: 'stored' | 'delivered_transport' | 'held';
      /** The path that carried it (the router sets it when the transport did not). */
      via?: TransportPath;
    }
  | {
      ok: false;
      /** A transport code or a server `ErrorCode`. */
      code: string;
      /** Whether the same packet may succeed later. */
      retryable: boolean;
    };

/**
 * Receives one packet. Call `ack` only once the packet is stored locally: the next hop then
 * deletes its copy (ARCHITECTURE A3).
 */
export type PacketListener = (packet: TransportPacket, ack: () => void) => void;

/** A typing indicator (transient; never stored anywhere). */
export interface TypingSignal {
  /** Outgoing: the devices to tell. Incoming: empty. */
  recipientDeviceIds: string[];
  /** Incoming: the typing device. Outgoing: empty. */
  senderDeviceId: string;
  groupId?: string;
  active: boolean;
}

export interface Transport {
  readonly kind: TransportKind;
  readonly status$: ReadonlyValueStream<TransportStatus>;
  /** Sends one `PACKET_KIND_ENVELOPE` packet. Never throws. */
  send(packet: TransportPacket): Promise<SendResult>;
  onPacket(listener: PacketListener): Unsubscribe;
  /** Best effort: false when it could not be sent. */
  sendTyping?(typing: TypingSignal): boolean;
  onTyping?(listener: (typing: TypingSignal) => void): Unsubscribe;
  /**
   * Sends one `PACKET_KIND_EPHEMERAL` packet (history sync, later call signaling): relayed in
   * memory to the recipient device only while it is online, never stored on the way
   * (ARCHITECTURE A4). `ok` means it was handed to the recipient's socket; an offline
   * recipient is `RECIPIENT_OFFLINE`. Never throws.
   */
  sendEphemeral?(packet: TransportPacket): Promise<SendResult>;
  /** Ephemeral packets for this device. There is nothing to acknowledge. */
  onEphemeral?(listener: (packet: TransportPacket) => void): Unsubscribe;
  /**
   * A transport that reaches only some devices (nearby): whether it reaches this one now.
   * Without it, an online transport reaches every device (the server).
   */
  reaches?(deviceId: string): boolean;
  /** Fires when `reaches` may answer differently. */
  onReachability?(listener: () => void): Unsubscribe;
  /**
   * The mesh (ADR 0025): whether this transport can take a packet for a device out of range
   * and hold it for relays. `send` then answers `held`.
   */
  carries?(deviceId: string): boolean;
  /** The sender is done with these envelopes (a receipt, or sent another way): drop copies. */
  withdraw?(envelopeIds: readonly string[]): void;
  /** Relays accepted an envelope this transport holds. */
  onRelayed?(listener: (event: RelayedEvent) => void): Unsubscribe;
}

/** `relays` distinct devices accepted this envelope from this device (REQ §11.6). */
export interface RelayedEvent {
  envelopeId: string;
  relays: number;
}

/**
 * How a packet to one device would go now: over a transport, into the mesh (held for relays),
 * nowhere although a transport is up (`unreachable`: it waits for a nearby route), or nowhere
 * because nothing is up.
 */
export type Route = TransportKind | 'mesh' | 'unreachable' | 'offline';
