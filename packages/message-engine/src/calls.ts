/**
 * Call signaling and the local call history (ADR 0028). Signals are `CallSignal` Contents over
 * the ephemeral channel: Olm between the two call devices, relayed in memory by the server and
 * never stored there. An invite carries the RING flag, so an offline callee device gets a
 * content-free `call` push and picks up the caller's next copy of it.
 *
 * - Only direct contacts (not this user's own devices, not blocked users, and from Phase 37
 *   only people in the circle) are accepted.
 * - Every signal names the caller's and the callee's device; one whose pair is not the
 *   envelope's sender and this device is dropped, so it cannot be replayed into another call.
 * - The call history is a sealed engine setting on this device only (no server record).
 */
import {
  callSignalFromProto,
  callSignalToProto,
  PacketFlag,
  type CallOutcome,
  type CallSignalData,
  type IncomingCallSignal,
} from '@pingdost/protocol';
import { Listeners, type SendResult } from '@pingdost/transport';

import type { EngineCore } from './core';
import type { EphemeralChannel, EphemeralContent } from './sync/channel';

export interface CallHistoryEntry {
  callId: string;
  peerUserId: string;
  direction: 'in' | 'out';
  video: boolean;
  /** When the call started ringing (epoch ms). */
  startedAt: number;
  /** Connected for this long; 0 when it never connected. */
  durationMs: number;
  outcome: CallOutcome;
}

const HISTORY_KEY = 'calls.history';
/** Entries kept; older ones are dropped. */
export const CALL_HISTORY_MAX = 200;

export class CallSignals {
  readonly #listeners = new Listeners<[IncomingCallSignal]>();

  constructor(
    private readonly core: EngineCore,
    private readonly channel: EphemeralChannel,
  ) {}

  /** The devices a call to `userId` rings: freshly verified, else as last cached. */
  async devices(userId: string): Promise<string[]> {
    const { core } = this;
    if (userId === core.self.userId) return [];
    const lookup = await core.refreshDirectory(userId);
    const record = lookup.status === 'ok' ? lookup.record : await core.store.getDirectory(userId);
    return (record?.devices ?? []).map((d) => d.deviceId);
  }

  /** Encrypts one signal for one device of the contact `userId` and relays it. Never throws. */
  async send(userId: string, deviceId: string, signal: CallSignalData): Promise<SendResult> {
    const { core } = this;
    if (userId === core.self.userId || core.isBlocked(userId) || core.outsideCircle(userId)) {
      return { ok: false, code: 'NOT_ALLOWED', retryable: false };
    }
    const self = core.self.deviceId;
    const bound =
      (signal.callerDeviceId === self && signal.calleeDeviceId === deviceId) ||
      (signal.calleeDeviceId === self && signal.callerDeviceId === deviceId);
    if (!bound) return { ok: false, code: 'INVALID', retryable: false };
    const lookup = await core.directoryFor(userId, core.settings.directoryMaxAgeMs);
    const device =
      lookup.status === 'ok'
        ? lookup.record.devices.find((d) => d.deviceId === deviceId)
        : undefined;
    if (!device) return { ok: false, code: 'UNKNOWN_DEVICE', retryable: false };
    const flags = signal.type === 'offer' ? PacketFlag.RING : 0;
    return this.channel.sendTo(
      userId,
      device,
      { case: 'callSignal', value: callSignalToProto(signal) },
      flags,
    );
  }

  on(listener: (signal: IncomingCallSignal) => void): () => void {
    return this.#listeners.add(listener);
  }

  /** Ephemeral content that is not history sync. */
  handle({ content, sender }: EphemeralContent): Promise<void> {
    const { core } = this;
    const body = content.body;
    if (body.case !== 'callSignal') return Promise.resolve();
    if (sender.userId === core.self.userId) return Promise.resolve(); // no calls between own devices
    const signal = callSignalFromProto(body.value);
    if (!signal) return Promise.resolve();
    const self = core.self.deviceId;
    const from = sender.deviceId;
    const bound =
      (signal.callerDeviceId === from && signal.calleeDeviceId === self) ||
      (signal.calleeDeviceId === from && signal.callerDeviceId === self);
    if (!bound) {
      core.log('warn', 'call signal for other devices dropped');
      return Promise.resolve();
    }
    this.#listeners.emit({ fromUserId: sender.userId, fromDeviceId: from, signal });
    return Promise.resolve();
  }

  /** Newest first. */
  async history(): Promise<CallHistoryEntry[]> {
    const value = await this.core.store.getSetting(HISTORY_KEY);
    return Array.isArray(value) ? (value as CallHistoryEntry[]) : [];
  }

  /** Adds (or replaces, by call ID) one entry. */
  async record(entry: CallHistoryEntry): Promise<void> {
    const { core } = this;
    await core.mutex.run(async () => {
      const kept = (await this.history()).filter((e) => e.callId !== entry.callId);
      const next = [entry, ...kept]
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, CALL_HISTORY_MAX);
      await core.store.apply({ settings: { [HISTORY_KEY]: next } });
    });
  }

  async clearHistory(): Promise<void> {
    await this.core.mutex.run(() => this.core.store.apply({ settings: { [HISTORY_KEY]: null } }));
  }
}
