// The engine's `EngineStore` on the SQLCipher database (migration 002; ADR 0011, 0012).
// `apply` is one `BEGIN IMMEDIATE … COMMIT` on the keyed connection; never expo-sqlite's
// `withExclusiveTransactionAsync`, whose second connection has no key (ADR 0005). Applies
// are queued, so two batches never interleave on the shared connection.
import type {
  ConversationRecord,
  DeliveryRecord,
  DirectoryRecord,
  EngineStore,
  MessageCursor,
  MessageRecord,
  OutboxItem,
  SessionRecord,
  WriteBatch,
} from '@pingdost/message-engine';
import type { MessageState } from '@pingdost/shared-types';

export type SqlValue = string | number | null | Uint8Array;

/** The part of expo-sqlite's `SQLiteDatabase` the store uses (node:sqlite in tests). */
export interface SqlDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: SqlValue[]): Promise<unknown>;
  getFirstAsync<T>(source: string, params: SqlValue[]): Promise<T | null>;
  getAllAsync<T>(source: string, params: SqlValue[]): Promise<T[]>;
}

/** The `crypto_store` row `CryptoStore` keeps the device Olm account in. */
const ACCOUNT_ID = 'device-olm-account';

const SETTLED: readonly MessageState[] = [
  'delivered_to_recipient_device',
  'read',
  'expired_undelivered',
];

/** Every table holding chat data or Olm sessions (not the account, settings or keys). */
const CHAT_TABLES = [
  'conversations',
  'messages',
  'delivery_state',
  'outbox',
  'crypto_sessions',
  'device_directory',
  'directory_devices',
  'seen_ids',
  'contacts',
  'group_memberships',
  'attachments',
  'seen_mesh_packets',
  'device_sync_state',
  'messages_fts',
] as const;

const utf8 = new TextEncoder();

interface ConversationRow {
  conversation_id: string;
  kind: string;
  peer_user_id: string;
  created_at: number;
  updated_at: number;
  last_message_id: string | null;
  unread_count: number;
}

interface MessageRow {
  message_id: string;
  conversation_id: string;
  sender_user_id: string;
  sender_device_id: string;
  direction: string;
  kind: string;
  body: string;
  reply_to: string | null;
  sent_at: number;
  sort_at: number;
  created_at: number;
  state: string | null;
  expires_at: number | null;
}

interface DeliveryRow {
  message_id: string;
  device_id: string;
  user_id: string;
  own: number;
  state: string;
  updated_at: number;
}

interface OutboxRow {
  id: string;
  type: string;
  message_id: string;
  created_at: number;
  expires_at: number;
  attempts: number;
  next_attempt_at: number;
  content: Uint8Array | null;
  packet: Uint8Array | null;
  fields: string;
}

interface SessionRow {
  session_id: string;
  device_id: string;
  user_id: string;
  identity_key: string;
  pickle: string;
  created_at: number;
  last_received_at: number;
}

interface DirectoryRow {
  user_id: string;
  account_identity_key: string | null;
  key_version: number;
  fetched_at: number;
  verified_identity_key: string | null;
  devices: string;
}

const toConversation = (r: ConversationRow): ConversationRecord => ({
  conversationId: r.conversation_id,
  kind: r.kind as ConversationRecord['kind'],
  peerUserId: r.peer_user_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  lastMessageId: r.last_message_id,
  unreadCount: r.unread_count,
});

const toMessage = (r: MessageRow): MessageRecord => ({
  messageId: r.message_id,
  conversationId: r.conversation_id,
  senderUserId: r.sender_user_id,
  senderDeviceId: r.sender_device_id,
  direction: r.direction as MessageRecord['direction'],
  kind: r.kind as MessageRecord['kind'],
  body: r.body,
  replyTo: r.reply_to,
  sentAt: r.sent_at,
  sortAt: r.sort_at,
  createdAt: r.created_at,
  state: r.state as MessageState | null,
  expiresAt: r.expires_at,
});

const toDelivery = (r: DeliveryRow): DeliveryRecord => ({
  messageId: r.message_id,
  deviceId: r.device_id,
  userId: r.user_id,
  own: r.own === 1,
  state: r.state as MessageState,
  updatedAt: r.updated_at,
});

/** Blobs may come back as other views; the engine compares and re-encodes them as bytes. */
const bytes = (value: Uint8Array | null): Uint8Array | null =>
  value === null ? null : new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();

function toOutbox(r: OutboxRow): OutboxItem {
  const base = {
    id: r.id,
    messageId: r.message_id,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
  };
  const fields = JSON.parse(r.fields) as Record<string, unknown>;
  if (r.type === 'fanout') {
    return {
      ...base,
      type: 'fanout',
      conversationId: fields.conversationId as string,
      recipientUserIds: fields.recipientUserIds as string[],
      content: bytes(r.content) ?? new Uint8Array(),
    };
  }
  if (r.type === 'device') {
    return {
      ...base,
      type: 'device',
      purpose: fields.purpose as 'message' | 'receipt' | 'session_reset',
      recipientUserId: fields.recipientUserId as string,
      recipientDeviceId: fields.recipientDeviceId as string,
      newSession: fields.newSession === true,
      content: bytes(r.content) ?? new Uint8Array(),
      packet: bytes(r.packet),
    };
  }
  return {
    ...base,
    type: 'receipt',
    receipt: fields.receipt as 'delivered' | 'read',
    recipientUserId: fields.recipientUserId as string,
    recipientDeviceId: fields.recipientDeviceId as string,
  };
}

function outboxParams(item: OutboxItem): SqlValue[] {
  let fields: Record<string, unknown>;
  let content: Uint8Array | null = null;
  let packet: Uint8Array | null = null;
  switch (item.type) {
    case 'fanout':
      fields = { conversationId: item.conversationId, recipientUserIds: item.recipientUserIds };
      content = item.content;
      break;
    case 'device':
      fields = {
        purpose: item.purpose,
        recipientUserId: item.recipientUserId,
        recipientDeviceId: item.recipientDeviceId,
        newSession: item.newSession,
      };
      content = item.content;
      packet = item.packet;
      break;
    case 'receipt':
      fields = {
        receipt: item.receipt,
        recipientUserId: item.recipientUserId,
        recipientDeviceId: item.recipientDeviceId,
      };
      break;
  }
  return [
    item.id,
    item.type,
    item.messageId,
    item.createdAt,
    item.expiresAt,
    item.attempts,
    item.nextAttemptAt,
    content,
    packet,
    JSON.stringify(fields),
  ];
}

const toSession = (r: SessionRow): SessionRecord => ({
  sessionId: r.session_id,
  deviceId: r.device_id,
  userId: r.user_id,
  identityKey: r.identity_key,
  pickle: r.pickle,
  createdAt: r.created_at,
  lastReceivedAt: r.last_received_at,
});

const toDirectory = (r: DirectoryRow): DirectoryRecord => ({
  userId: r.user_id,
  accountIdentityKey: r.account_identity_key,
  keyVersion: r.key_version,
  fetchedAt: r.fetched_at,
  verifiedIdentityKey: r.verified_identity_key,
  devices: JSON.parse(r.devices) as DirectoryRecord['devices'],
});

const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ');

export class SqliteEngineStore implements EngineStore {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly db: SqlDatabase) {}

  apply(batch: WriteBatch): Promise<void> {
    const run = this.#queue.then(() => this.#apply(batch));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #apply(b: WriteBatch): Promise<void> {
    const { db } = this;
    await db.execAsync('BEGIN IMMEDIATE');
    try {
      if (b.account !== undefined) {
        await db.runAsync(
          `INSERT INTO crypto_store (id, kind, pickle, updated_at) VALUES (?, 'olm.account', ?, ?)
           ON CONFLICT (id) DO UPDATE SET pickle = excluded.pickle, updated_at = excluded.updated_at`,
          [ACCOUNT_ID, utf8.encode(b.account), Date.now()],
        );
      }
      for (const c of b.conversations ?? []) {
        await db.runAsync(
          `INSERT OR REPLACE INTO conversations
             (conversation_id, kind, peer_user_id, created_at, updated_at, last_message_id, unread_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            c.conversationId,
            c.kind,
            c.peerUserId,
            c.createdAt,
            c.updatedAt,
            c.lastMessageId,
            c.unreadCount,
          ],
        );
      }
      for (const m of b.messages ?? []) {
        await db.runAsync(
          `INSERT OR REPLACE INTO messages (message_id, conversation_id, sender_user_id,
             sender_device_id, direction, kind, body, reply_to, sent_at, sort_at, created_at, state,
             expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            m.messageId,
            m.conversationId,
            m.senderUserId,
            m.senderDeviceId,
            m.direction,
            m.kind,
            m.body,
            m.replyTo,
            m.sentAt,
            m.sortAt,
            m.createdAt,
            m.state,
            m.expiresAt,
          ],
        );
      }
      for (const d of b.deleteDeliveries ?? []) {
        await db.runAsync('DELETE FROM delivery_state WHERE message_id = ? AND device_id = ?', [
          d.messageId,
          d.deviceId,
        ]);
      }
      for (const d of b.deliveries ?? []) {
        await db.runAsync(
          `INSERT OR REPLACE INTO delivery_state (message_id, device_id, user_id, own, state, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [d.messageId, d.deviceId, d.userId, d.own ? 1 : 0, d.state, d.updatedAt],
        );
      }
      for (const id of b.deleteOutbox ?? []) {
        await db.runAsync('DELETE FROM outbox WHERE id = ?', [id]);
      }
      for (const item of b.outbox ?? []) {
        await db.runAsync(
          `INSERT OR REPLACE INTO outbox (id, type, message_id, created_at, expires_at, attempts,
             next_attempt_at, content, packet, fields)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          outboxParams(item),
        );
      }
      for (const s of b.sessions ?? []) {
        await db.runAsync(
          `INSERT OR REPLACE INTO crypto_sessions (session_id, device_id, user_id, identity_key,
             pickle, created_at, last_received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            s.sessionId,
            s.deviceId,
            s.userId,
            s.identityKey,
            s.pickle,
            s.createdAt,
            s.lastReceivedAt,
          ],
        );
      }
      for (const d of b.directory ?? []) {
        await db.runAsync(
          `INSERT OR REPLACE INTO device_directory (user_id, account_identity_key, key_version,
             fetched_at, verified_identity_key, devices)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [
            d.userId,
            d.accountIdentityKey,
            d.keyVersion,
            d.fetchedAt,
            d.verifiedIdentityKey,
            JSON.stringify(d.devices),
          ],
        );
        await db.runAsync('DELETE FROM directory_devices WHERE user_id = ?', [d.userId]);
        for (const device of d.devices) {
          await db.runAsync(
            'INSERT OR REPLACE INTO directory_devices (device_id, user_id) VALUES (?, ?)',
            [device.deviceId, d.userId],
          );
        }
      }
      if (b.pruneSeenBefore !== undefined) {
        await db.runAsync('DELETE FROM seen_ids WHERE seen_at < ?', [b.pruneSeenBefore]);
      }
      for (const s of b.seen ?? []) {
        await db.runAsync('INSERT OR REPLACE INTO seen_ids (id, seen_at) VALUES (?, ?)', [
          s.id,
          s.seenAt,
        ]);
      }
      for (const [key, value] of Object.entries(b.settings ?? {})) {
        if (value === null) {
          await db.runAsync('DELETE FROM local_settings WHERE key = ?', [key]);
        } else {
          await db.runAsync(
            `INSERT INTO local_settings (key, value) VALUES (?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
            [key, JSON.stringify(value)],
          );
        }
      }
      await db.execAsync('COMMIT');
    } catch (error) {
      await db.execAsync('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async getConversation(conversationId: string): Promise<ConversationRecord | undefined> {
    const row = await this.db.getFirstAsync<ConversationRow>(
      'SELECT * FROM conversations WHERE conversation_id = ?',
      [conversationId],
    );
    return row ? toConversation(row) : undefined;
  }

  async listConversations(): Promise<ConversationRecord[]> {
    const rows = await this.db.getAllAsync<ConversationRow>(
      'SELECT * FROM conversations ORDER BY updated_at DESC',
      [],
    );
    return rows.map(toConversation);
  }

  async getMessage(messageId: string): Promise<MessageRecord | undefined> {
    const row = await this.db.getFirstAsync<MessageRow>(
      'SELECT * FROM messages WHERE message_id = ?',
      [messageId],
    );
    return row ? toMessage(row) : undefined;
  }

  async listMessages(
    conversationId: string,
    options: { before?: MessageCursor; limit: number },
  ): Promise<MessageRecord[]> {
    const { before, limit } = options;
    const rows = before
      ? await this.db.getAllAsync<MessageRow>(
          `SELECT * FROM messages WHERE conversation_id = ? AND (sort_at, message_id) < (?, ?)
           ORDER BY sort_at DESC, message_id DESC LIMIT ?`,
          [conversationId, before.sortAt, before.messageId, limit],
        )
      : await this.db.getAllAsync<MessageRow>(
          `SELECT * FROM messages WHERE conversation_id = ?
           ORDER BY sort_at DESC, message_id DESC LIMIT ?`,
          [conversationId, limit],
        );
    return rows.map(toMessage);
  }

  async listExpiring(now: number): Promise<MessageRecord[]> {
    const rows = await this.db.getAllAsync<MessageRow>(
      `SELECT * FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?
         AND direction = 'out' AND state IS NOT NULL AND state NOT IN (${placeholders(SETTLED.length)})`,
      [now, ...SETTLED],
    );
    return rows.map(toMessage);
  }

  async listDeliveries(messageId: string): Promise<DeliveryRecord[]> {
    const rows = await this.db.getAllAsync<DeliveryRow>(
      'SELECT * FROM delivery_state WHERE message_id = ?',
      [messageId],
    );
    return rows.map(toDelivery);
  }

  async listDeliveriesTo(
    deviceId: string,
    states: readonly MessageState[],
  ): Promise<DeliveryRecord[]> {
    if (states.length === 0) return [];
    const rows = await this.db.getAllAsync<DeliveryRow>(
      `SELECT * FROM delivery_state WHERE device_id = ? AND state IN (${placeholders(states.length)})`,
      [deviceId, ...states],
    );
    return rows.map(toDelivery);
  }

  async listOutbox(): Promise<OutboxItem[]> {
    const rows = await this.db.getAllAsync<OutboxRow>(
      'SELECT * FROM outbox ORDER BY created_at, id',
      [],
    );
    return rows.map(toOutbox);
  }

  async getOutboxItem(id: string): Promise<OutboxItem | undefined> {
    const row = await this.db.getFirstAsync<OutboxRow>('SELECT * FROM outbox WHERE id = ?', [id]);
    return row ? toOutbox(row) : undefined;
  }

  async listSessions(deviceId: string): Promise<SessionRecord[]> {
    const rows = await this.db.getAllAsync<SessionRow>(
      'SELECT * FROM crypto_sessions WHERE device_id = ?',
      [deviceId],
    );
    return rows.map(toSession);
  }

  async getDirectory(userId: string): Promise<DirectoryRecord | undefined> {
    const row = await this.db.getFirstAsync<DirectoryRow>(
      'SELECT * FROM device_directory WHERE user_id = ?',
      [userId],
    );
    return row ? toDirectory(row) : undefined;
  }

  async findDeviceOwner(deviceId: string): Promise<string | undefined> {
    const row = await this.db.getFirstAsync<{ user_id: string }>(
      'SELECT user_id FROM directory_devices WHERE device_id = ?',
      [deviceId],
    );
    return row?.user_id;
  }

  async hasSeen(id: string): Promise<boolean> {
    return (await this.db.getFirstAsync('SELECT 1 FROM seen_ids WHERE id = ?', [id])) !== null;
  }

  async getSetting(key: string): Promise<unknown> {
    const row = await this.db.getFirstAsync<{ value: string }>(
      'SELECT value FROM local_settings WHERE key = ?',
      [key],
    );
    return row ? (JSON.parse(row.value) as unknown) : undefined;
  }
}

/**
 * Deletes every message, conversation and Olm session, e.g. after this device was revoked
 * (its identity is burned). The account pickle, settings and keys stay.
 */
export async function wipeChatData(db: SqlDatabase): Promise<void> {
  await db.execAsync('BEGIN IMMEDIATE');
  try {
    for (const table of CHAT_TABLES) await db.execAsync(`DELETE FROM ${table}`);
    await db.execAsync(`DELETE FROM local_settings WHERE key LIKE 'engine.%'`);
    await db.execAsync('COMMIT');
  } catch (error) {
    await db.execAsync('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
