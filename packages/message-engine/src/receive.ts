/**
 * The receive pipeline (REQ §8.1, §8.3; ARCHITECTURE A3). Packets are handled one at a time,
 * in arrival order:
 * 1. decode the envelope; drop duplicates by envelope ID;
 * 2. find the sending device in its owner's verified directory (asking the server who owns
 *    an unknown device); offline, the packet stays unacknowledged and is redelivered later;
 * 3. decrypt (pre-key routing in `SessionManager`); a failure asks the device for a new
 *    session, rate-limited;
 * 4. check the header, dedupe by message ID, then persist the message, the advanced session,
 *    the seen IDs and the receipt to send in one batch;
 * 5. transport ACK, only after the batch is stored;
 * 6. events (via the commit), then the receipt goes out with the next outbox pass.
 * Edits, deletes and reactions change their target (`features/ops.ts`), or wait for it.
 * Content from a blocked user is decrypted (keeping the session in step) and dropped.
 */
import {
  bytesToUuid,
  CryptoType,
  decodeContent,
  decodeContentHeader,
  decodeEnvelope,
  ProtocolError,
  Receipt_Type,
  type Content,
  type ContentHeader,
  type Envelope,
  type GroupControl,
  type TransportPacket,
} from '@pingdost/protocol';

import { readAttachment } from './attachments';
import { checkGroupHeader, checkHeader, type CheckedHeader } from './content';
import { EngineCore } from './core';
import { applyOp, applyPending, type Op } from './features/ops';
import { readControl } from './groups/content';
import { groupNoticeBody } from './groups/notices';
import { applyControl, isMember } from './groups/state';
import { compareMessages } from './memoryStore';
import type { Outbox } from './outbox';
import type { RemoteDevice } from './sessions';
import type {
  AttachmentInfo,
  ConversationRecord,
  DeliveryRecord,
  GroupRecord,
  HeldGroupRecord,
  MessageRecord,
  ReceiptItem,
  WriteBatch,
} from './store';

type Effect = () => void | Promise<void>;

/** What group members may send over Megolm; everything else comes over Olm or not at all. */
const GROUP_BODIES = new Set<string>(['text', 'attachmentManifest', 'reaction', 'edit', 'delete']);

/** A key request from one device for one session is answered at most this often. */
const KEY_ANSWER_INTERVAL_MS = 60_000;

export class Receiver {
  #queue: Promise<void> = Promise.resolve();
  /** When this device last asked each remote device for a session reset. */
  readonly #resets = new Map<string, number>();
  /** When each (device, session) key request was last answered. */
  readonly #answered = new Map<string, number>();
  #keyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly core: EngineCore,
    private readonly outbox: Outbox,
  ) {}

  /** Queues a packet; `ack` is called once it is stored (or known to be useless). */
  handle(packet: TransportPacket, ack: () => void): void {
    this.#queue = this.#queue
      .then(() => this.#process(packet, ack))
      .catch((error: unknown) => {
        // Not acknowledged: the mailbox delivers it again on the next connection.
        this.core.log('error', 'receive failed', { error: String(error) });
      });
  }

  /** Resolves once every queued packet is handled. */
  idle(): Promise<void> {
    return this.#queue;
  }

  async #process(packet: TransportPacket, ack: () => void): Promise<void> {
    const { core } = this;
    let envelope: Envelope;
    try {
      envelope = decodeEnvelope(packet.payload, {
        envelopeMaxBytes: core.settings.envelopeMaxBytes,
      });
    } catch {
      ack(); // can never be read
      return;
    }
    const envelopeId = bytesToUuid(envelope.envelopeId);
    if (bytesToUuid(envelope.recipientDeviceId) !== core.self.deviceId) {
      ack();
      return;
    }
    if (await core.store.hasSeen(envelopeId)) {
      ack();
      return;
    }

    const senderDeviceId = bytesToUuid(envelope.senderDeviceId);
    const owner = await core.ownerOf(senderDeviceId);
    if (owner.status === 'unavailable') return; // retried on the next connection
    if (owner.status === 'unknown') {
      core.log('warn', 'envelope from an unknown or unverified device');
      ack();
      return;
    }
    const sender: RemoteDevice = {
      deviceId: senderDeviceId,
      userId: owner.userId,
      curve25519: owner.device.curve25519,
    };

    const effects = await core.mutex.run(() =>
      envelope.cryptoType === CryptoType.MEGOLM
        ? this.#megolm(envelope, envelopeId, sender)
        : this.#decryptAndStore(envelope, envelopeId, sender),
    );
    ack();
    for (const effect of effects) await effect();
  }

  // Groups (ADR 0016)

  async #megolm(envelope: Envelope, envelopeId: string, sender: RemoteDevice): Promise<Effect[]> {
    const { core } = this;
    let groupId: string;
    try {
      groupId = bytesToUuid(envelope.groupId ?? new Uint8Array(0));
    } catch {
      return []; // no group: unreadable
    }
    return this.#readGroupMessage(
      {
        id: envelopeId,
        kind: 'megolm',
        groupId,
        sessionId: envelope.megolmSessionId,
        senderUserId: sender.userId,
        senderDeviceId: sender.deviceId,
        payload: envelope.ciphertext,
        receivedAt: core.now(),
        requestedAt: 0,
      },
      sender,
      false,
    );
  }

  /**
   * Decrypts and files a group message, or keeps it (`held`) until its key or its group is
   * known. A replay of an accepted (session, index) pair is dropped.
   */
  async #readGroupMessage(
    held: HeldGroupRecord,
    sender: RemoteDevice,
    fromHold: boolean,
  ): Promise<Effect[]> {
    const { core } = this;
    const now = core.now();
    const done: WriteBatch = { seen: [{ id: held.id, seenAt: now }] };
    if (fromHold) done.deleteHeld = [held.id];
    if (await core.store.hasSeen(held.id)) {
      if (fromHold) await core.commit({ deleteHeld: [held.id] });
      return [];
    }
    const group = await core.store.getGroup(held.groupId);
    const session = await core.store.getInboundGroupSession(sender.deviceId, held.sessionId);
    if (!group || !session) {
      if (fromHold) return [];
      await core.commit({ held: [held] });
      return [() => this.#scheduleKeyRequests()];
    }
    if (group.left || session.groupId !== held.groupId || session.senderUserId !== sender.userId) {
      await core.commit(done);
      return [];
    }
    const result = core.groupSessions.decrypt(session, held.payload);
    if (!result.ok) {
      if (result.reason === 'replay') {
        core.log('warn', 'replayed group message dropped');
        await core.commit(done);
        return [];
      }
      // The key this device has starts later (or the message is damaged): ask the sender.
      if (fromHold) return [];
      await core.commit({ held: [held] });
      return [() => this.#scheduleKeyRequests()];
    }
    const batch: WriteBatch = { ...done, inboundGroupSessions: [result.record] };
    const effects = await this.#interpret(result.plaintext, sender, batch, now, group);
    await core.commit(batch);
    if (batch.outbox?.length) effects.push(() => this.outbox.kick());
    return effects;
  }

  /** Room keys, group controls and key requests: group content that travels over Olm. */
  async #groupOlm(
    content: Content,
    header: ContentHeader,
    sender: RemoteDevice,
    plaintext: Uint8Array,
    batch: WriteBatch,
    now: number,
    held?: HeldGroupRecord,
  ): Promise<Effect[]> {
    const { core } = this;
    const body = content.body;
    if (body.case !== 'roomKey' && body.case !== 'groupControl' && body.case !== 'roomKeyRequest') {
      return [];
    }
    let groupId: string;
    try {
      groupId = bytesToUuid(body.value.groupId);
    } catch {
      return [];
    }
    const checked = checkGroupHeader(header, sender, groupId);
    if (!checked) {
      core.log('warn', 'group content header rejected');
      return [];
    }
    if (!held) {
      if (await core.store.hasSeen(checked.messageId)) return [];
      batch.seen!.push({ id: checked.messageId, seenAt: now });
    }
    switch (body.case) {
      case 'groupControl':
        return this.#control(batch, checked, groupId, body.value, now);
      case 'roomKey': {
        const group = await core.store.getGroup(groupId);
        const known =
          group && (group.left || group.members.some((m) => m.userId === sender.userId));
        if (!group || !known) {
          // The group, or the sender's membership, is not known here yet: its control may
          // still be on the way.
          if (!held) {
            (batch.held ??= []).push({
              id: checked.messageId,
              kind: 'room_key',
              groupId,
              sessionId: body.value.sessionId,
              senderUserId: sender.userId,
              senderDeviceId: sender.deviceId,
              payload: plaintext,
              receivedAt: now,
              requestedAt: 0,
            });
          }
          return [];
        }
        if (held) (batch.deleteHeld ??= []).push(held.id);
        if (group.left) return [];
        const existing = await core.store.getInboundGroupSession(
          sender.deviceId,
          body.value.sessionId,
        );
        const record = core.groupSessions.receive(
          groupId,
          sender,
          body.value.sessionId,
          body.value.sessionKey,
          body.value.exported,
          now,
        );
        if (!record) {
          core.log('warn', 'room key rejected');
          return [];
        }
        if (existing && existing.firstKnownIndex <= record.firstKnownIndex) {
          // The key already here reaches as far back: keep it (and its cached session).
          core.groupSessions.forget(record);
          return [];
        }
        (batch.inboundGroupSessions ??= []).push({
          ...record,
          seenIndices: existing?.seenIndices ?? [],
        });
        return [() => this.retryHeld(groupId)];
      }
      case 'roomKeyRequest': {
        const group = await core.store.getGroup(groupId);
        if (!group || group.left || !group.members.some((m) => m.userId === sender.userId)) {
          return [];
        }
        const own = await core.store.getInboundGroupSession(
          core.self.deviceId,
          body.value.sessionId,
        );
        // Only for devices the session was shared with, from the index they got it at: a
        // device added later never reads what came before.
        const sharedAt = own?.groupId === groupId ? own.sharedAt?.[sender.deviceId] : undefined;
        if (!own || sharedAt === undefined) return [];
        const key = `${sender.deviceId}:${own.sessionId}`;
        const last = this.#answered.get(key) ?? 0;
        if (now - last < KEY_ANSWER_INTERVAL_MS) return [];
        this.#answered.set(key, now);
        this.outbox.answerKeyRequest(batch, sender, own, Math.max(body.value.fromIndex, sharedAt));
        return [];
      }
    }
  }

  async #control(
    batch: WriteBatch,
    header: CheckedHeader,
    groupId: string,
    value: GroupControl,
    now: number,
  ): Promise<Effect[]> {
    const { core } = this;
    const input = readControl(value, header);
    if (!input || input.groupId !== groupId) {
      core.log('warn', 'malformed group control');
      return [];
    }
    const current = await core.store.getGroup(groupId);
    const result = applyControl(current, input, core.self.userId, now);
    if (!result.applied) {
      core.log('info', 'group control not applied', { reason: result.reason });
      return [];
    }
    batch.groups = [...(batch.groups ?? []), result.group];
    const conversation =
      batch.conversations?.find((c) => c.conversationId === groupId) ??
      (await core.store.getConversation(groupId)) ??
      core.newGroupConversation(groupId, now);
    batch.conversations = [
      ...(batch.conversations ?? []).filter((c) => c.conversationId !== groupId),
      conversation,
    ];
    if (result.notice) {
      core.addSystemMessage(
        batch,
        conversation,
        groupNoticeBody(result.notice),
        header.senderUserId,
      );
    }
    const effects: Effect[] = [() => this.retryHeld(groupId)];
    // A group new to this device: check the server's view too (removals only).
    if (!current) effects.push(() => void core.groupSync?.(groupId));
    return effects;
  }

  /** Tries held group traffic again: a key, the group or a member became known. */
  async retryHeld(groupId: string): Promise<void> {
    const { core } = this;
    const effects = await core.mutex.run(async () => {
      const out: Effect[] = [];
      const held = await core.store.listHeld(groupId);
      for (const item of held.filter((h) => h.kind === 'room_key')) {
        const sender = await this.#knownDevice(item.senderUserId, item.senderDeviceId);
        if (!sender) continue;
        let content: Content;
        try {
          content = decodeContent(item.payload, {
            envelopeMaxBytes: core.settings.envelopeMaxBytes,
          });
        } catch {
          await core.commit({ deleteHeld: [item.id] });
          continue;
        }
        const batch: WriteBatch = { seen: [] };
        const now = core.now();
        out.push(
          ...(await this.#groupOlm(
            content,
            content.header!,
            sender,
            item.payload,
            batch,
            now,
            item,
          )),
        );
        if (batch.deleteHeld?.length || batch.inboundGroupSessions?.length)
          await core.commit(batch);
      }
      for (const item of await core.store.listHeld(groupId)) {
        if (item.kind !== 'megolm') continue;
        const sender = await this.#knownDevice(item.senderUserId, item.senderDeviceId);
        if (sender) out.push(...(await this.#readGroupMessage(item, sender, true)));
      }
      return out;
    });
    for (const effect of effects) await effect();
  }

  /** A device from its owner's cached, verified directory. */
  async #knownDevice(userId: string, deviceId: string): Promise<RemoteDevice | undefined> {
    const device = (await this.core.store.getDirectory(userId))?.devices.find(
      (d) => d.deviceId === deviceId,
    );
    return device && { deviceId, userId, curve25519: device.curve25519 };
  }

  #scheduleKeyRequests(): void {
    if (this.#keyTimer) return;
    this.#keyTimer = setTimeout(() => {
      this.#keyTimer = undefined;
      void this.requestMissingKeys().catch((error: unknown) =>
        this.core.log('warn', 'key requests failed', { error: String(error) }),
      );
    }, this.core.settings.roomKeyRequestDelayMs);
  }

  /**
   * Asks senders for the keys of group messages held too long (once per session and
   * interval). Runs after a hold and with the engine's sweep.
   */
  async requestMissingKeys(): Promise<void> {
    const { core } = this;
    const due = await core.mutex.run(async () => {
      const now = core.now();
      const requests = new Map<string, HeldGroupRecord>();
      const updated: HeldGroupRecord[] = [];
      for (const group of await core.store.listGroups()) {
        if (group.left) continue;
        for (const item of await core.store.listHeld(group.groupId)) {
          if (item.kind !== 'megolm') continue;
          if (now - item.receivedAt < core.settings.roomKeyRequestDelayMs) continue;
          if (now - item.requestedAt < core.settings.roomKeyRequestIntervalMs) continue;
          if (!group.members.some((m) => m.userId === item.senderUserId)) continue;
          requests.set(`${item.senderDeviceId}:${item.sessionId}`, item);
          updated.push({ ...item, requestedAt: now });
        }
      }
      if (updated.length > 0) await core.commit({ held: updated });
      return [...requests.values()];
    });
    for (const item of due) {
      await this.outbox.requestRoomKey(
        { userId: item.senderUserId, deviceId: item.senderDeviceId },
        item.groupId,
        item.sessionId,
        0,
      );
    }
  }

  dispose(): void {
    clearTimeout(this.#keyTimer);
    this.#keyTimer = undefined;
  }

  async #decryptAndStore(
    envelope: Envelope,
    envelopeId: string,
    sender: RemoteDevice,
  ): Promise<Effect[]> {
    const { core } = this;
    if (await core.store.hasSeen(envelopeId)) return [];
    const now = core.now();
    const result = await core.sessions.decrypt(
      sender,
      {
        type: envelope.cryptoType === CryptoType.OLM_PREKEY ? 'prekey' : 'normal',
        body: envelope.ciphertext,
      },
      now,
    );
    if (!result.ok) {
      // Not marked seen: after the repair, the sender resends it under the same envelope ID.
      return [() => this.#undecryptable(sender, result.sessionId)];
    }

    const batch: WriteBatch = {
      sessions: [result.session],
      seen: [{ id: envelopeId, seenAt: now }],
    };
    if (result.accountChanged) batch.account = core.accountPickle();
    const effects = await this.#interpret(result.plaintext, sender, batch, now);
    await core.commit(batch);
    // A receipt was queued: the outbox batches it after `receiptDelayMs`.
    if (batch.outbox?.length) effects.push(() => this.outbox.kick());
    return effects;
  }

  /** `group`: the content came over the group's Megolm session. */
  async #interpret(
    plaintext: Uint8Array,
    sender: RemoteDevice,
    batch: WriteBatch,
    now: number,
    group?: GroupRecord,
  ): Promise<Effect[]> {
    const { core } = this;
    let content: Content | undefined;
    let header: ContentHeader;
    try {
      content = decodeContent(plaintext, { envelopeMaxBytes: core.settings.envelopeMaxBytes });
      header = content.header!;
    } catch (error) {
      if (!(error instanceof ProtocolError) || error.code !== 'UNKNOWN_BODY') {
        core.log('warn', 'undecodable content', {
          code: error instanceof ProtocolError ? error.code : 'unknown',
        });
        return [];
      }
      // A body from a newer version: keep a placeholder ("update needed").
      header = decodeContentHeader(plaintext, { envelopeMaxBytes: core.settings.envelopeMaxBytes });
    }
    const kind = content?.body.case;
    if (!group && (kind === 'roomKey' || kind === 'groupControl' || kind === 'roomKeyRequest')) {
      return this.#groupOlm(content!, header, sender, plaintext, batch, now);
    }
    const checked = group
      ? checkGroupHeader(header, sender, group.groupId)
      : checkHeader(header, sender, core.self.userId);
    if (!checked) {
      core.log('warn', 'content header rejected');
      return [];
    }
    if (await core.store.hasSeen(checked.messageId)) return [];
    batch.seen!.push({ id: checked.messageId, seenAt: now });
    if (core.isBlocked(checked.senderUserId)) return [];
    if (group) {
      // Over Megolm: only members' messages, edits, deletes and reactions count.
      if (!isMember(group, checked.senderUserId)) return [];
      if (kind !== undefined && !GROUP_BODIES.has(kind)) return [];
    }

    const body = content?.body;
    switch (body?.case) {
      case undefined:
        return this.#storeMessage(batch, checked, sender, 'unsupported', '', now);
      case 'text':
        return this.#storeMessage(batch, checked, sender, 'text', body.value.body, now);
      case 'attachmentManifest': {
        // Kept for an on-demand download; a manifest that fails the checks is a placeholder.
        const read = readAttachment(body.value);
        if (!read) return this.#storeMessage(batch, checked, sender, 'unsupported', '', now);
        return this.#storeMessage(
          batch,
          checked,
          sender,
          'attachment',
          read.caption,
          now,
          read.info,
        );
      }
      case 'reaction':
        await this.#applyOp(batch, checked, 'reaction', body.value.targetMessageId, now, {
          body: body.value.emoji,
          remove: body.value.remove,
        });
        return [];
      case 'edit':
        await this.#applyOp(batch, checked, 'edit', body.value.targetMessageId, now, {
          body: body.value.body,
        });
        return [];
      case 'delete':
        await this.#applyOp(batch, checked, 'delete', body.value.targetMessageId, now);
        return [];
      case 'receipt': {
        if (checked.senderUserId === core.self.userId) return [];
        // Reciprocal: with read receipts off, a read receipt still proves delivery.
        const read =
          body.value.type === Receipt_Type.READ && (core.options.receipts?.('read') ?? false);
        await this.#applyReceipt(
          batch,
          sender,
          read ? 'read' : 'delivered_to_recipient_device',
          body.value.messageIds,
          now,
        );
        return [];
      }
      case 'sessionReset':
        return [() => this.outbox.resendTo(sender.userId, sender.deviceId)];
      case 'keyChange':
        return [() => void core.refreshDirectory(sender.userId)];
      default:
        // History sync and calls arrive with their phases (18, 25).
        return [];
    }
  }

  /** Applies an edit, delete or reaction to its target, or keeps it until the target arrives. */
  async #applyOp(
    batch: WriteBatch,
    header: CheckedHeader,
    type: Op['type'],
    targetBytes: Uint8Array,
    now: number,
    fields: { body?: string; remove?: boolean } = {},
  ): Promise<void> {
    const { core } = this;
    let targetMessageId: string;
    try {
      targetMessageId = bytesToUuid(targetBytes);
    } catch {
      return; // no target: nothing to change
    }
    const op: Op = {
      opId: header.messageId,
      type,
      targetMessageId,
      conversationId: header.conversationId,
      senderUserId: header.senderUserId,
      sentAt: header.sentAt,
      body: fields.body ?? '',
      remove: fields.remove ?? false,
    };
    const target = await core.store.getMessage(targetMessageId);
    if (!target) {
      (batch.ops ??= []).push({ ...op, receivedAt: now });
      return;
    }
    const changed = applyOp(target, op, core.opRules);
    if (!changed) return;
    await this.#keep(batch, target, changed, now);
  }

  /** Adds a changed message to the batch; a deleted unread message stops counting as unread. */
  async #keep(
    batch: WriteBatch,
    before: MessageRecord,
    after: MessageRecord,
    now: number,
  ): Promise<void> {
    const deletedUnread =
      after.kind === 'deleted' && before.direction === 'in' && before.readAt === null;
    batch.messages = [...(batch.messages ?? []), deletedUnread ? { ...after, readAt: now } : after];
    if (!deletedUnread) return;
    const conversation = await this.core.store.getConversation(after.conversationId);
    if (conversation && conversation.unreadCount > 0) {
      batch.conversations = [{ ...conversation, unreadCount: conversation.unreadCount - 1 }];
    }
  }

  /** Files a new message; the effect announces it (`received`) once it is committed. */
  async #storeMessage(
    batch: WriteBatch,
    header: CheckedHeader,
    sender: RemoteDevice,
    kind: MessageRecord['kind'],
    text: string,
    now: number,
    attachment: AttachmentInfo | null = null,
  ): Promise<Effect[]> {
    const { core } = this;
    // From this user's other device: a copy of something this user sent.
    const own = header.senderUserId === core.self.userId;
    // Group content names no recipient; its conversation is the group.
    const inGroup = header.recipientUserId === undefined;
    const conversation: ConversationRecord =
      (await core.store.getConversation(header.conversationId)) ??
      (inGroup
        ? core.newGroupConversation(header.conversationId, now)
        : core.newConversation(own ? header.recipientUserId! : header.senderUserId, now));
    const arrived: MessageRecord = {
      messageId: header.messageId,
      conversationId: header.conversationId,
      senderUserId: header.senderUserId,
      senderDeviceId: sender.deviceId,
      direction: own ? 'out' : 'in',
      kind,
      body: text,
      attachment,
      replyTo: header.replyTo,
      sentAt: header.sentAt,
      // A sender clock ahead of ours must not pin the message below newer ones.
      sortAt: Math.min(header.sentAt, now),
      createdAt: now,
      // The sending device tracks delivery; this copy only knows the server had it.
      state: own ? 'sent_to_server' : null,
      expiresAt: null,
      editedAt: null,
      editId: null,
      deletedAt: null,
      // This user's own messages are read; incoming ones wait for the chat to be opened.
      readAt: own ? now : null,
      reactions: [],
    };
    // Edits, deletes or reactions that overtook the message.
    const pending = await core.store.listOps(arrived.messageId);
    let message = arrived;
    if (pending.length > 0) {
      message = applyPending(arrived, pending, core.opRules);
      batch.deleteOps = [...(batch.deleteOps ?? []), ...pending.map((op) => op.opId)];
    }
    // Deleted before it arrived: it never counts as unread.
    const unread = !own && message.kind !== 'deleted';
    if (!unread && message.readAt === null) message = { ...message, readAt: now };
    // The chat list previews the newest message by display order (not by arrival).
    const last = conversation.lastMessageId
      ? await core.store.getMessage(conversation.lastMessageId)
      : undefined;
    const latest = !last || compareMessages(message, last) <= 0;
    batch.messages = [...(batch.messages ?? []), message];
    batch.conversations = [
      {
        ...conversation,
        updatedAt: Math.max(conversation.updatedAt, message.sortAt),
        lastMessageId: latest ? message.messageId : conversation.lastMessageId,
        unreadCount: conversation.unreadCount + (unread ? 1 : 0),
      },
    ];
    if (!own && (core.options.receipts?.('delivered') ?? true)) {
      const receipt: ReceiptItem = {
        type: 'receipt',
        receipt: 'delivered',
        id: `receipt:delivered:${message.messageId}:${sender.deviceId}`,
        messageId: message.messageId,
        recipientUserId: sender.userId,
        recipientDeviceId: sender.deviceId,
        createdAt: now,
        expiresAt: now + core.settings.maxRetentionMs,
        attempts: 0,
        nextAttemptAt: now,
      };
      batch.outbox = [...(batch.outbox ?? []), receipt];
    }
    return unread ? [() => core.events.emit({ type: 'received', message })] : [];
  }

  /**
   * Only a receipt from a recipient device of the message counts; receipts from the sender's
   * own devices, or for messages this device did not send, change nothing.
   */
  async #applyReceipt(
    batch: WriteBatch,
    sender: RemoteDevice,
    state: 'delivered_to_recipient_device' | 'read',
    messageIds: Uint8Array[],
    now: number,
  ): Promise<void> {
    const { core } = this;
    const ids = new Set<string>();
    for (const bytes of messageIds) {
      try {
        ids.add(bytesToUuid(bytes));
      } catch {
        // not an ID: skip it
      }
    }
    for (const messageId of ids) {
      const row = (await core.store.listDeliveries(messageId)).find(
        (d) => d.deviceId === sender.deviceId && d.userId === sender.userId && !d.own,
      );
      if (!row) continue;
      const moved: DeliveryRecord | undefined = EngineCore.moved(row, state, now);
      if (!moved) continue;
      batch.deliveries = [...(batch.deliveries ?? []), moved];
      // Delivered before the server's answer came: nothing left to send.
      (batch.deleteOutbox ??= []).push(...(await this.#queuedFor(messageId, sender.deviceId)));
      const message = await core.restate(messageId, [moved]);
      if (message) batch.messages = [...(batch.messages ?? []), message];
    }
  }

  async #queuedFor(messageId: string, deviceId: string): Promise<string[]> {
    const items = await this.core.store.listOutbox();
    return items
      .filter(
        (item) =>
          item.type === 'device' &&
          item.messageId === messageId &&
          item.recipientDeviceId === deviceId,
      )
      .map((item) => item.id);
  }

  async #undecryptable(sender: RemoteDevice, sessionId: string | undefined): Promise<void> {
    const { core } = this;
    core.events.emit({ type: 'decrypt_failed', userId: sender.userId, deviceId: sender.deviceId });
    const last = this.#resets.get(sender.deviceId) ?? -Infinity;
    const now = core.now();
    if (now - last < core.settings.sessionResetIntervalMs) return;
    this.#resets.set(sender.deviceId, now);
    core.log('warn', 'undecryptable envelope: requesting a new session');
    await this.outbox.requestReset(sender.userId, sender.deviceId, sessionId);
  }
}
