// The attachment rules, bubble status and the `attachments` table (migration 006) on Node's
// SQLite; the file IO and encoders are checked on the device.
import { describe, expect, it } from 'vitest';

import { migratedDatabase } from '@/db/testing';
import { SqliteEngineStore } from '@/engine/sqlite-store';
import { messageRecord } from '@pingdost/message-engine/testing';

import { AttachmentRepo, type AttachmentRow } from './repo';
import {
  autoFetch,
  durationLabel,
  planDraft,
  transferErrorFor,
  transferErrorText,
  waveformFrom,
} from './rules';
import { transferStatus } from './status';

const MB = 1_048_576;

describe('automatic downloads', () => {
  it('always fetches previews, and full files by the setting and network', () => {
    expect(autoFetch('thumbnail', 'never', 'cellular')).toBe(true);
    expect(autoFetch('thumbnail', 'always', 'offline')).toBe(false);
    expect(autoFetch('file', 'wifi', 'wifi')).toBe(true);
    expect(autoFetch('file', 'wifi', 'cellular')).toBe(false);
    expect(autoFetch('file', 'always', 'cellular')).toBe(true);
    expect(autoFetch('file', 'never', 'wifi')).toBe(false);
  });
});

describe('planDraft (REQ §10.1)', () => {
  it('compresses photos by default and offers the original when it fits', () => {
    expect(planDraft({ category: 'image', mimeType: 'image/jpeg', size: 4 * MB })).toEqual({
      compressible: true,
      compressByDefault: true,
      originalAllowed: true,
    });
    // An animation would lose its frames: sent as it is unless the user chooses otherwise.
    expect(planDraft({ category: 'image', mimeType: 'image/gif', size: MB })).toMatchObject({
      compressByDefault: false,
      originalAllowed: true,
    });
    expect(planDraft({ category: 'image', mimeType: 'image/png', size: 150 * MB })).toMatchObject({
      compressByDefault: true,
      originalAllowed: false,
    });
  });

  it('plans a video under the limit, and explains one that cannot fit', () => {
    const big = planDraft({
      category: 'video',
      mimeType: 'video/mp4',
      size: 400 * MB,
      durationMs: 5 * 60_000,
      width: 1_920,
      height: 1_080,
    });
    expect(big).toMatchObject({
      compressible: true,
      compressByDefault: true,
      originalAllowed: false,
    });
    expect(big.video!.estimatedBytes).toBeLessThan(100 * MB);

    const endless = planDraft({
      category: 'video',
      mimeType: 'video/mp4',
      size: 3_000 * MB,
      durationMs: 4 * 3_600_000,
    });
    expect(endless.rejected).toMatch(/too long to fit in 100\.0 MB/);

    // Already small: compressing would only lose quality.
    const small = planDraft({
      category: 'video',
      mimeType: 'video/mp4',
      size: 3 * MB,
      durationMs: 60_000,
      width: 640,
      height: 360,
    });
    expect(small).toMatchObject({ compressible: false, originalAllowed: true });
  });

  it('sends videos as they are where the platform has no encoder (iOS for now)', () => {
    const facts = { category: 'video', mimeType: 'video/mp4', durationMs: 60_000 } as const;
    expect(planDraft({ ...facts, size: 40 * MB }, undefined, { videoCompression: false })).toEqual({
      compressible: false,
      compressByDefault: false,
      originalAllowed: true,
    });
    const big = planDraft({ ...facts, size: 400 * MB }, undefined, { videoCompression: false });
    expect(big.rejected).toMatch(/can't be made smaller on this device yet/);
    expect(big.video).toBeUndefined();
  });

  it('rejects documents over the limit and empty files, and never compresses documents', () => {
    expect(
      planDraft({ category: 'document', mimeType: 'application/pdf', size: 101 * MB }),
    ).toMatchObject({
      rejected: expect.stringMatching(/101\.0 MB\. Files over 100\.0 MB can't be sent/) as string,
    });
    expect(planDraft({ category: 'document', mimeType: 'text/plain', size: 0 }).rejected).toBe(
      'This file is empty.',
    );
    expect(planDraft({ category: 'audio', mimeType: 'audio/mp4', size: MB })).toEqual({
      compressible: false,
      compressByDefault: false,
      originalAllowed: true,
    });
  });
});

describe('wording', () => {
  it('turns server codes into transfer errors and readable lines', () => {
    expect(transferErrorFor('ATTACHMENT_STAGING_FULL')).toBe('staging_full');
    expect(transferErrorFor('ATTACHMENT_QUOTA_EXCEEDED')).toBe('quota');
    expect(transferErrorFor('UNAVAILABLE')).toBe('network');
    expect(transferErrorFor('SOMETHING_ELSE')).toBe('error');
    expect(transferErrorText('staging_full', 'up')).toMatch(/no room/);
    expect(transferErrorText('integrity', 'down')).toMatch(/didn't arrive intact/);
  });

  it('makes a waveform from metering levels and labels durations', () => {
    const wave = waveformFrom(Array.from({ length: 300 }, (_, i) => (i % 2 ? -50 : 0)));
    expect(wave).toHaveLength(64);
    expect(Math.max(...wave)).toBe(255);
    expect(waveformFrom([-160, -25, 3])).toEqual(Uint8Array.of(0, 128, 255));
    expect(waveformFrom([])).toHaveLength(0);
    expect(durationLabel(42_400)).toBe('0:42');
    expect(durationLabel(725_000)).toBe('12:05');
  });
});

function row(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    attachmentId: crypto.randomUUID(),
    messageId: crypto.randomUUID(),
    conversationId: 'c1',
    role: 'file',
    direction: 'down',
    state: 'pending',
    ciphertextSize: 2_000,
    transferred: 0,
    localPath: null,
    error: null,
    recipients: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('transferStatus', () => {
  it('says what a file is doing and offers the matching controls', () => {
    expect(transferStatus(undefined, undefined, 1_000)).toMatchObject({
      available: false,
      text: '',
    });
    expect(transferStatus(row({ state: 'pending' }), undefined, 3 * MB)).toEqual({
      available: false,
      progress: undefined,
      text: 'Tap to download · 3.0 MB',
      actions: ['download'],
    });
    expect(transferStatus(row({ state: 'transferring' }), 500, MB)).toMatchObject({
      progress: 0.25,
      text: 'Downloading 25% of 1.0 MB',
      actions: ['pause', 'cancel'],
    });
    // A file being sent is on this phone already.
    expect(
      transferStatus(row({ state: 'paused', direction: 'up', transferred: 1_000 }), undefined, MB),
    ).toMatchObject({
      available: true,
      text: 'Paused at 50%',
      actions: ['resume', 'cancel'],
    });
    expect(transferStatus(row({ state: 'failed', error: 'network' }), undefined, MB)).toMatchObject(
      {
        text: 'Waiting for a connection',
        actions: ['cancel'],
      },
    );
    expect(transferStatus(row({ state: 'gone' }), undefined, MB).text).toMatch(
      /No longer available/,
    );
    expect(transferStatus(row({ state: 'done' }), undefined, MB)).toMatchObject({
      available: true,
      text: '',
    });
  });
});

describe('AttachmentRepo (migration 006)', () => {
  it('keeps transfer rows, finds orphans, and sums usage per chat', async () => {
    const db = await migratedDatabase();
    const store = new SqliteEngineStore(db);
    const repo = new AttachmentRepo(
      db,
      (work) => store.exclusive(work),
      () => 5,
    );
    const info = {
      attachmentId: 'f1',
      key: 'a2V5',
      noncePrefix: 'bm9uY2U=',
      plaintextSize: 1_000,
      chunkCount: 1,
      ciphertextSize: 1_016,
      mimeType: 'image/jpeg',
      fileName: null,
      ciphertextSha256: 'aA==',
      chunkHashListSha256: 'bA==',
      thumbnail: null,
    };
    const photo = messageRecord({
      conversationId: 'c1',
      kind: 'attachment',
      body: 'Sunset',
      attachment: info,
    });
    const gone = messageRecord({
      conversationId: 'c1',
      kind: 'attachment',
      body: '',
      attachment: info,
    });
    await store.apply({ messages: [photo, gone] });

    const file = row({
      messageId: photo.messageId,
      attachmentId: 'f1',
      state: 'done',
      localPath: 'f1',
    });
    const thumb = row({
      messageId: photo.messageId,
      attachmentId: 't1',
      role: 'thumbnail',
      state: 'done',
      localPath: 't1',
      ciphertextSize: 300,
    });
    const other = row({ messageId: gone.messageId, attachmentId: 'f2', state: 'transferring' });
    await repo.insert([file, thumb, other]);
    // A second insert keeps the existing row's state.
    await repo.insert([{ ...file, state: 'pending' }]);
    expect((await repo.get('f1'))?.state).toBe('done');
    expect((await repo.forMessage(photo.messageId)).map((r) => r.role)).toEqual([
      'thumbnail',
      'file',
    ]);

    await repo.update('f2', { state: 'failed', error: 'network', recipients: ['d1', 'd2'] });
    expect(await repo.get('f2')).toMatchObject({
      state: 'failed',
      error: 'network',
      recipients: ['d1', 'd2'],
      updatedAt: 5,
    });
    expect((await repo.withError('network')).map((r) => r.attachmentId)).toEqual(['f2']);
    expect((await repo.inStates(['done'])).map((r) => r.attachmentId)).toEqual(['t1', 'f1']);
    expect(await repo.localPaths()).toEqual(new Set(['f1', 't1']));
    expect(await repo.usageByConversation()).toEqual([
      { conversationId: 'c1', files: 1, fileBytes: 2_000, thumbnailBytes: 300 },
    ]);
    expect((await repo.mediaIn('c1')).map((m) => m.attachmentId)).toEqual(['f1']);

    // Deleted for everyone (no manifest) and deleted for me: both rows become orphans.
    expect(await repo.orphans()).toEqual([]);
    await store.apply({ messages: [{ ...gone, kind: 'deleted', body: '', attachment: null }] });
    expect((await repo.orphans()).map((r) => r.attachmentId)).toEqual(['f2']);
    await store.apply({ deleteMessages: [photo.messageId] });
    expect((await repo.orphans()).map((r) => r.attachmentId).sort()).toEqual(['f1', 'f2', 't1']);
    await repo.delete(['f1', 'f2', 't1']);
    expect(await repo.orphans()).toEqual([]);
  });

  it('indexes captions for search (migration 006)', async () => {
    const db = await migratedDatabase();
    const store = new SqliteEngineStore(db);
    const photo = messageRecord({ kind: 'attachment', body: 'Beach sunset' });
    await store.apply({ messages: [photo] });
    expect((await store.searchMessages('sunset', { limit: 5 })).map((m) => m.messageId)).toEqual([
      photo.messageId,
    ]);
  });
});
