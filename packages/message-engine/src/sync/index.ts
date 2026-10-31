/**
 * History sync between this user's own devices (ADR 0021): the phone serves its history
 * (`SyncSource`), a linked browser asks for it (`SyncSink`), over E2EE ephemeral packets the
 * server relays in memory only (`OwnDeviceChannel`). Every device runs both sides; which one
 * acts depends on the request: only a linked browser asks, and only the phone answers.
 */
import type { TransportPacket } from '@pingdost/protocol';

import type { EngineCore } from '../core';
import type { RemoteDevice } from '../sessions';
import { OwnDeviceChannel } from './channel';
import { SyncSink } from './sink';
import { SyncSource, type SyncFiles, type SyncWindow } from './source';

export interface HistorySyncOptions {
  /** A linked browser: start the recent-window sync by itself after pairing. */
  autoStart?: boolean;
  /** The recent window to ask for; default `DEFAULT_SYNC_WINDOW`. */
  window?: SyncWindow;
  /** The phone: attachment ciphertext it keeps, for a browser that asks for a file. */
  files?: SyncFiles;
  /** Delays between tries while the phone is offline (tests shorten them). */
  retryMs?: readonly number[];
}

export class HistorySync {
  readonly channel: OwnDeviceChannel;
  readonly source: SyncSource;
  readonly sink: SyncSink;

  constructor(
    core: EngineCore,
    options: HistorySyncOptions,
    hooks: {
      undecryptable: (sender: RemoteDevice, sessionId?: string) => Promise<void>;
      groupsArrived: (groupIds: string[]) => void;
    },
  ) {
    this.channel = new OwnDeviceChannel(core, hooks.undecryptable);
    this.source = new SyncSource(core, this.channel, options.files);
    this.sink = new SyncSink(core, this.channel, {
      autoStart: options.autoStart ?? false,
      ...(options.window ? { window: options.window } : {}),
      ...(options.retryMs ? { retryMs: options.retryMs } : {}),
      groupsArrived: hooks.groupsArrived,
    });
  }

  /** An EPHEMERAL packet from the transport. */
  receive(packet: TransportPacket): void {
    this.channel.receive(packet, async (received) => {
      const body = received.content.body;
      if (body.case !== 'syncChunk') return; // call signaling arrives in Phase 25
      switch (body.value.op.case) {
        case 'request':
        case 'ack':
        case 'fileRequest':
          await this.source.handle(received);
          break;
        case 'stop':
          // Either side may stop: the phone forgets its cursor, the browser its sync.
          await this.source.handle(received);
          await this.sink.handle(received);
          break;
        default:
          await this.sink.handle(received);
      }
    });
  }

  async idle(): Promise<void> {
    await this.channel.idle();
    await this.sink.idle();
  }
}

export { DEFAULT_SYNC_WINDOW, FILE_PART_BYTES } from './source';
export type { SyncFiles, SyncSendProgress, SyncWindow } from './source';
export type { HistorySyncState, HistorySyncStatus } from './sink';
