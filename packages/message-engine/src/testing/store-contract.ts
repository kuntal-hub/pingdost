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
  GroupRecord,
  HeldGroupRecord,
  InboundGroupSessionRecord,
  MessageRecord,
  OutboundGroupSessionRecord,
  PendingOpRecord,
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
    pinnedAt: null,
    archived: false,
    mutedUntil: null,
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
    attachment: null,
    replyTo: null,
    sentAt: 1_000,
    sortAt: 1_000,
    createdAt: 1_000,
    state: 'local_queued',
    expiresAt: 10_000,
    editedAt: null,
    editId: null,
    deletedAt: null,
    readAt: null,
    reactions: [],
    ...overrides,
  };
}

export function pendingOpRecord(overrides: Partial<PendingOpRecord> = {}): PendingOpRecord {
  return {
    opId: testId(),
    type: 'edit',
    targetMessageId: testId(),
    conversationId: testId(),
    senderUserId: testId(),
    sentAt: 1_000,
    body: 'edited',
    remove: false,
    receivedAt: 1_000,
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

    it('keeps attachment messages with their manifest and thumbnail', async () => {
      const store = await makeStore();
      const info = (fileName: string | null) => ({
        attachmentId: testId(),
        key: 'a2V5'.repeat(11),
        noncePrefix: 'bm9uY2U=',
        plaintextSize: 70_000,
        chunkCount: 2,
        ciphertextSize: 70_032,
        mimeType: 'image/jpeg',
        fileName,
        ciphertextSha256: 'aGFzaA==',
        chunkHashListSha256: 'bGlzdA==',
        thumbnail: null,
      });
      const photo = messageRecord({
        kind: 'attachment',
        body: 'the caption',
        attachment: { ...info('photo.jpg'), thumbnail: info(null) },
      });
      const file = messageRecord({ kind: 'attachment', body: '', attachment: info(null) });
      await store.apply({ messages: [photo, file] });
      expect(await store.getMessage(photo.messageId)).toEqual(photo);
      expect(await store.getMessage(file.messageId)).toEqual(file);
      await store.apply({ messages: [{ ...photo, kind: 'deleted', body: '', attachment: null }] });
      expect((await store.getMessage(photo.messageId))?.attachment).toBeNull();
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

      // Group items keep their group and Megolm marks (ADR 0016).
      const groupId = testId();
      const groupFanout: FanoutItem = { ...fanout, id: testId(), groupId, purpose: 'control' };
      const megolm: DeviceItem = {
        ...device,
        id: testId(),
        groupId,
        megolm: true,
        packet: Uint8Array.of(7),
      };
      const roomKey: DeviceItem = { ...device, id: testId(), purpose: 'room_key', groupId };
      await store.apply({ outbox: [groupFanout, megolm, roomKey] });
      expect(await store.getOutboxItem(groupFanout.id)).toEqual(groupFanout);
      expect(await store.getOutboxItem(megolm.id)).toEqual(megolm);
      expect(await store.getOutboxItem(roomKey.id)).toEqual(roomKey);
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

    it('keeps local conversation flags and message edits, reactions and read state', async () => {
      const store = await makeStore();
      const conversation = conversationRecord({
        pinnedAt: 7,
        archived: true,
        mutedUntil: Number.MAX_SAFE_INTEGER,
      });
      const message = messageRecord({
        conversationId: conversation.conversationId,
        direction: 'in',
        state: null,
        expiresAt: null,
        editedAt: 5,
        editId: testId(),
        readAt: 6,
        reactions: [
          { userId: testId(), emoji: '👍🏽', at: 3, id: testId() },
          { userId: testId(), emoji: null, at: 4, id: testId() },
        ],
      });
      const tombstone = messageRecord({ kind: 'deleted', body: '', deletedAt: 9 });
      await store.apply({ conversations: [conversation], messages: [message, tombstone] });
      expect(await store.getConversation(conversation.conversationId)).toEqual(conversation);
      expect(await store.getMessage(message.messageId)).toEqual(message);
      expect(await store.getMessage(tombstone.messageId)).toEqual(tombstone);
    });

    it('lists unread incoming messages, oldest first', async () => {
      const store = await makeStore();
      const conversationId = testId();
      const incoming = (sortAt: number, readAt: number | null) =>
        messageRecord({ conversationId, sortAt, direction: 'in', state: null, readAt });
      const later = incoming(5, null);
      const earlier = incoming(2, null);
      await store.apply({
        messages: [later, earlier, incoming(1, 1), messageRecord({ conversationId, sortAt: 3 })],
      });
      expect(await store.listUnread(conversationId)).toEqual([earlier, later]);
      await store.apply({ messages: [{ ...later, readAt: 9 }] });
      expect(await store.listUnread(conversationId)).toEqual([earlier]);
    });

    it('deletes messages with their deliveries, and whole conversations', async () => {
      const store = await makeStore();
      const conversation = conversationRecord();
      const { conversationId } = conversation;
      const [a, b] = [messageRecord({ conversationId }), messageRecord({ conversationId })] as [
        MessageRecord,
        MessageRecord,
      ];
      const other = messageRecord();
      const delivery = (messageId: string): DeliveryRecord => ({
        messageId,
        deviceId: testId(),
        userId: testId(),
        own: false,
        state: 'sent_to_server',
        updatedAt: 1,
      });
      const op = pendingOpRecord({ conversationId });
      const otherOp = pendingOpRecord();
      await store.apply({
        conversations: [conversation],
        messages: [a, b, other],
        deliveries: [delivery(a.messageId), delivery(b.messageId), delivery(other.messageId)],
        ops: [op, otherOp],
      });
      await store.apply({ deleteMessages: [a.messageId] });
      expect(await store.getMessage(a.messageId)).toBeUndefined();
      expect(await store.listDeliveries(a.messageId)).toEqual([]);
      expect(await store.listDeliveries(b.messageId)).toHaveLength(1);

      await store.apply({ deleteConversations: [conversationId] });
      expect(await store.getConversation(conversationId)).toBeUndefined();
      expect(await store.listMessages(conversationId, { limit: 10 })).toEqual([]);
      expect(await store.listDeliveries(b.messageId)).toEqual([]);
      expect(await store.listOps(op.targetMessageId)).toEqual([]);
      expect(await store.getMessage(other.messageId)).toEqual(other);
      expect(await store.listDeliveries(other.messageId)).toHaveLength(1);
      expect(await store.listOps(otherOp.targetMessageId)).toEqual([otherOp]);
    });

    it('keeps pending ops per target until deleted or pruned', async () => {
      const store = await makeStore();
      const targetMessageId = testId();
      const first = pendingOpRecord({ targetMessageId, receivedAt: 1 });
      const second = pendingOpRecord({
        targetMessageId,
        type: 'reaction',
        body: '',
        remove: true,
        receivedAt: 5,
      });
      await store.apply({ ops: [second, first] });
      expect(await store.listOps(targetMessageId)).toEqual([first, second]);
      await store.apply({ deleteOps: [second.opId] });
      expect(await store.listOps(targetMessageId)).toEqual([first]);
      await store.apply({ pruneOpsBefore: 2 });
      expect(await store.listOps(targetMessageId)).toEqual([]);
    });

    it('searches text by word prefixes, case- and accent-blind, newest first', async () => {
      const store = await makeStore();
      const conversationId = testId();
      const text = (body: string, sortAt: number, overrides: Partial<MessageRecord> = {}) =>
        messageRecord({ conversationId, body, sortAt, ...overrides });
      const hello = text('Hello there, Café friends!', 1);
      const help = text('I need help with the café', 2);
      const hindi = text('नमस्ते दोस्त, कैसे हो?', 3);
      const deleted = text('', 4, { kind: 'deleted' });
      const elsewhere = messageRecord({ body: 'hello from another chat', sortAt: 5 });
      const notice = text('safety_number_changed', 6, { kind: 'system' });
      await store.apply({ messages: [hello, help, hindi, deleted, elsewhere, notice] });

      const ids = async (query: string, conversation?: string) =>
        (
          await store.searchMessages(query, {
            limit: 10,
            ...(conversation ? { conversationId: conversation } : {}),
          })
        ).map((m) => m.messageId);

      expect(await ids('hel')).toEqual([elsewhere.messageId, help.messageId, hello.messageId]);
      expect(await ids('hel', conversationId)).toEqual([help.messageId, hello.messageId]);
      expect(await ids('CAFE hel', conversationId)).toEqual([help.messageId, hello.messageId]);
      expect(await ids('hello cafe friend')).toEqual([hello.messageId]);
      expect(await ids('दोस्त')).toEqual([hindi.messageId]);
      expect(await ids('नमस्')).toEqual([hindi.messageId]);
      expect(await ids('there,')).toEqual([hello.messageId]);
      expect(await ids('ere')).toEqual([]);
      expect(await ids('safety')).toEqual([]);
      expect(await ids('"*) OR (')).toEqual([]);
      expect(await ids('   ')).toEqual([]);

      // Edits re-index; deleted and removed messages leave the index.
      await store.apply({ messages: [{ ...help, body: 'thanks a lot' }] });
      expect(await ids('help')).toEqual([]);
      expect(await ids('thanks')).toEqual([help.messageId]);
      await store.apply({ messages: [{ ...hello, kind: 'deleted', body: '' }] });
      await store.apply({ deleteMessages: [hindi.messageId] });
      expect(await ids('hello', conversationId)).toEqual([]);
      expect(await ids('दोस्त')).toEqual([]);
      expect(await ids('thanks', conversationId)).toEqual([help.messageId]);
    });

    it('applies the account pickle with the rest of a batch', async () => {
      const store = await makeStore();
      await expect(
        store.apply({ account: 'pickle', seen: [{ id: testId(), seenAt: 1 }] }),
      ).resolves.toBeUndefined();
    });

    it('keeps groups, Megolm sessions and held group traffic (ADR 0016)', async () => {
      const store = await makeStore();
      const groupId = testId();
      const group: GroupRecord = {
        groupId,
        version: 3,
        members: [
          { userId: testId(), role: 'owner' },
          { userId: testId(), role: 'member' },
        ],
        serverVersion: 2,
        serverMembers: [{ userId: testId(), role: 'admin' }],
        name: 'Trip',
        description: 'Goa in May',
        avatar: Uint8Array.of(9, 8, 7),
        infoAt: 5,
        infoId: testId(),
        left: false,
        createdAt: 2,
        updatedAt: 4,
      };
      const older: GroupRecord = { ...group, groupId: testId(), avatar: null, createdAt: 1 };
      const conversation = conversationRecord({
        conversationId: groupId,
        kind: 'group',
        peerUserId: '',
      });
      const outbound: OutboundGroupSessionRecord = {
        groupId,
        sessionId: 'session-out',
        pickle: 'pickle-out',
        createdAt: 1,
        messageCount: 4,
        sharedWith: [testId(), testId()],
        memberKey: 'a,b',
      };
      const senderDeviceId = testId();
      const inbound: InboundGroupSessionRecord = {
        sessionId: 'session-in',
        groupId,
        senderUserId: testId(),
        senderDeviceId,
        senderKey: 'curve',
        pickle: 'pickle-in',
        firstKnownIndex: 2,
        seenIndices: [2, 5],
        createdAt: 3,
        sharedAt: { [testId()]: 4 },
      };
      // The same session ID from another device is another session.
      const claimed: InboundGroupSessionRecord = {
        ...inbound,
        senderDeviceId: testId(),
        pickle: 'other',
        seenIndices: [],
      };
      delete claimed.sharedAt;
      const held = (receivedAt: number, kind: HeldGroupRecord['kind']): HeldGroupRecord => ({
        id: testId(),
        kind,
        groupId,
        sessionId: 'session-in',
        senderUserId: inbound.senderUserId,
        senderDeviceId,
        payload: Uint8Array.of(1, 2, 3),
        receivedAt,
        requestedAt: 0,
      });
      const late = held(5, 'megolm');
      const early = held(2, 'room_key');
      await store.apply({
        conversations: [conversation],
        groups: [group, older],
        outboundGroupSessions: [outbound],
        inboundGroupSessions: [inbound, claimed],
        held: [late, early],
      });

      expect(await store.getConversation(groupId)).toEqual(conversation);
      expect(await store.getGroup(groupId)).toEqual(group);
      expect(await store.listGroups()).toEqual([older, group]);
      expect(await store.getOutboundGroupSession(groupId)).toEqual(outbound);
      expect(await store.getInboundGroupSession(senderDeviceId, 'session-in')).toEqual(inbound);
      expect(await store.getInboundGroupSession(claimed.senderDeviceId, 'session-in')).toEqual(
        claimed,
      );
      expect(await store.getInboundGroupSession(testId(), 'session-in')).toBeUndefined();
      expect(await store.listHeld(groupId)).toEqual([early, late]);

      // One current outbound session per group; held records go by ID or age.
      const rotated = { ...outbound, sessionId: 'session-new', messageCount: 0 };
      await store.apply({
        outboundGroupSessions: [rotated],
        held: [{ ...late, requestedAt: 9 }],
        deleteHeld: [early.id],
      });
      expect(await store.getOutboundGroupSession(groupId)).toEqual(rotated);
      expect(await store.listHeld(groupId)).toEqual([{ ...late, requestedAt: 9 }]);
      await store.apply({ pruneHeldBefore: 6 });
      expect(await store.listHeld(groupId)).toEqual([]);

      // Deleting a group takes its sessions and held records, not its conversation.
      await store.apply({ held: [late] });
      await store.apply({ deleteGroups: [groupId] });
      expect(await store.getGroup(groupId)).toBeUndefined();
      expect(await store.getOutboundGroupSession(groupId)).toBeUndefined();
      expect(await store.getInboundGroupSession(senderDeviceId, 'session-in')).toBeUndefined();
      expect(await store.listHeld(groupId)).toEqual([]);
      expect(await store.listGroups()).toEqual([older]);
      expect(await store.getConversation(groupId)).toEqual(conversation);
    });
  });
}
