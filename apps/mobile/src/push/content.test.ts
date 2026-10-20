import { describe, expect, it } from 'vitest';

import { MUTED_FOREVER } from '@pingdost/message-engine';

import { DEFAULT_NOTIFICATION_PREFS, notificationContent, shouldNotify } from './content';

const incoming = { direction: 'in', readAt: null, kind: 'text' } as const;
const now = 1_000_000;

describe('shouldNotify', () => {
  it('notifies for unread incoming messages while the app is not on screen', () => {
    expect(
      shouldNotify({ message: incoming, conversation: undefined, appActive: false, now }),
    ).toBe(true);
    expect(shouldNotify({ message: incoming, conversation: undefined, appActive: true, now })).toBe(
      false,
    );
  });

  it('respects mute, and skips own, read, deleted and system messages', () => {
    const muted = (mutedUntil: number | null) =>
      shouldNotify({ message: incoming, conversation: { mutedUntil }, appActive: false, now });
    expect(muted(MUTED_FOREVER)).toBe(false);
    expect(muted(now + 1)).toBe(false);
    expect(muted(now)).toBe(true);
    expect(muted(null)).toBe(true);
    for (const message of [
      { ...incoming, direction: 'out' as const },
      { ...incoming, readAt: now },
      { ...incoming, kind: 'deleted' as const },
      { ...incoming, kind: 'system' as const },
    ]) {
      expect(shouldNotify({ message, conversation: undefined, appActive: false, now })).toBe(false);
    }
  });
});

describe('notificationContent', () => {
  const text = { kind: 'text' as const, body: 'see you\n at  8' };

  it('shows the sender and a one-line preview by default', () => {
    expect(
      notificationContent({
        senderName: 'Asha',
        message: text,
        unreadCount: 1,
        prefs: DEFAULT_NOTIFICATION_PREFS,
      }),
    ).toEqual({ title: 'Asha', body: 'see you at 8' });
    expect(
      notificationContent({
        senderName: 'Asha',
        message: text,
        unreadCount: 3,
        prefs: DEFAULT_NOTIFICATION_PREFS,
      }).body,
    ).toBe('see you at 8 · 3 new messages');
  });

  it('hides the text and the sender when asked', () => {
    const prefs = { showPreviews: false, hideSender: true };
    expect(
      notificationContent({ senderName: 'Asha', message: text, unreadCount: 1, prefs }),
    ).toEqual({ title: 'PingDost', body: 'New message' });
    expect(
      notificationContent({ senderName: 'Asha', message: text, unreadCount: 4, prefs }).body,
    ).toBe('4 new messages');
  });

  it('titles group notifications with the group and names the sender in the text', () => {
    const group = { senderName: 'Asha', groupName: 'Trip', message: text, unreadCount: 1 };
    expect(notificationContent({ ...group, prefs: DEFAULT_NOTIFICATION_PREFS })).toEqual({
      title: 'Trip',
      body: 'Asha: see you at 8',
    });
    expect(
      notificationContent({ ...group, prefs: { showPreviews: true, hideSender: true } }),
    ).toEqual({ title: 'PingDost', body: 'see you at 8' });
  });

  it('truncates long previews by character, and never shows unsupported bodies', () => {
    const long = { kind: 'text' as const, body: 'न'.repeat(300) };
    const { body } = notificationContent({
      senderName: 'A',
      message: long,
      unreadCount: 1,
      prefs: DEFAULT_NOTIFICATION_PREFS,
    });
    expect(Array.from(body)).toHaveLength(200);
    expect(body.endsWith('…')).toBe(true);
    expect(
      notificationContent({
        senderName: 'A',
        message: { kind: 'unsupported', body: '' },
        unreadCount: 1,
        prefs: DEFAULT_NOTIFICATION_PREFS,
      }).body,
    ).toBe('New message (update PingDost to read it)');
  });

  it('names an attachment by its caption or type, never by anything else', () => {
    const photo = {
      kind: 'attachment' as const,
      body: '',
      attachment: messageAttachment('image/jpeg', 'IMG_0042.jpg'),
    };
    const content = (message: typeof photo) =>
      notificationContent({
        senderName: 'A',
        message,
        unreadCount: 1,
        prefs: DEFAULT_NOTIFICATION_PREFS,
      }).body;
    expect(content(photo)).toBe('📷 Photo');
    expect(content({ ...photo, body: 'the view' })).toBe('📷 the view');
    expect(
      content({ ...photo, attachment: messageAttachment('application/pdf', 'plan.pdf') }),
    ).toBe('📄 plan.pdf');
  });
});

function messageAttachment(mimeType: string, fileName: string) {
  return {
    attachmentId: '0192f1a0-0000-7000-8000-000000000001',
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
  };
}
