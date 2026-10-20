/**
 * The message engine (REQ §4.3, §8): platform- and transport-neutral. A UI talks only to
 * this class; storage comes in as an `EngineStore`, the network as a transport (router) and
 * the key directory API.
 *
 * - `sendText` stores the message (UUIDv7) and its outbox entry before any network call.
 * - States follow REQ §8.3: "delivered" only on an E2EE receipt from a recipient device.
 * - Messages without a receipt by createdAt + max retention become `expired_undelivered`.
 * - Typing is transient: relayed in memory, never stored, and off with the privacy toggle.
 * - Edits, deletes and reactions are applied here first, then sent to the peer's and this
 *   user's other devices as control Contents (`features/ops.ts`, ADR 0014).
 * - Read receipts go out when the user opens the chat, only while the toggle is on.
 */
import { uuidToBytes, uuidv7 } from '@pingdost/protocol';
import { MessageState } from '@pingdost/shared-types';

import { buildContent, textContentFor } from './content';
import { EngineCore, type ConversationEvent, type EngineEvent, type EngineOptions } from './core';
import { MessageActionError } from './errors';
import {
  applyOp,
  canDeleteForEveryone,
  canEdit,
  canReact,
  isValidReaction,
  type Op,
} from './features/ops';
import { GroupManager, type GroupInfo } from './groups/manager';
import { FALLBACK_KEY_MAX_AGE_MS, publishKeys, type PublishKeysResult } from './keys';
import { Outbox } from './outbox';
import { Receiver } from './receive';
import { advance, SETTLED_STATES } from './states';
import type {
  ConversationRecord,
  DeliveryRecord,
  DirectoryRecord,
  FanoutItem,
  GroupRecord,
  MessageCursor,
  MessageRecord,
  OutboxItem,
  ReceiptItem,
  WriteBatch,
} from './store';

/** Who a conversation's messages go to: the peer, or the group's members. */
interface Audience {
  recipientUserIds: string[];
  /** Direct: the peer named in each Content header. */
  peerUserId?: string;
  groupId?: string;
}

export { MessageActionError };

/** Seen IDs outlive the longest an envelope can stay in a mailbox, plus a margin. */
const SEEN_MARGIN_MS = 86_400_000;
/** An outgoing typing "active" is refreshed at most this often. */
const TYPING_REFRESH_MS = 3_000;
const FALLBACK_ROTATED_AT = 'engine.fallbackKeyRotatedAt';

export interface ContactInfo {
  directory: DirectoryRecord | undefined;
  /** The user verified the current account identity key (QR or safety number). */
  verified: boolean;
}

export class MessageEngine {
  readonly #core: EngineCore;
  readonly #outbox: Outbox;
  readonly #receiver: Receiver;
  readonly #groups: GroupManager;
  readonly #unsubscribe: (() => void)[] = [];
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  readonly #typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #typingSentAt = new Map<string, number>();
  #started = false;

  constructor(options: EngineOptions) {
    this.#core = new EngineCore(options);
    this.#outbox = new Outbox(this.#core);
    this.#receiver = new Receiver(this.#core, this.#outbox);
    this.#groups = new GroupManager(this.#core, this.#outbox);
    this.#core.groupSync = (groupId) => this.#groups.sync(groupId);
  }

  get self(): EngineOptions['self'] {
    return this.#core.self;
  }

  /** Recovers from a crash mid-send, then listens to the transport and drains the outbox. */
  async start(): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    const core = this.#core;
    await this.#recover();
    const { transport } = core.options;
    this.#unsubscribe.push(
      transport.onPacket((packet, ack) => this.#receiver.handle(packet, ack)),
      transport.status$.subscribe((status) => {
        if (status === 'online') this.#outbox.kick();
      }),
    );
    if (transport.onTyping) {
      this.#unsubscribe.push(transport.onTyping((typing) => void this.#onTyping(typing)));
    }
    this.#sweepTimer = setInterval(() => void this.#sweep(), core.settings.expirySweepMs);
    await this.#sweep();
    this.#outbox.start();
    // Removals the server knows of (e.g. while this device was off), in the background.
    if (core.options.api.groups) void this.#groups.syncAll().catch(() => undefined);
  }

  /** Stops listening and waits for in-flight work. The store keeps the outbox for next time. */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    clearInterval(this.#sweepTimer);
    for (const timer of this.#typingTimers.values()) clearTimeout(timer);
    this.#typingTimers.clear();
    this.#receiver.dispose();
    await this.#outbox.stop();
    await this.#receiver.idle();
    await this.#core.mutex.run(() => undefined);
    this.#core.dispose();
  }

  /** Resolves when queued incoming packets are handled (tests and the sim client). */
  idle(): Promise<void> {
    return this.#receiver.idle();
  }

  // Events

  /** Messages added or changed in one conversation, and its typing indicator. */
  subscribe(conversationId: string, listener: (event: ConversationEvent) => void): () => void {
    return this.#core.subscribe(conversationId, listener);
  }

  /** Something in the chat list changed (new message, state, unread count, a group). */
  onConversationListChanged(listener: () => void): () => void {
    return this.#core.onConversationListChanged(listener);
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    return this.#core.events.add(listener);
  }

  // Reads

  listConversations(): Promise<ConversationRecord[]> {
    return this.#core.store.listConversations();
  }

  getConversation(conversationId: string): Promise<ConversationRecord | undefined> {
    return this.#core.store.getConversation(conversationId);
  }

  getMessage(messageId: string): Promise<MessageRecord | undefined> {
    return this.#core.store.getMessage(messageId);
  }

  /** Newest first; pass the last message's `{ sortAt, messageId }` for the next page. */
  listMessages(
    conversationId: string,
    options: { before?: MessageCursor; limit?: number } = {},
  ): Promise<MessageRecord[]> {
    return this.#core.store.listMessages(conversationId, {
      limit: options.limit ?? 50,
      ...(options.before ? { before: options.before } : {}),
    });
  }

  /** "Message info": the state at each device (own devices flagged; they never count). */
  async messageInfo(
    messageId: string,
  ): Promise<{ message: MessageRecord; deliveries: DeliveryRecord[] } | undefined> {
    const message = await this.#core.store.getMessage(messageId);
    if (!message) return undefined;
    return { message, deliveries: await this.#core.store.listDeliveries(messageId) };
  }

  // Conversations and messages

  /** The direct conversation with `peerUserId`, created locally if new. */
  async openDirectConversation(peerUserId: string): Promise<ConversationRecord> {
    const core = this.#core;
    if (peerUserId === core.self.userId)
      throw new Error('cannot open a conversation with yourself');
    return core.mutex.run(async () => {
      const existing = await core.store.getConversation(core.directConversationId(peerUserId));
      if (existing) return existing;
      const conversation = core.newConversation(peerUserId, core.now());
      await core.commit({ conversations: [conversation] });
      return conversation;
    });
  }

  /**
   * Stores the message and queues it; the returned record is `local_queued`. A `replyTo`
   * outside this conversation is dropped.
   */
  async sendText(
    conversationId: string,
    text: string,
    options: { replyTo?: string } = {},
  ): Promise<MessageRecord> {
    const core = this.#core;
    const message = await core.mutex.run(async () => {
      const conversation = await core.store.getConversation(conversationId);
      if (!conversation) throw new Error('unknown conversation');
      const audience = await this.#audience(conversation);
      const quoted = options.replyTo ? await core.store.getMessage(options.replyTo) : undefined;
      const now = core.now();
      const record: MessageRecord = {
        messageId: uuidv7(),
        conversationId,
        senderUserId: core.self.userId,
        senderDeviceId: core.self.deviceId,
        direction: 'out',
        kind: 'text',
        body: text,
        replyTo: quoted?.conversationId === conversationId ? quoted.messageId : null,
        sentAt: now,
        sortAt: now,
        createdAt: now,
        state: MessageState.local_queued,
        expiresAt: now + core.settings.maxRetentionMs,
        editedAt: null,
        editId: null,
        deletedAt: null,
        readAt: now,
        reactions: [],
      };
      // Throws OVERSIZED for text that cannot fit in an envelope: nothing is stored then.
      const content = textContentFor(record, audience.peerUserId, core.settings.envelopeMaxBytes);
      await core.commit({
        messages: [record],
        conversations: [
          {
            ...conversation,
            updatedAt: Math.max(conversation.updatedAt, now),
            lastMessageId: record.messageId,
          },
        ],
        outbox: [this.#fanout(record, audience, content, now)],
      });
      return record;
    });
    this.#outbox.kick();
    return message;
  }

  /** Sends a `failed` message again to the recipient's current devices. */
  async retry(messageId: string): Promise<void> {
    const core = this.#core;
    await core.mutex.run(async () => {
      const message = await core.store.getMessage(messageId);
      if (message?.state !== 'failed' || message.kind !== 'text') return;
      const conversation = await core.store.getConversation(message.conversationId);
      if (!conversation) return;
      const audience = await this.#audience(conversation);
      const now = core.now();
      const deliveries = await core.store.listDeliveries(messageId);
      const queued = (await core.store.listOutbox()).filter((item) => item.messageId === messageId);
      const expiresAt = now + core.settings.maxRetentionMs;
      const retried: MessageRecord = {
        ...message,
        state: advance(message.state, 'local_queued'),
        expiresAt,
      };
      await core.commit({
        messages: [retried],
        deleteDeliveries: deliveries.map((d) => ({ messageId, deviceId: d.deviceId })),
        deleteOutbox: queued.map((item) => item.id),
        outbox: [
          this.#fanout(
            retried,
            audience,
            textContentFor(message, audience.peerUserId, core.settings.envelopeMaxBytes),
            now,
          ),
        ],
      });
    });
    this.#outbox.kick();
  }

  /**
   * The user has the conversation open: its messages are read, the unread count resets and,
   * with read receipts on, each sending device gets a (coalesced) read receipt.
   */
  async markRead(conversationId: string): Promise<void> {
    const core = this.#core;
    const queued = await core.mutex.run(async () => {
      const conversation = await core.store.getConversation(conversationId);
      if (!conversation) return false;
      const unread = await core.store.listUnread(conversationId);
      if (conversation.unreadCount === 0 && unread.length === 0) return false;
      const now = core.now();
      const sendReceipts = core.options.receipts?.('read') ?? false;
      const outbox: ReceiptItem[] = [];
      for (const message of unread) {
        if (!sendReceipts || message.senderDeviceId === '' || message.kind === 'deleted') continue;
        outbox.push({
          type: 'receipt',
          receipt: 'read',
          id: `receipt:read:${message.messageId}:${message.senderDeviceId}`,
          messageId: message.messageId,
          recipientUserId: message.senderUserId,
          recipientDeviceId: message.senderDeviceId,
          createdAt: now,
          expiresAt: now + core.settings.maxRetentionMs,
          attempts: 0,
          nextAttemptAt: now,
        });
      }
      await core.commit({
        conversations: [{ ...conversation, unreadCount: 0 }],
        messages: unread.map((message) => ({ ...message, readAt: now })),
        outbox,
      });
      return outbox.length > 0;
    });
    if (queued) this.#outbox.kick();
  }

  // Edits, deletes and reactions (ADR 0014)

  /** Whether this user may still edit `message` (their own text, inside the window). */
  canEdit(message: MessageRecord): boolean {
    const core = this.#core;
    return canEdit(message, core.self.userId, core.opRules, core.now());
  }

  /** Whether this user may still delete `message` for everyone. */
  canDeleteForEveryone(message: MessageRecord): boolean {
    const core = this.#core;
    return canDeleteForEveryone(message, core.self.userId, core.opRules, core.now());
  }

  /** Replaces the text of this user's message, here and on the other devices. */
  editMessage(messageId: string, text: string): Promise<MessageRecord> {
    if (text.trim() === '') return Promise.reject(new MessageActionError('invalid', 'empty text'));
    return this.#op(messageId, 'edit', (target) => ({
      body: text,
      remove: false,
      content: { case: 'edit', value: { targetMessageId: uuidToBytes(target), body: text } },
    }));
  }

  /**
   * Deletes this user's message for everyone: a tombstone here, and a request to every other
   * copy. Best-effort: it cannot erase copies, screenshots, exports or notifications.
   */
  deleteForEveryone(messageId: string): Promise<MessageRecord> {
    return this.#op(messageId, 'delete', (target) => ({
      body: '',
      remove: false,
      content: { case: 'delete', value: { targetMessageId: uuidToBytes(target) } },
    }));
  }

  /** Sets this user's reaction to `message` (one per user), or withdraws it with `null`. */
  react(messageId: string, emoji: string | null): Promise<MessageRecord> {
    if (emoji !== null && !isValidReaction(emoji)) {
      return Promise.reject(new MessageActionError('invalid', 'not a reaction'));
    }
    return this.#op(messageId, 'reaction', (target) => ({
      body: emoji ?? '',
      remove: emoji === null,
      content: {
        case: 'reaction',
        value: { targetMessageId: uuidToBytes(target), emoji: emoji ?? '', remove: emoji === null },
      },
    }));
  }

  /** Applies an op locally and queues it for the peer's and this user's other devices. */
  async #op(
    messageId: string,
    type: Op['type'],
    make: (targetMessageId: string) => {
      body: string;
      remove: boolean;
      content: Parameters<typeof buildContent>[1];
    },
  ): Promise<MessageRecord> {
    const core = this.#core;
    const changed = await core.mutex.run(async () => {
      const target = await core.store.getMessage(messageId);
      const conversation = target && (await core.store.getConversation(target.conversationId));
      if (!target || !conversation) throw new MessageActionError('not_found', 'no such message');
      const audience = await this.#audience(conversation);
      if (type === 'reaction' && !canReact(target)) {
        throw new MessageActionError('not_allowed', 'cannot react to this message');
      }
      const now = core.now();
      const { body, remove, content } = make(target.messageId);
      const op: Op = {
        opId: uuidv7(),
        type,
        targetMessageId: target.messageId,
        conversationId: target.conversationId,
        senderUserId: core.self.userId,
        sentAt: now,
        body,
        remove,
      };
      const next = applyOp(target, op, core.opRules);
      if (!next) throw new MessageActionError('not_allowed', `${type} is not allowed`);
      // Throws OVERSIZED for an edit that cannot fit in an envelope: nothing is stored then.
      const encoded = buildContent(
        {
          messageId: op.opId,
          conversationId: target.conversationId,
          senderUserId: core.self.userId,
          ...(audience.peerUserId ? { recipientUserId: audience.peerUserId } : {}),
          sentAt: now,
        },
        content,
        core.settings.envelopeMaxBytes,
      );
      const batch: WriteBatch = {
        messages: [next],
        outbox: [this.#controlFanout(op.opId, conversation, audience, encoded, now)],
      };
      if (type === 'delete') {
        // Not sent yet to anyone: the message itself need not go out any more.
        batch.deleteOutbox = (await core.store.listOutbox())
          .filter((item) => item.messageId === messageId && item.type !== 'receipt')
          .map((item) => item.id);
      }
      await core.commit(batch);
      return next;
    });
    this.#outbox.kick();
    return changed;
  }

  /**
   * Deletes messages from this device only ("delete for me"). Others keep their copies; a
   * message still waiting in the outbox is not sent.
   */
  async deleteForMe(messageIds: readonly string[]): Promise<void> {
    const core = this.#core;
    await core.mutex.run(async () => {
      const found = (await Promise.all(messageIds.map((id) => core.store.getMessage(id)))).filter(
        (m): m is MessageRecord => m !== undefined,
      );
      if (found.length === 0) return;
      const ids = new Set(found.map((m) => m.messageId));
      const batch: WriteBatch = {
        deleteMessages: [...ids],
        deleteOutbox: (await core.store.listOutbox())
          .filter((item) => ids.has(item.messageId) && item.type !== 'receipt')
          .map((item) => item.id),
        conversations: [],
      };
      for (const conversationId of new Set(found.map((m) => m.conversationId))) {
        const conversation = await core.store.getConversation(conversationId);
        if (!conversation) continue;
        const removedUnread = found.filter(
          (m) => m.conversationId === conversationId && m.direction === 'in' && m.readAt === null,
        ).length;
        let { lastMessageId } = conversation;
        if (lastMessageId && ids.has(lastMessageId)) {
          const recent = await core.store.listMessages(conversationId, { limit: ids.size + 1 });
          lastMessageId = recent.find((m) => !ids.has(m.messageId))?.messageId ?? null;
        }
        batch.conversations!.push({
          ...conversation,
          lastMessageId,
          unreadCount: Math.max(0, conversation.unreadCount - removedUnread),
        });
      }
      await core.commit(batch);
      for (const conversationId of new Set(found.map((m) => m.conversationId))) {
        core.emitConversation(conversationId, {
          type: 'removed',
          messageIds: found
            .filter((m) => m.conversationId === conversationId)
            .map((m) => m.messageId),
        });
      }
    });
  }

  // Conversations (local only)

  /**
   * Deletes the conversation from this device: its messages, their states and anything of
   * it still queued. Other devices and the peer keep their copies.
   */
  async deleteConversation(conversationId: string): Promise<void> {
    const core = this.#core;
    await core.mutex.run(async () => {
      const conversation = await core.store.getConversation(conversationId);
      if (!conversation) return;
      const group =
        conversation.kind === 'group' ? await core.store.getGroup(conversationId) : undefined;
      if (group && !group.left) {
        throw new MessageActionError('not_allowed', 'leave the group before deleting its chat');
      }
      const queued: OutboxItem[] = [];
      for (const item of await core.store.listOutbox()) {
        if (item.type === 'fanout') {
          if (item.conversationId === conversationId) queued.push(item);
        } else if (item.type === 'device' && item.purpose === 'message') {
          const message = await core.store.getMessage(item.messageId);
          if (message?.conversationId === conversationId) queued.push(item);
        }
      }
      await core.commit({
        deleteConversations: [conversationId],
        deleteOutbox: queued.map((item) => item.id),
        ...(group ? { deleteGroups: [conversationId] } : {}),
      });
    });
  }

  setArchived(conversationId: string, archived: boolean): Promise<void> {
    return this.#updateConversation(conversationId, () => ({ archived }));
  }

  setPinned(conversationId: string, pinned: boolean): Promise<void> {
    return this.#updateConversation(conversationId, (now) => ({ pinnedAt: pinned ? now : null }));
  }

  /** Mutes until `until` (`MUTED_FOREVER` for always), or unmutes with null. */
  setMuted(conversationId: string, until: number | null): Promise<void> {
    return this.#updateConversation(conversationId, () => ({ mutedUntil: until }));
  }

  async #updateConversation(
    conversationId: string,
    change: (now: number) => Partial<ConversationRecord>,
  ): Promise<void> {
    const core = this.#core;
    await core.mutex.run(async () => {
      const conversation = await core.store.getConversation(conversationId);
      if (!conversation) return;
      await core.commit({ conversations: [{ ...conversation, ...change(core.now()) }] });
    });
  }

  // Search

  /** Text messages matching every term as a word prefix, newest first (ADR 0014). */
  search(
    query: string,
    options: { conversationId?: string; limit?: number } = {},
  ): Promise<MessageRecord[]> {
    return this.#core.store.searchMessages(query, {
      limit: options.limit ?? 50,
      ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    });
  }

  /** The recipients of a conversation's messages; a group this user left takes none. */
  async #audience(conversation: ConversationRecord): Promise<Audience> {
    const core = this.#core;
    if (conversation.kind === 'direct') {
      return {
        recipientUserIds: [conversation.peerUserId, core.self.userId],
        peerUserId: conversation.peerUserId,
      };
    }
    const group = await core.store.getGroup(conversation.conversationId);
    if (!group || group.left) {
      throw new MessageActionError('not_allowed', 'not a member of this group');
    }
    return { recipientUserIds: group.members.map((m) => m.userId), groupId: group.groupId };
  }

  #controlFanout(
    opId: string,
    conversation: ConversationRecord,
    audience: Audience,
    content: Uint8Array,
    now: number,
  ): FanoutItem {
    return {
      type: 'fanout',
      purpose: 'control',
      id: opId,
      messageId: opId,
      conversationId: conversation.conversationId,
      recipientUserIds: audience.recipientUserIds,
      ...(audience.groupId ? { groupId: audience.groupId } : {}),
      content,
      createdAt: now,
      expiresAt: now + this.#core.settings.maxRetentionMs,
      attempts: 0,
      nextAttemptAt: now,
    };
  }

  #fanout(
    message: MessageRecord,
    audience: Audience,
    content: Uint8Array,
    now: number,
  ): FanoutItem {
    return {
      type: 'fanout',
      id: message.messageId,
      messageId: message.messageId,
      conversationId: message.conversationId,
      recipientUserIds: audience.recipientUserIds,
      ...(audience.groupId ? { groupId: audience.groupId } : {}),
      content,
      createdAt: now,
      expiresAt: message.expiresAt ?? now + this.#core.settings.maxRetentionMs,
      attempts: 0,
      nextAttemptAt: now,
    };
  }

  // Groups (ADR 0016)

  /** Creates a group on the server and tells the members; this user is the owner. */
  createGroup(input: GroupInfo & { memberUserIds: string[] }): Promise<ConversationRecord> {
    return this.#groups.create(input);
  }

  getGroup(groupId: string): Promise<GroupRecord | undefined> {
    return this.#core.store.getGroup(groupId);
  }

  /** Admins and the owner. */
  addGroupMembers(groupId: string, userIds: string[]): Promise<void> {
    return this.#groups.addMembers(groupId, userIds);
  }

  /** Admins remove plain members, the owner anyone; removing oneself is leaving. */
  removeGroupMember(groupId: string, userId: string): Promise<void> {
    return this.#groups.removeMember(groupId, userId);
  }

  /** The chat stays on this device, read-only. */
  leaveGroup(groupId: string): Promise<void> {
    return this.#groups.leave(groupId);
  }

  /** The owner only. */
  setGroupRole(groupId: string, userId: string, role: 'admin' | 'member'): Promise<void> {
    return this.#groups.setRole(groupId, userId, role);
  }

  /** Name, description and picture (E2EE only); admins and the owner. */
  updateGroupInfo(groupId: string, info: GroupInfo): Promise<void> {
    return this.#groups.updateInfo(groupId, info);
  }

  /** Applies the server's view of a group (call it on the transport's `group_changed`). */
  syncGroup(groupId: string): Promise<void> {
    return this.#groups.sync(groupId);
  }

  // Contacts and keys

  /** Fetches and verifies a user's devices now (new devices get new messages from now on). */
  async refreshDevices(userId: string): Promise<DirectoryRecord | undefined> {
    const lookup = await this.#core.refreshDirectory(userId);
    return lookup.status === 'ok' ? lookup.record : undefined;
  }

  async contact(userId: string): Promise<ContactInfo> {
    const directory = await this.#core.store.getDirectory(userId);
    return {
      directory,
      verified:
        directory?.accountIdentityKey != null &&
        directory.verifiedIdentityKey === directory.accountIdentityKey,
    };
  }

  /**
   * Marks the contact verified, if `accountIdentityKey` (from their QR code) is the key the
   * directory vouches for. False when it is not: the safety numbers do not match.
   */
  async markVerified(userId: string, accountIdentityKey: string): Promise<boolean> {
    const core = this.#core;
    return core.mutex.run(async () => {
      const directory = await core.store.getDirectory(userId);
      if (!directory?.accountIdentityKey || directory.accountIdentityKey !== accountIdentityKey) {
        return false;
      }
      await core.commit({ directory: [{ ...directory, verifiedIdentityKey: accountIdentityKey }] });
      return true;
    });
  }

  /**
   * Tops up this device's one-time keys (on `OtkLow` and at start) and rotates the fallback
   * key weekly. With `ensureFallback` (at start) it first asks the directory whether this
   * device's fallback key is published, so an interrupted first upload heals. Run every
   * account change through the engine while it runs: it serializes them with decryption.
   */
  async replenishKeys(
    options: { ensureFallback?: boolean } = {},
  ): Promise<PublishKeysResult | undefined> {
    const core = this.#core;
    const keys = core.options.api.keys;
    if (!keys) return undefined;
    return core.mutex.run(async () => {
      const now = core.now();
      const rotatedAt = await core.store.getSetting(FALLBACK_ROTATED_AT);
      const rotate = typeof rotatedAt === 'number' && now - rotatedAt > FALLBACK_KEY_MAX_AGE_MS;
      const needsFallbackKey = options.ensureFallback
        ? !(await core.options.api.directory(core.self.userId)).devices.find(
            (d) => d.deviceId === core.self.deviceId,
          )?.fallbackKey
        : false;
      const result = await publishKeys({
        account: core.options.account,
        deviceId: core.self.deviceId,
        keys,
        saveAccount: () => core.store.apply({ account: core.accountPickle() }),
        rotateFallbackKey: rotate,
        needsFallbackKey,
      });
      if (rotate || typeof rotatedAt !== 'number') {
        await core.store.apply({ settings: { [FALLBACK_ROTATED_AT]: now } });
      }
      return result;
    });
  }

  // Typing

  /** Tells the peer's devices this user is (no longer) typing; nothing when the toggle is off. */
  async setTyping(conversationId: string, active: boolean): Promise<void> {
    const core = this.#core;
    if (!(core.options.typingIndicators?.() ?? true)) return;
    const now = core.now();
    const last = this.#typingSentAt.get(conversationId) ?? 0;
    if (active && now - last < TYPING_REFRESH_MS) return;
    const conversation = await core.store.getConversation(conversationId);
    // Typing in groups is not relayed (ADR 0016).
    if (conversation?.kind !== 'direct') return;
    const directory = await core.store.getDirectory(conversation.peerUserId);
    const recipientDeviceIds = directory?.devices.map((d) => d.deviceId) ?? [];
    if (recipientDeviceIds.length === 0) return;
    const sent =
      core.options.transport.sendTyping?.({ recipientDeviceIds, senderDeviceId: '', active }) ??
      false;
    if (sent && active) this.#typingSentAt.set(conversationId, now);
    if (!active) this.#typingSentAt.delete(conversationId);
  }

  async #onTyping(typing: { senderDeviceId: string; active: boolean; groupId?: string }) {
    const core = this.#core;
    if (!(core.options.typingIndicators?.() ?? true) || typing.groupId) return;
    const userId = await core.store.findDeviceOwner(typing.senderDeviceId);
    if (!userId || userId === core.self.userId || core.isBlocked(userId)) return;
    const conversationId = core.directConversationId(userId);
    clearTimeout(this.#typingTimers.get(conversationId));
    this.#typingTimers.delete(conversationId);
    core.emitConversation(conversationId, { type: 'typing', userId, active: typing.active });
    if (!typing.active) return;
    // A lost "stopped typing" must not leave the indicator on.
    this.#typingTimers.set(
      conversationId,
      setTimeout(() => {
        this.#typingTimers.delete(conversationId);
        core.emitConversation(conversationId, { type: 'typing', userId, active: false });
      }, core.settings.typingTimeoutMs),
    );
  }

  // Housekeeping

  /** A crash mid-send leaves deliveries `sending`: they are queued again. */
  async #recover(): Promise<void> {
    const core = this.#core;
    await core.mutex.run(async () => {
      const now = core.now();
      const batch: WriteBatch = { deliveries: [], messages: [] };
      for (const item of await core.store.listOutbox()) {
        if (item.type !== 'device' || item.purpose !== 'message') continue;
        const row = (await core.store.listDeliveries(item.messageId)).find(
          (d) => d.deviceId === item.recipientDeviceId,
        );
        if (row?.state !== 'sending') continue;
        const moved = EngineCore.moved(row, 'local_queued', now);
        if (!moved) continue;
        batch.deliveries!.push(moved);
        const message = await core.restate(item.messageId, [moved]);
        if (message) batch.messages!.push(message);
      }
      if (batch.deliveries!.length > 0) await core.commit(batch);
    });
  }

  /**
   * Expires undelivered messages past their deadline, and prunes old seen IDs and pending
   * ops (no target can arrive after its envelope would have expired).
   */
  async #sweep(): Promise<void> {
    const core = this.#core;
    try {
      await core.mutex.run(async () => {
        const now = core.now();
        const expiring = await core.store.listExpiring(now);
        const horizon = now - core.settings.maxRetentionMs - SEEN_MARGIN_MS;
        const batch: WriteBatch = {
          messages: [],
          deliveries: [],
          deleteOutbox: [],
          pruneSeenBefore: horizon,
          pruneOpsBefore: horizon,
          pruneHeldBefore: horizon,
        };
        if (expiring.length > 0) {
          const outbox = await core.store.listOutbox();
          for (const message of expiring) {
            const state = advance(message.state!, 'expired_undelivered');
            if (state !== message.state) batch.messages!.push({ ...message, state });
            for (const row of await core.store.listDeliveries(message.messageId)) {
              if (SETTLED_STATES.includes(row.state)) continue;
              const moved = EngineCore.moved(row, 'expired_undelivered', now);
              if (moved) batch.deliveries!.push(moved);
            }
            for (const item of outbox) {
              if (item.messageId === message.messageId && item.type !== 'receipt') {
                batch.deleteOutbox!.push(item.id);
              }
            }
          }
        }
        await core.commit(batch);
      });
      await this.#receiver.requestMissingKeys();
    } catch (error) {
      core.log('error', 'expiry sweep failed', { error: String(error) });
    }
  }
}
