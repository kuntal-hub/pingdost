import { describe, expect, it } from 'vitest';

import { messageRecord } from '@pingdost/message-engine/testing';
import { MessageStateSchema } from '@pingdost/shared-types';

import { previewText, shownState, stateLabel, systemText } from './labels';
import { buildTimeline, dayLabel } from './timeline';

describe('attachment labels', () => {
  const attachment = (mimeType: string, fileName: string | null) =>
    messageRecord({
      kind: 'attachment',
      body: '',
      attachment: {
        attachmentId: 'a',
        key: '',
        noncePrefix: '',
        plaintextSize: 1,
        chunkCount: 1,
        ciphertextSize: 17,
        mimeType,
        fileName,
        ciphertextSha256: '',
        chunkHashListSha256: '',
        thumbnail: null,
      },
    });

  it('previews a caption, else the type or the file name', () => {
    expect(previewText(attachment('video/mp4', 'clip.mp4'))).toBe('🎥 Video');
    expect(previewText({ ...attachment('image/png', null), body: ' a\n view ' })).toBe('📷 a view');
    expect(previewText(attachment('application/zip', 'notes.zip'))).toBe('📄 notes.zip');
    expect(previewText(attachment('application/zip', null))).toBe('📄 File');
  });
});

describe('stateLabel', () => {
  it('never calls a server or relay hop delivered', () => {
    for (const state of MessageStateSchema.options) {
      const label = stateLabel(state, true);
      const delivered = /deliver/i.test(label.short) && !/before delivery/i.test(label.short);
      expect(delivered, state).toBe(state === 'delivered_to_recipient_device');
    }
    expect(stateLabel('sent_to_server', true).long).toContain('not yet delivered');
    expect(stateLabel('relayed', true).long).toContain('not yet delivered');
  });

  it('uses the REQ §11.6 wording', () => {
    expect(stateLabel('expired_undelivered', true).short).toBe('Expired before delivery');
    expect(stateLabel('waiting_for_nearby_route', false).long).toBe(
      'Queued on this device — waiting for a nearby route.',
    );
    expect(stateLabel('local_queued', false).long).toContain('waiting for a connection');
  });

  it('hides read receipts while this user has them off', () => {
    expect(shownState('read', false)).toBe('delivered_to_recipient_device');
    expect(shownState('read', true)).toBe('read');
    expect(shownState('sent_to_server', false)).toBe('sent_to_server');
  });
});

describe('systemText', () => {
  const names = {
    name: (id: string) => ({ a: 'Asha', b: 'Bilal', c: 'Chen' })[id] ?? 'PingDost user',
    selfUserId: 'me',
  };
  const notice = (body: object, senderUserId = 'a') =>
    messageRecord({ kind: 'system', senderUserId, body: `group:${JSON.stringify(body)}` });

  it('words group events with names, and "you" for this user', () => {
    expect(systemText(notice({ type: 'created', by: 'a' }), names)).toBe('Asha created the group');
    expect(systemText(notice({ type: 'added', by: 'me', users: ['b', 'c'] }), names)).toBe(
      'You added Bilal and Chen',
    );
    expect(systemText(notice({ type: 'removed', by: 'a', users: ['me'] }), names)).toBe(
      'Asha removed you',
    );
    expect(systemText(notice({ type: 'left', users: ['c'] }), names)).toBe('Chen left');
    expect(systemText(notice({ type: 'role', by: 'a', users: ['b'], role: 'admin' }), names)).toBe(
      'Asha made Bilal an admin',
    );
    expect(systemText(notice({ type: 'joined', by: 'a' }), names)).toBe('Asha added you');
  });

  it('names whose safety number changed', () => {
    const changed = messageRecord({
      kind: 'system',
      senderUserId: 'b',
      body: 'safety_number_changed',
    });
    expect(systemText(changed, names)).toBe('Safety number changed for Bilal');
    expect(previewText(changed)).toBe('Safety number changed');
  });
});

describe('buildTimeline', () => {
  it('sorts, dedupes and separates days', () => {
    const now = new Date(2026, 9, 19, 12).getTime();
    const yesterday = now - 86_400_000;
    const a = messageRecord({ sortAt: yesterday });
    const b = messageRecord({ sortAt: now - 60_000 });
    const c = messageRecord({ sortAt: now });
    const items = buildTimeline([c, a, b, c], now);
    expect(items.map((i) => (i.type === 'day' ? i.label : i.message.messageId))).toEqual([
      'Yesterday',
      a.messageId,
      'Today',
      b.messageId,
      c.messageId,
    ]);
    expect(dayLabel(new Date(2025, 0, 2).getTime(), now)).toMatch(/2025/);
  });
});
