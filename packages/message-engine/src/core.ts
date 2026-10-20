/**
 * State and helpers shared by the engine's parts: options, the lock, atomic commits with
 * change events, aggregate message states and the verified directory cache.
 *
 * Locking: every operation that touches Olm state or writes the store runs inside
 * `mutex.run`. Network calls (directory fetches, key claims, sends) run outside it, so a slow
 * server never stalls the receive pipeline. The mutex is not re-entrant: helpers that take it
 * themselves (`refreshDirectory`, `ownerOf`) must not be called while holding it.
 */
import { DEFAULT_LIMITS } from '@pingdost/config/public';
import type { CryptoProvider, OlmAccount } from '@pingdost/crypto/core';
import { directConversationIdFor, uuidv7 } from '@pingdost/protocol';
import type { Group, MessageState } from '@pingdost/shared-types';
import { Listeners, type BackoffOptions, type Transport } from '@pingdost/transport';

import { diffDirectory, isNotFound, verifyDirectory, type DirectoryApi } from './directory';
import { GroupSessionManager } from './groups/megolm';
import type { PublishKeysDeps } from './keys';
import { Mutex } from './mutex';
import { SessionManager } from './sessions';
import { nextGroupState, nextMessageState, SETTLED_STATES } from './states';
import type {
  ConversationRecord,
  DeliveryRecord,
  DirectoryDeviceRecord,
  DirectoryRecord,
  EngineStore,
  MessageRecord,
  WriteBatch,
} from './store';

export type EngineTransport = Pick<
  Transport,
  'status$' | 'send' | 'onPacket' | 'sendTyping' | 'onTyping'
>;

/** The group calls the engine makes (`@pingdost/api-client`'s `groupsApi` fits). */
export interface GroupsApi {
  create(groupId: string, memberUserIds: string[]): Promise<Group>;
  list(): Promise<Group[]>;
  get(groupId: string): Promise<Group>;
  addMembers(groupId: string, userIds: string[]): Promise<Group>;
  removeMember(groupId: string, userId: string): Promise<Group>;
  setRole(groupId: string, userId: string, role: 'admin' | 'member'): Promise<Group>;
}

export interface EngineSettings {
  /** `MESSAGE_MAX_RETENTION_SECONDS` in ms: the packet expiry and the expiry deadline. */
  maxRetentionMs: number;
  /** `ENVELOPE_MAX_BYTES`. */
  envelopeMaxBytes: number;
  /** A cached directory older than this is refetched before a fan-out. */
  directoryMaxAgeMs: number;
  /** Delays between attempts after a retryable failure. */
  retry: BackoffOptions;
  /** Envelopes awaiting the server's answer at once (the gateway allows 64). */
  maxInflight: number;
  /** Receipts wait this long so that one Content can acknowledge a whole burst. */
  receiptDelayMs: number;
  /** How often expired messages are looked for. */
  expirySweepMs: number;
  /** At most one session reset per remote device in this window. */
  sessionResetIntervalMs: number;
  /** An incoming typing indicator lapses after this without a refresh. */
  typingTimeoutMs: number;
  /** How long after sending a message may be edited (sender and receivers enforce it). */
  editWindowMs: number;
  /** How long after sending a message may be deleted for everyone. */
  deleteWindowMs: number;
  /** A Megolm session is replaced after this many messages (ADR 0003). */
  groupRotationMessages: number;
  /** ... or after this long. */
  groupRotationMs: number;
  /** A group message whose key is missing this long makes this device ask the sender. */
  roomKeyRequestDelayMs: number;
  /** At most one key request per held session in this window. */
  roomKeyRequestIntervalMs: number;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  maxRetentionMs: DEFAULT_LIMITS.messageMaxRetentionSeconds * 1000,
  envelopeMaxBytes: DEFAULT_LIMITS.envelopeMaxBytes,
  directoryMaxAgeMs: 5 * 60_000,
  retry: { baseMs: 2_000, maxMs: 5 * 60_000 },
  maxInflight: 16,
  receiptDelayMs: 200,
  expirySweepMs: 60_000,
  sessionResetIntervalMs: 5 * 60_000,
  typingTimeoutMs: 6_000,
  editWindowMs: DEFAULT_LIMITS.messageEditWindowSeconds * 1000,
  deleteWindowMs: DEFAULT_LIMITS.messageDeleteWindowSeconds * 1000,
  groupRotationMessages: 100,
  groupRotationMs: 7 * 86_400_000,
  roomKeyRequestDelayMs: 10_000,
  roomKeyRequestIntervalMs: 5 * 60_000,
};

/** Never pass plaintext, keys or ciphertext (ARCHITECTURE A10): IDs and counts only. */
export type EngineLogger = (
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, string | number | boolean>,
) => void;

export interface EngineOptions {
  self: {
    userId: string;
    deviceId: string;
    /** This account's identity key; own devices are trusted only under it. */
    accountIdentityKey?: string;
  };
  crypto: CryptoProvider;
  /** The device's Olm account; the engine re-pickles it whenever it changes. */
  account: OlmAccount;
  pickleKey: Uint8Array;
  store: EngineStore;
  transport: EngineTransport;
  /**
   * Key directory calls; `keys` lets the engine top up one-time keys; `groups` (`/v1/groups`)
   * is needed for group chats.
   */
  api: DirectoryApi & { keys?: PublishKeysDeps['keys']; groups?: GroupsApi };
  now?: () => number;
  settings?: Partial<EngineSettings>;
  /**
   * Whether to send E2EE receipts of this type; default: delivered yes, read no. Read is
   * reciprocal: when false, incoming read receipts count only as delivery receipts.
   */
  receipts?: (type: 'delivered' | 'read') => boolean;
  /** The privacy toggle: when false, typing is neither sent nor shown. Default true. */
  typingIndicators?: () => boolean;
  /**
   * Users this user blocked: whatever they still send (queued before the block; the server
   * drops the rest) is dropped unread, without a receipt. Typing from them is ignored.
   */
  blocked?: (userId: string) => boolean;
  log?: EngineLogger;
}

export type ConversationEvent =
  /** A message was added or changed. */
  | { type: 'message'; message: MessageRecord }
  /** Messages were deleted from this device ("delete for me"). */
  | { type: 'removed'; messageIds: string[] }
  | { type: 'typing'; userId: string; active: boolean };

export type EngineEvent =
  /** The user's account identity key changed: a new safety number, verification reset. */
  | { type: 'identity_changed'; userId: string }
  /** A message from this device could not be decrypted; a session reset was requested. */
  | { type: 'decrypt_failed'; userId: string; deviceId: string }
  /**
   * A new message from another user was stored and is unread: once per message, after it is
   * committed (not for edits, reactions, or copies from this user's other devices). Apps use
   * it for local notifications (Phase 12).
   */
  | { type: 'received'; message: MessageRecord };

export type DirectoryLookup =
  { status: 'ok'; record: DirectoryRecord } | { status: 'not_found' } | { status: 'unavailable' };

export type OwnerLookup =
  | { status: 'ok'; userId: string; device: DirectoryDeviceRecord }
  | { status: 'unknown' }
  | { status: 'unavailable' };

export class EngineCore {
  readonly settings: EngineSettings;
  readonly mutex = new Mutex();
  readonly sessions: SessionManager;
  readonly groupSessions: GroupSessionManager;
  /** Refreshes a group from the server (set by the engine; parts call it without the lock). */
  groupSync: ((groupId: string) => Promise<void>) | undefined;
  readonly events = new Listeners<[EngineEvent]>();
  readonly #conversationListeners = new Map<string, Listeners<[ConversationEvent]>>();
  readonly #listListeners = new Listeners<[]>();
  #listTimer: ReturnType<typeof setTimeout> | undefined;
  /** Directory fetches in progress, so concurrent callers share one. */
  readonly #refreshing = new Map<string, Promise<DirectoryLookup>>();

  constructor(readonly options: EngineOptions) {
    this.settings = { ...DEFAULT_ENGINE_SETTINGS, ...options.settings };
    this.sessions = new SessionManager(
      options.crypto,
      options.account,
      options.pickleKey,
      options.store,
    );
    this.groupSessions = new GroupSessionManager(options.crypto, options.pickleKey);
  }

  get store(): EngineStore {
    return this.options.store;
  }

  get self(): EngineOptions['self'] {
    return this.options.self;
  }

  now(): number {
    return (this.options.now ?? Date.now)();
  }

  log(...args: Parameters<EngineLogger>): void {
    this.options.log?.(...args);
  }

  accountPickle(): string {
    return this.options.account.pickle(this.options.pickleKey);
  }

  /** The direct conversation with `peerUserId`. */
  directConversationId(peerUserId: string): string {
    return directConversationIdFor(this.self.userId, peerUserId);
  }

  /**
   * Writes the batch, then tells listeners about the messages and conversations in it. If the
   * write fails, cached sessions in the batch are dropped so they match the store again.
   */
  async commit(batch: WriteBatch): Promise<void> {
    try {
      await this.store.apply(batch);
    } catch (error) {
      for (const session of batch.sessions ?? []) this.sessions.forget(session.sessionId);
      for (const session of batch.outboundGroupSessions ?? []) this.groupSessions.forget(session);
      for (const session of batch.inboundGroupSessions ?? []) this.groupSessions.forget(session);
      throw error;
    }
    for (const message of batch.messages ?? []) {
      this.#conversationListeners.get(message.conversationId)?.emit({ type: 'message', message });
    }
    if (
      batch.messages?.length ||
      batch.conversations?.length ||
      batch.deleteMessages?.length ||
      batch.deleteConversations?.length ||
      batch.groups?.length ||
      batch.deleteGroups?.length
    ) {
      this.#listChanged();
    }
  }

  /** The rules every device applies to edits and deletes. */
  get opRules(): { editWindowMs: number; deleteWindowMs: number } {
    return {
      editWindowMs: this.settings.editWindowMs,
      deleteWindowMs: this.settings.deleteWindowMs,
    };
  }

  isBlocked(userId: string): boolean {
    return userId !== this.self.userId && (this.options.blocked?.(userId) ?? false);
  }

  subscribe(conversationId: string, listener: (event: ConversationEvent) => void): () => void {
    let listeners = this.#conversationListeners.get(conversationId);
    if (!listeners) {
      listeners = new Listeners();
      this.#conversationListeners.set(conversationId, listeners);
    }
    const remove = listeners.add(listener);
    return () => {
      remove();
      if (listeners.size === 0) this.#conversationListeners.delete(conversationId);
    };
  }

  emitConversation(conversationId: string, event: ConversationEvent): void {
    this.#conversationListeners.get(conversationId)?.emit(event);
  }

  onConversationListChanged(listener: () => void): () => void {
    return this.#listListeners.add(listener);
  }

  /** Coalesces list notifications: a burst of changes reloads the chat list once. */
  #listChanged(): void {
    this.#listTimer ??= setTimeout(() => {
      this.#listTimer = undefined;
      this.#listListeners.emit();
    }, 30);
  }

  dispose(): void {
    clearTimeout(this.#listTimer);
    this.sessions.dispose();
    this.groupSessions.dispose();
  }

  /**
   * The message with its state recomputed from its deliveries, where `changed` overrides
   * stored rows and `removed` hides them. Undefined when the state stays.
   */
  async restate(
    messageId: string,
    changed: readonly DeliveryRecord[] = [],
    removed: readonly string[] = [],
    base?: MessageRecord,
  ): Promise<MessageRecord | undefined> {
    const message = base ?? (await this.store.getMessage(messageId));
    if (message?.state == null || message.direction !== 'out') return undefined;
    const rows = new Map(
      (await this.store.listDeliveries(messageId)).map((row) => [row.deviceId, row]),
    );
    for (const deviceId of removed) rows.delete(deviceId);
    for (const row of changed) if (row.messageId === messageId) rows.set(row.deviceId, row);
    const deliveries = [...rows.values()];
    const group = (await this.store.getConversation(message.conversationId))?.kind === 'group';
    let state = group
      ? nextGroupState(message.state, deliveries)
      : nextMessageState(message.state, deliveries);
    // Every recipient device is gone (revoked) and none confirmed: it cannot be delivered.
    if (
      removed.length > 0 &&
      !deliveries.some((row) => !row.own) &&
      !SETTLED_STATES.includes(state)
    ) {
      state = nextMessageState(state, [
        { messageId, deviceId: '', userId: '', own: false, state: 'failed', updatedAt: 0 },
      ]);
    }
    return state === message.state ? undefined : { ...message, state };
  }

  /** A delivery row moved to `state`, if the transition is legal. */
  static moved(row: DeliveryRecord, state: MessageState, now: number): DeliveryRecord | undefined {
    const next = nextMessageState(row.state, [{ ...row, own: false, state }]);
    return next === row.state ? undefined : { ...row, state: next, updatedAt: now };
  }

  // Directory

  /** The cached directory, refetched when older than `maxAgeMs`. */
  async directoryFor(userId: string, maxAgeMs: number): Promise<DirectoryLookup> {
    const cached = await this.store.getDirectory(userId);
    if (cached && this.now() - cached.fetchedAt <= maxAgeMs)
      return { status: 'ok', record: cached };
    const fresh = await this.refreshDirectory(userId);
    // Offline: keep using what was verified before.
    if (fresh.status === 'unavailable' && cached) return { status: 'ok', record: cached };
    return fresh;
  }

  /** Fetches, verifies and caches a user's directory, handling removed devices and key changes. */
  refreshDirectory(userId: string): Promise<DirectoryLookup> {
    let running = this.#refreshing.get(userId);
    if (!running) {
      running = this.#refresh(userId).finally(() => this.#refreshing.delete(userId));
      this.#refreshing.set(userId, running);
    }
    return running;
  }

  async #refresh(userId: string): Promise<DirectoryLookup> {
    let response;
    try {
      response = await this.options.api.directory(userId);
    } catch (error) {
      return isNotFound(error) ? { status: 'not_found' } : { status: 'unavailable' };
    }
    const { record, rejected } = verifyDirectory(this.options.crypto, response, this.now());
    if (rejected > 0) this.log('warn', 'directory devices failed verification', { rejected });
    const expectedKey = this.self.accountIdentityKey;
    if (userId === this.self.userId && expectedKey && record.accountIdentityKey !== expectedKey) {
      // Our own account key is known locally: a different one means the directory lies.
      this.log('error', 'own account identity key differs from the directory');
      record.devices = [];
    }

    const notices: { userId: string }[] = [];
    const next = await this.mutex.run(async () => {
      const previous = await this.store.getDirectory(userId);
      const change = diffDirectory(previous, record);
      const stored: DirectoryRecord = {
        ...record,
        verifiedIdentityKey: change.identityChanged
          ? null
          : (previous?.verifiedIdentityKey ?? null),
      };
      const batch: WriteBatch = { directory: [stored] };
      if (change.identityChanged && userId !== this.self.userId) {
        await this.#addNotice(batch, userId);
        notices.push({ userId });
      }
      if (change.removed.length > 0) await this.#dropDevices(batch, change.removed);
      await this.commit(batch);
      return stored;
    });
    for (const notice of notices) this.events.emit({ type: 'identity_changed', ...notice });
    return { status: 'ok', record: next };
  }

  /**
   * "Safety number changed", in the conversation with `userId` if there is one, and in every
   * group they share with this user ("security code changed for …").
   */
  async #addNotice(batch: WriteBatch, userId: string): Promise<void> {
    const conversations: ConversationRecord[] = [];
    const direct = await this.store.getConversation(this.directConversationId(userId));
    if (direct) conversations.push(direct);
    for (const group of await this.store.listGroups()) {
      if (group.left || !group.members.some((m) => m.userId === userId)) continue;
      const conversation = await this.store.getConversation(group.groupId);
      if (conversation) conversations.push(conversation);
    }
    for (const conversation of conversations) this.#addNoticeTo(batch, conversation, userId);
  }

  #addNoticeTo(batch: WriteBatch, conversation: ConversationRecord, userId: string): void {
    const now = this.now();
    const notice: MessageRecord = {
      messageId: uuidv7(),
      conversationId: conversation.conversationId,
      senderUserId: userId,
      senderDeviceId: '',
      direction: 'in',
      kind: 'system',
      body: 'safety_number_changed',
      attachment: null,
      replyTo: null,
      sentAt: now,
      sortAt: now,
      createdAt: now,
      state: null,
      expiresAt: null,
      editedAt: null,
      editId: null,
      deletedAt: null,
      readAt: now,
      reactions: [],
    };
    (batch.messages ??= []).push(notice);
    (batch.conversations ??= []).push({
      ...conversation,
      updatedAt: Math.max(conversation.updatedAt, now),
      lastMessageId: notice.messageId,
    });
  }

  /** Removed (revoked) devices get nothing more: their queued envelopes are dropped. */
  async #dropDevices(batch: WriteBatch, removed: DirectoryDeviceRecord[]): Promise<void> {
    const gone = new Set(removed.map((d) => d.deviceId));
    const outbox = await this.store.listOutbox();
    const affected = new Map<string, string[]>();
    for (const item of outbox) {
      if (item.type === 'fanout' || !gone.has(item.recipientDeviceId)) continue;
      (batch.deleteOutbox ??= []).push(item.id);
    }
    for (const deviceId of gone) {
      const rows = await this.store.listDeliveriesTo(deviceId, [
        'local_queued',
        'sending',
        'waiting_for_nearby_route',
        'failed',
      ]);
      for (const row of rows) {
        (batch.deleteDeliveries ??= []).push({ messageId: row.messageId, deviceId });
        affected.set(row.messageId, [...(affected.get(row.messageId) ?? []), deviceId]);
      }
    }
    for (const [messageId, devices] of affected) {
      const message = await this.restate(messageId, [], devices);
      if (message) (batch.messages ??= []).push(message);
    }
  }

  /** Who owns `deviceId`, from the cache or else the server (then verified via the directory). */
  async ownerOf(deviceId: string): Promise<OwnerLookup> {
    const cachedOwner = await this.store.findDeviceOwner(deviceId);
    if (cachedOwner) {
      const device = (await this.store.getDirectory(cachedOwner))?.devices.find(
        (d) => d.deviceId === deviceId,
      );
      if (device) return { status: 'ok', userId: cachedOwner, device };
    }
    let userId: string;
    try {
      userId = (await this.options.api.deviceOwner(deviceId)).userId;
    } catch (error) {
      return isNotFound(error) ? { status: 'unknown' } : { status: 'unavailable' };
    }
    const lookup = await this.refreshDirectory(userId);
    if (lookup.status === 'unavailable') return lookup;
    const device =
      lookup.status === 'ok'
        ? lookup.record.devices.find((d) => d.deviceId === deviceId)
        : undefined;
    return device ? { status: 'ok', userId, device } : { status: 'unknown' };
  }

  /** A new direct conversation record (not stored). */
  newConversation(peerUserId: string, now: number): ConversationRecord {
    return {
      conversationId: this.directConversationId(peerUserId),
      kind: 'direct',
      peerUserId,
      createdAt: now,
      updatedAt: now,
      lastMessageId: null,
      unreadCount: 0,
      pinnedAt: null,
      archived: false,
      mutedUntil: null,
    };
  }

  /** A new group conversation record (not stored); its ID is the group ID. */
  newGroupConversation(groupId: string, now: number): ConversationRecord {
    return {
      conversationId: groupId,
      kind: 'group',
      peerUserId: '',
      createdAt: now,
      updatedAt: now,
      lastMessageId: null,
      unreadCount: 0,
      pinnedAt: null,
      archived: false,
      mutedUntil: null,
    };
  }

  /**
   * Adds a system message to a conversation in `batch` (the conversation's record must be
   * in the batch or the store). It counts as read.
   */
  addSystemMessage(
    batch: WriteBatch,
    conversation: ConversationRecord,
    body: string,
    senderUserId: string,
  ): ConversationRecord {
    const now = this.now();
    const notice: MessageRecord = {
      messageId: uuidv7(),
      conversationId: conversation.conversationId,
      senderUserId,
      senderDeviceId: '',
      direction: senderUserId === this.self.userId ? 'out' : 'in',
      kind: 'system',
      body,
      attachment: null,
      replyTo: null,
      sentAt: now,
      sortAt: now,
      createdAt: now,
      state: null,
      expiresAt: null,
      editedAt: null,
      editId: null,
      deletedAt: null,
      readAt: now,
      reactions: [],
    };
    (batch.messages ??= []).push(notice);
    const updated: ConversationRecord = {
      ...conversation,
      updatedAt: Math.max(conversation.updatedAt, now),
      lastMessageId: notice.messageId,
    };
    batch.conversations = [
      ...(batch.conversations ?? []).filter(
        (c) => c.conversationId !== conversation.conversationId,
      ),
      updated,
    ];
    return updated;
  }
}
