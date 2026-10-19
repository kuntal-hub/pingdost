/**
 * The message engine (REQ §4.3, §8): platform- and transport-neutral. A UI talks only to
 * this class; storage comes in as an `EngineStore`, the network as a transport (router) and
 * the key directory API.
 *
 * - `sendText` stores the message (UUIDv7) and its outbox entry before any network call.
 * - States follow REQ §8.3: "delivered" only on an E2EE receipt from a recipient device.
 * - Messages without a receipt by createdAt + max retention become `expired_undelivered`.
 * - Typing is transient: relayed in memory, never stored, and off with the privacy toggle.
 */
import { uuidv7 } from '@pingdost/protocol';
import { MessageState } from '@pingdost/shared-types';

import { textContentFor } from './content';
import { EngineCore, type ConversationEvent, type EngineEvent, type EngineOptions } from './core';
import { FALLBACK_KEY_MAX_AGE_MS, publishKeys, type PublishKeysResult } from './keys';
import { Outbox } from './outbox';
import { Receiver } from './receive';
import { advance, SETTLED_STATES } from './states';
import type {
  ConversationRecord,
  DeliveryRecord,
  DirectoryRecord,
  FanoutItem,
  MessageCursor,
  MessageRecord,
  WriteBatch,
} from './store';

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
  readonly #unsubscribe: (() => void)[] = [];
  #sweepTimer: ReturnType<typeof setInterval> | undefined;
  readonly #typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #typingSentAt = new Map<string, number>();
  #started = false;

  constructor(options: EngineOptions) {
    this.#core = new EngineCore(options);
    this.#outbox = new Outbox(this.#core);
    this.#receiver = new Receiver(this.#core, this.#outbox);
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
  }

  /** Stops listening and waits for in-flight work. The store keeps the outbox for next time. */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    clearInterval(this.#sweepTimer);
    for (const timer of this.#typingTimers.values()) clearTimeout(timer);
    this.#typingTimers.clear();
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

  /** Something in the chat list changed (new message, state, unread count). */
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

  /** Stores the message and queues it; the returned record is `local_queued`. */
  async sendText(
    conversationId: string,
    text: string,
    options: { replyTo?: string } = {},
  ): Promise<MessageRecord> {
    const core = this.#core;
    const message = await core.mutex.run(async () => {
      const conversation = await core.store.getConversation(conversationId);
      if (!conversation) throw new Error('unknown conversation');
      const now = core.now();
      const record: MessageRecord = {
        messageId: uuidv7(),
        conversationId,
        senderUserId: core.self.userId,
        senderDeviceId: core.self.deviceId,
        direction: 'out',
        kind: 'text',
        body: text,
        replyTo: options.replyTo ?? null,
        sentAt: now,
        sortAt: now,
        createdAt: now,
        state: MessageState.local_queued,
        expiresAt: now + core.settings.maxRetentionMs,
      };
      // Throws OVERSIZED for text that cannot fit in an envelope: nothing is stored then.
      const content = textContentFor(
        record,
        conversation.peerUserId,
        core.settings.envelopeMaxBytes,
      );
      await core.commit({
        messages: [record],
        conversations: [
          {
            ...conversation,
            updatedAt: Math.max(conversation.updatedAt, now),
            lastMessageId: record.messageId,
          },
        ],
        outbox: [this.#fanout(record, conversation.peerUserId, content, now)],
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
            conversation.peerUserId,
            textContentFor(message, conversation.peerUserId, core.settings.envelopeMaxBytes),
            now,
          ),
        ],
      });
    });
    this.#outbox.kick();
  }

  /** The user opened the conversation: its unread count resets (read receipts: Phase 11). */
  async markRead(conversationId: string): Promise<void> {
    const core = this.#core;
    await core.mutex.run(async () => {
      const conversation = await core.store.getConversation(conversationId);
      if (!conversation || conversation.unreadCount === 0) return;
      await core.commit({ conversations: [{ ...conversation, unreadCount: 0 }] });
    });
  }

  #fanout(
    message: MessageRecord,
    peerUserId: string,
    content: Uint8Array,
    now: number,
  ): FanoutItem {
    return {
      type: 'fanout',
      id: message.messageId,
      messageId: message.messageId,
      conversationId: message.conversationId,
      recipientUserIds: [peerUserId, this.#core.self.userId],
      content,
      createdAt: now,
      expiresAt: message.expiresAt ?? now + this.#core.settings.maxRetentionMs,
      attempts: 0,
      nextAttemptAt: now,
    };
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
    if (!conversation) return;
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
    if (!userId || userId === core.self.userId) return;
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

  /** Expires undelivered messages past their deadline, and prunes old seen IDs. */
  async #sweep(): Promise<void> {
    const core = this.#core;
    try {
      await core.mutex.run(async () => {
        const now = core.now();
        const expiring = await core.store.listExpiring(now);
        const batch: WriteBatch = {
          messages: [],
          deliveries: [],
          deleteOutbox: [],
          pruneSeenBefore: now - core.settings.maxRetentionMs - SEEN_MARGIN_MS,
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
    } catch (error) {
      core.log('error', 'expiry sweep failed', { error: String(error) });
    }
  }
}
