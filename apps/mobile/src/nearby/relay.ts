// Relaying for others on this phone (Phase 23, ADR 0025; REQ §11.4, §11.5). Off by default:
// the user opts in on Settings → Nearby relay, which explains what relays see and cost first.
// Even when on, relaying pauses while the battery is low, a battery saver is on, the phone is
// not charging (if the user asked for that) or storage is low. Every threshold is a setting.
import { z } from 'zod';

import type { PowerState } from '../../modules/nearby/src';

export const RelayPrefsSchema = z.object({
  enabled: z.boolean(),
  /** Relay only while charging (the "restricted battery" mode). */
  onlyWhileCharging: z.boolean(),
  /** Pause below this battery level, percent. */
  minBatteryPercent: z.number().int().min(0).max(100),
  /** Pause while Android's battery saver is on. */
  pauseOnSaver: z.boolean(),
  /** Pause when less free storage than this is left, MB. */
  minFreeStorageMb: z.number().int().min(0),
  /** After the phone restarts, a notification offers to turn nearby back on. */
  remindAfterRestart: z.boolean(),
});
export type RelayPrefs = z.infer<typeof RelayPrefsSchema>;

export const DEFAULT_RELAY_PREFS: RelayPrefs = {
  enabled: false,
  onlyWhileCharging: false,
  minBatteryPercent: 20,
  pauseOnSaver: true,
  minFreeStorageMb: 1024,
  remindAfterRestart: false,
};

export type RelayPause =
  'off' | 'nearby_off' | 'battery_low' | 'saver' | 'not_charging' | 'storage_low';

export type RelayDecision = { relaying: true } | { relaying: false; reason: RelayPause };

export interface RelayInputs {
  prefs: RelayPrefs;
  /** Nearby messaging is running (relaying rides on its links). */
  nearbyRunning: boolean;
  power: PowerState | null;
  /** Free bytes on the data partition, if known. */
  freeBytes: number | null;
}

/** Whether to relay now (REQ §11.4: never when disabled, low on storage or restricted). */
export function relayDecision({
  prefs,
  nearbyRunning,
  power,
  freeBytes,
}: RelayInputs): RelayDecision {
  if (!prefs.enabled) return { relaying: false, reason: 'off' };
  if (!nearbyRunning) return { relaying: false, reason: 'nearby_off' };
  if (power) {
    if (prefs.pauseOnSaver && power.powerSave) return { relaying: false, reason: 'saver' };
    if (prefs.onlyWhileCharging && !power.charging) {
      return { relaying: false, reason: 'not_charging' };
    }
    if (
      !power.charging &&
      power.batteryPercent >= 0 &&
      power.batteryPercent < prefs.minBatteryPercent
    ) {
      return { relaying: false, reason: 'battery_low' };
    }
  }
  if (freeBytes !== null && freeBytes < prefs.minFreeStorageMb * 1_048_576) {
    return { relaying: false, reason: 'storage_low' };
  }
  return { relaying: true };
}

export interface RelayText {
  title: string;
  detail: string;
  tone: 'muted' | 'warning';
}

/** What Settings says about relaying now. */
export function describeRelay(
  decision: RelayDecision,
  prefs: RelayPrefs,
  held: { packets: number; bytes: number },
): RelayText {
  const holding =
    held.packets === 0
      ? 'It holds no messages for others now.'
      : `It holds ${held.packets} encrypted ${held.packets === 1 ? 'message' : 'messages'} for others (${formatMb(held.bytes)}).`;
  if (decision.relaying) {
    return {
      title: 'Relaying',
      detail: `This phone passes on encrypted messages for others nearby. ${holding}`,
      tone: 'muted',
    };
  }
  switch (decision.reason) {
    case 'off':
      return {
        title: 'Off',
        detail: 'This phone does not carry messages for others.',
        tone: 'muted',
      };
    case 'nearby_off':
      return {
        title: 'Paused — nearby messaging is off',
        detail: 'Relaying uses nearby messaging. Turn it on first.',
        tone: 'warning',
      };
    case 'battery_low':
      return {
        title: 'Paused — battery low',
        detail: `Relaying pauses below ${prefs.minBatteryPercent}% unless the phone is charging. ${holding}`,
        tone: 'warning',
      };
    case 'saver':
      return {
        title: 'Paused — battery saver is on',
        detail: `Relaying pauses while the battery saver is on. ${holding}`,
        tone: 'warning',
      };
    case 'not_charging':
      return {
        title: 'Paused — not charging',
        detail: `You chose to relay only while charging. ${holding}`,
        tone: 'warning',
      };
    case 'storage_low':
      return {
        title: 'Paused — storage low',
        detail: `Relaying pauses when less than ${formatMb(prefs.minFreeStorageMb * 1_048_576)} is free. ${holding}`,
        tone: 'warning',
      };
  }
}

function formatMb(bytes: number): string {
  const mb = bytes / 1_048_576;
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}
