/**
 * The `EngineStore` contract, as a Vitest suite every implementation runs (memory here,
 * SQLite in the Android app, Dexie on the web). Call it at the top level of a test file.
 */
import { describe, expect, it } from 'vitest';

import type {
  ConversationRecord,
  DeliveryRecord,
  DeviceItem,
  DirectoryRecord,
  EngineStore,
  FanoutItem,
  MessageRecord,
  ReceiptItem,
  SessionRecord,
} from '../store';

let counter = 0;
/** Distinct, ordered UUID-shaped IDs. */
export function testId(): string {
  counter++;
  return `0192f1a0-0000-7000-8000-${counter.toString(16).padStart(12, '0')}`;
}

export function conversationRecord(
  overrides: Partial<ConversationRecord> = {},
): ConversationRecord {
  return {
    conversationId: testId(),
    kind: 'direct',
    peerUserId: testId(),
    createdAt: 1_000,
    updatedAt: 1_000,
    lastMessageId: null,
    unreadCount: 0,
    ...overrides,
  };
}

export function messageRecord(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    messageId: testId(),
    conversationId: testId(),
    senderUserId: testId(),
    senderDeviceId: testId(),
    direction: 'out',
    kind: 'text',
    body: 'hello',
    replyTo: null,
    sentAt: 1_000,
    sortAt: 1_000,
    createdAt: 1_000,
    state: 'local_queued',
    expiresAt: 10_000,
    ...overrides,
  };
}

export function runEngineStoreContract(name: string, makeStore: () => Promise<EngineStore>): void {
  describe(`EngineStore contract: ${name}`, () => {
    it('lists conversations by latest activity', async () => {
      const store = await makeStore();
      const old = conversationRecord({ updatedAt: 1 });
      const recent = conversationRecord({ updatedAt: 5, unreadCount: 2, lastMessageId: testId() });
      await store.apply({ conversations: [old, recent] });
      expect(await store.listConversations()).toEqual([recent, old]);
      expect(await store.getConversation(old.conversationId)).toEqual(old);
      expect(await store.getConversation(testId())).toBeUndefined();
      await store.apply({ conversations: [{ ...old, updatedAt: 9 }] });
      expect((await store.listConversations())[0]?.conversationId).toBe(old.conversationId);
    });

    it('pages messages newest first, ties broken by message ID', async () => {
      const store = await makeStore();
      const conversationId = testId();
      const messages = [1, 2, 2, 3, 4].map((sortAt) =>
        messageRecord({ conversationId, sortAt, replyTo: sortAt === 3 ? testId() : null }),
      );
      const other = messageRecord({ sortAt: 9 });
      await store.apply({ messages: [...messages, other] });
      const [m1, m2a, m2b, m3, m4] = messages as [
        MessageRecord,
        MessageRecord,
        MessageRecord,
        MessageRecord,
        MessageRecord,
      ];
      const first = await store.listMessages(conversationId, { limit: 2 });
      expect(first).toEqual([m4, m3]);
      const second = await store.listMessages(conversationId, {
        limit: 2,
        before: { sortAt: m3.sortAt, messageId: m3.messageId },
      });
      expect(second).toEqual([m2b, m2a]);
      const third = await store.listMessages(conversationId, {
        limit: 5,
        before: { sortAt: m2a.sortAt, messageId: m2a.messageId },
      });
      expect(third).toEqual([m1]);
      expect(await store.getMessage(m3.messageId)).toEqual(m3);
    });

    it('finds outgoing messages past their expiry that are not settled', async () => {
      const store = await makeStore();
      const due = messageRecord({ expiresAt: 100, state: 'sent_to_server' });
      const later = messageRecord({ expiresAt: 500 });
      const delivered = messageRecord({ expiresAt: 100, state: 'delivered_to_recipient_device' });
      const incoming = messageRecord({ direction: 'in', state: null, expiresAt: null });
      await store.apply({ messages: [due, later, delivered, incoming] });
      expect((await store.listExpiring(200)).map((m) => m.messageId)).toEqual([due.messageId]);
    });

    it('upserts and deletes deliveries', async () => {
      const store = await makeStore();
      const messageId = testId();
      const row = (
        deviceId: string,
        state: DeliveryRecord['state'],
        own = false,
      ): DeliveryRecord => ({
        messageId,
        deviceId,
        userId: testId(),
        own,
        state,
        updatedAt: 1,
      });
      const a = row(testId(), 'local_queued');
      const b = row(testId(), 'sent_to_server', true);
      await store.apply({ deliveries: [a, b] });
      await store.apply({ deliveries: [{ ...a, state: 'sending', updatedAt: 2 }] });
      const rows = await store.listDeliveries(messageId);
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.deviceId === a.deviceId)?.state).toBe('sending');
      expect(rows.find((r) => r.deviceId === b.deviceId)?.own).toBe(true);
      expect(await store.listDeliveriesTo(b.deviceId, ['sent_to_server'])).toEqual([b]);
      expect(await store.listDeliveriesTo(b.deviceId, ['local_queued'])).toEqual([]);
      await store.apply({ deleteDeliveries: [{ messageId, deviceId: a.deviceId }] });
      expect(await store.listDeliveries(messageId)).toEqual([b]);
    });

    it('keeps every outbox item type, bytes included, oldest first', async () => {
      const store = await makeStore();
      const fanout: FanoutItem = {
        type: 'fanout',
        id: testId(),
        messageId: testId(),
        conversationId: testId(),
        recipientUserIds: [testId(), testId()],
        content: Uint8Array.of(1, 2, 3),
        createdAt: 3,
        expiresAt: 100,
        attempts: 0,
        nextAttemptAt: 3,
      };
      const device: DeviceItem = {
        type: 'device',
        purpose: 'message',
        id: testId(),
        messageId: testId(),
        recipientUserId: testId(),
        recipientDeviceId: testId(),
        content: Uint8Array.of(4, 5),
        packet: null,
        newSession: false,
        createdAt: 1,
        expiresAt: 100,
        attempts: 2,
        nextAttemptAt: 50,
      };
      const receipt: ReceiptItem = {
        type: 'receipt',
        receipt: 'delivered',
        id: `receipt:${testId()}`,
        messageId: testId(),
        recipientUserId: testId(),
        recipientDeviceId: testId(),
        createdAt: 2,
        expiresAt: 100,
        attempts: 0,
        nextAttemptAt: 2,
      };
      await store.apply({ outbox: [fanout, device, receipt] });
      expect(await store.listOutbox()).toEqual([device, receipt, fanout]);
      const sent = { ...device, packet: Uint8Array.of(9, 9, 9), newSession: true };
      await store.apply({ outbox: [sent], deleteOutbox: [receipt.id] });
      expect(await store.getOutboxItem(device.id)).toEqual(sent);
      expect(await store.getOutboxItem(receipt.id)).toBeUndefined();
      expect(await store.listOutbox()).toHaveLength(2);
    });

    it('lists sessions per device', async () => {
      const store = await makeStore();
      const deviceId = testId();
      const session = (id: string): SessionRecord => ({
        sessionId: id,
        deviceId,
        userId: testId(),
        identityKey: 'curve',
        pickle: `pickle-${id}`,
        createdAt: 1,
        lastReceivedAt: 0,
      });
      const a = session('session-a');
      await store.apply({ sessions: [a, session('session-b')] });
      await store.apply({ sessions: [{ ...a, pickle: 'newer', lastReceivedAt: 5 }] });
      const sessions = await store.listSessions(deviceId);
      expect(sessions).toHaveLength(2);
      expect(sessions.find((s) => s.sessionId === 'session-a')).toMatchObject({
        pickle: 'newer',
        lastReceivedAt: 5,
      });
      expect(await store.listSessions(testId())).toEqual([]);
    });

    it('caches directories and finds device owners', async () => {
      const store = await makeStore();
      const deviceId = testId();
      const record: DirectoryRecord = {
        userId: testId(),
        accountIdentityKey: 'identity',
        keyVersion: 3,
        devices: [
          {
            deviceId,
            platform: 'android',
            role: 'primary',
            curve25519: 'curve',
            ed25519: 'ed',
            fallbackKey: { keyId: 'AAAAAQ', publicKey: 'pub', signature: 'sig' },
          },
        ],
        fetchedAt: 10,
        verifiedIdentityKey: null,
      };
      await store.apply({ directory: [record] });
      expect(await store.getDirectory(record.userId)).toEqual(record);
      expect(await store.findDeviceOwner(deviceId)).toBe(record.userId);
      await store.apply({
        directory: [{ ...record, devices: [], verifiedIdentityKey: 'identity' }],
      });
      expect(await store.findDeviceOwner(deviceId)).toBeUndefined();
      expect((await store.getDirectory(record.userId))?.verifiedIdentityKey).toBe('identity');
    });

    it('remembers seen IDs until pruned', async () => {
      const store = await makeStore();
      const old = testId();
      const recent = testId();
      await store.apply({
        seen: [
          { id: old, seenAt: 1 },
          { id: recent, seenAt: 10 },
        ],
      });
      expect(await store.hasSeen(old)).toBe(true);
      await store.apply({ pruneSeenBefore: 5 });
      expect(await store.hasSeen(old)).toBe(false);
      expect(await store.hasSeen(recent)).toBe(true);
    });

    it('stores JSON settings; null deletes', async () => {
      const store = await makeStore();
      await store.apply({ settings: { a: 5, b: { nested: true } } });
      expect(await store.getSetting('a')).toBe(5);
      expect(await store.getSetting('b')).toEqual({ nested: true });
      await store.apply({ settings: { a: null } });
      expect(await store.getSetting('a')).toBeUndefined();
    });

    it('applies the account pickle with the rest of a batch', async () => {
      const store = await makeStore();
      await expect(
        store.apply({ account: 'pickle', seen: [{ id: testId(), seenAt: 1 }] }),
      ).resolves.toBeUndefined();
    });
  });
}
