// What an attachment bubble says and offers, from its transfer rows (ADR 0018). Pure, so the
// wording and the offered actions are unit-tested.
import { formatSize, meshTimeEstimate } from '@pingdost/attachments';

import type { AttachmentRow } from './repo';
import { transferErrorText } from './rules';

export type TransferAction = 'download' | 'pause' | 'resume' | 'cancel' | 'retry';

export interface TransferStatus {
  /** The file can be opened from this phone. */
  available: boolean;
  /** 0–1 while something moves. */
  progress: number | undefined;
  /** One short line under the file; empty when there is nothing to say. */
  text: string;
  actions: TransferAction[];
}

/** Chunk progress of a file over the nearby mesh (ADR 0027). */
export interface MeshProgress {
  /** Incoming: chunks held. */
  held?: number;
  /** Outgoing: chunks the recipient took. */
  delivered?: number;
  /** Outgoing: relays that took chunks. */
  relays?: number;
  count: number;
}

/** "Over Bluetooth: 12 / 200 chunks received" and the like (REQ §11.6, Phase 24). */
function meshStatus(
  row: AttachmentRow,
  plaintextSize: number,
  mesh?: MeshProgress,
): TransferStatus {
  const up = row.direction === 'up';
  const count = mesh?.count ?? 0;
  const done = (up ? mesh?.delivered : mesh?.held) ?? 0;
  const progress = count > 0 ? Math.min(1, done / count) : undefined;
  const estimate = meshTimeEstimate(row.ciphertextSize);
  switch (row.state) {
    case 'transferring': {
      let text: string;
      if (up) {
        text =
          count === 0
            ? `Waiting for a nearby route · ${estimate} over Bluetooth`
            : done > 0
              ? `Over Bluetooth: ${done} / ${count} chunks received by the recipient`
              : mesh?.relays
                ? `Forwarded by ${mesh.relays} ${mesh.relays === 1 ? 'device' : 'devices'} — not yet delivered`
                : `Waiting for a nearby route · ${estimate} over Bluetooth`;
      } else {
        text =
          count === 0
            ? `Coming over Bluetooth · ${formatSize(plaintextSize)} · ${estimate}`
            : `Over Bluetooth: ${done} / ${count} chunks received`;
      }
      return { available: up, progress, text, actions: ['pause', 'cancel'] };
    }
    case 'paused':
      return {
        available: up,
        progress,
        text: count > 0 ? `Paused at ${done} / ${count} chunks` : 'Paused',
        actions: ['resume', 'cancel'],
      };
    case 'failed':
      return {
        available: up,
        progress: undefined,
        text: up ? 'Not sent over Bluetooth.' : 'Not received.',
        actions: ['retry'],
      };
    default:
      return { available: row.state === 'done', progress: undefined, text: '', actions: [] };
  }
}

export function transferStatus(
  row: AttachmentRow | undefined,
  live: number | undefined,
  plaintextSize: number,
  mesh?: MeshProgress,
): TransferStatus {
  const size = formatSize(plaintextSize);
  if (!row) return { available: false, progress: undefined, text: '', actions: [] };
  if (row.via === 'mesh' && row.state !== 'done') return meshStatus(row, plaintextSize, mesh);
  const moved = live ?? row.transferred;
  const fraction = row.ciphertextSize > 0 ? Math.min(1, moved / row.ciphertextSize) : 0;
  const percent = `${Math.floor(fraction * 100)}%`;
  const up = row.direction === 'up';
  switch (row.state) {
    case 'done':
      return { available: true, progress: undefined, text: '', actions: [] };
    case 'transferring':
      return {
        // Sent files are on this phone while they upload.
        available: up,
        progress: fraction,
        text: up ? `Uploading ${percent}` : `Downloading ${percent} of ${size}`,
        actions: up ? ['pause', 'cancel'] : ['pause', 'cancel'],
      };
    case 'paused':
      return {
        available: up,
        progress: fraction,
        text: `Paused at ${percent}`,
        actions: ['resume', 'cancel'],
      };
    case 'failed':
      return {
        available: up,
        progress: undefined,
        text: transferErrorText(row.error, row.direction),
        actions: row.error === 'network' ? ['cancel'] : ['retry', 'cancel'],
      };
    case 'pending':
      return {
        available: false,
        progress: undefined,
        text: `Tap to download · ${size}`,
        actions: ['download'],
      };
    case 'gone':
      return {
        available: false,
        progress: undefined,
        text: 'No longer available. The server keeps files only until they are delivered or expire.',
        actions: [],
      };
    case 'removed':
      return {
        available: false,
        progress: undefined,
        text: 'Deleted from this phone',
        actions: [],
      };
  }
}
