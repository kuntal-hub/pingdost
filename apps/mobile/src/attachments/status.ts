// What an attachment bubble says and offers, from its transfer rows (ADR 0018). Pure, so the
// wording and the offered actions are unit-tested.
import { formatSize } from '@pingdost/attachments';

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

export function transferStatus(
  row: AttachmentRow | undefined,
  live: number | undefined,
  plaintextSize: number,
): TransferStatus {
  const size = formatSize(plaintextSize);
  if (!row) return { available: false, progress: undefined, text: '', actions: [] };
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
