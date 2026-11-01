// What a bubble says about a file over the nearby mesh (ADR 0027; REQ §11.6).
import { describe, expect, it } from 'vitest';

import type { AttachmentRow } from './repo';
import { transferStatus } from './status';

const row = (overrides: Partial<AttachmentRow> = {}): AttachmentRow => ({
  attachmentId: 'a',
  messageId: 'm',
  conversationId: 'c',
  role: 'file',
  direction: 'down',
  state: 'transferring',
  ciphertextSize: 10 * 1_048_576,
  transferred: 0,
  localPath: null,
  error: null,
  recipients: null,
  createdAt: 0,
  updatedAt: 0,
  via: 'mesh',
  ...overrides,
});

describe('transferStatus over the mesh', () => {
  it('counts chunks received, with pause and cancel', () => {
    const status = transferStatus(row(), undefined, 10 * 1_048_576, { held: 12, count: 161 });
    expect(status.text).toBe('Over Bluetooth: 12 / 161 chunks received');
    expect(status.progress).toBeCloseTo(12 / 161);
    expect(status.actions).toEqual(['pause', 'cancel']);
    expect(transferStatus(row(), undefined, 1_000).text).toMatch(/^Coming over Bluetooth/);
  });

  it('tells the sender queued, forwarded or received, with a BLE time estimate', () => {
    const up = row({ direction: 'up' });
    expect(transferStatus(up, undefined, 1, { count: 0 }).text).toMatch(
      /^Waiting for a nearby route · about 2–4 min over Bluetooth$/,
    );
    expect(transferStatus(up, undefined, 1, { count: 161, delivered: 0, relays: 2 }).text).toBe(
      'Forwarded by 2 devices — not yet delivered',
    );
    expect(transferStatus(up, undefined, 1, { count: 161, delivered: 40 }).text).toBe(
      'Over Bluetooth: 40 / 161 chunks received by the recipient',
    );
    expect(
      transferStatus(row({ state: 'paused' }), undefined, 1, { count: 10, held: 3 }).text,
    ).toBe('Paused at 3 / 10 chunks');
    expect(transferStatus(row({ state: 'done' }), undefined, 1).available).toBe(true);
  });
});
