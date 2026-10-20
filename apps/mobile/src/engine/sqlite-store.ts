// The engine's `EngineStore` on the SQLCipher database (migration 002; ADR 0011, 0012).
// `apply` is one `BEGIN IMMEDIATE … COMMIT` on the keyed connection; never expo-sqlite's
// `withExclusiveTransactionAsync`, whose second connection has no key (ADR 0005). Applies
// are queued, so two batches never interleave on the shared connection. Search uses the
// FTS5 index that migration 003's triggers keep in step with `messages` (ADR 0014). Groups
// and their Megolm sessions are migration 004's tables (ADR 0016); attachment manifests are
// migration 005's JSON column (ADR 0017).
import {
  ftsQuery,
  type ConversationRecord,
  type DeliveryRecord,
  type DeviceItem,
  type DirectoryRecord,
  type EngineStore,
  type GroupRecord,
  type HeldGroupRecord,
  type InboundGroupSessionRecord,
  type MessageCursor,
  type MessageRecord,
  type OutboundGroupSessionRecord,
  type OutboxItem,
  type PendingOpRecord,
  type SessionRecord,
  type WriteBatch,
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
  'groups',
  'group_sessions_out',
  'group_sessions_in',
  'group_held',
  'attachments',
  'seen_mesh_packets',
  'device_sync_state',
  'messages_fts',
  'message_ops',
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
  pinned_at: number | null;
  archived: number;
  muted_until: number | null;
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
  edited_at: number | null;
  edit_id: string | null;
  deleted_at: number | null;
  read_at: number | null;
  reactions: string;
  attachment: string | null;
}

interface OpRow {
  op_id: string;
  type: string;
  target_message_id: string;
  conversation_id: string;
  sender_user_id: string;
  sent_at: number;
  body: string;
  remove: number;
  received_at: number;
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
  pinnedAt: r.pinned_at,
  archived: r.archived === 1,
  mutedUntil: r.muted_until,
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
  editedAt: r.edited_at,
  editId: r.edit_id,
  deletedAt: r.deleted_at,
  readAt: r.read_at,
  reactions: JSON.parse(r.reactions) as MessageRecord['reactions'],
  attachment: r.attachment ? (JSON.parse(r.attachment) as MessageRecord['attachment']) : null,
});

const toOp = (r: OpRow): PendingOpRecord => ({
  opId: r.op_id,
  type: r.type as PendingOpRecord['type'],
  targetMessageId: r.target_message_id,
  conversationId: r.conversation_id,
  senderUserId: r.sender_user_id,
  sentAt: r.sent_at,
  body: r.body,
  remove: r.remove === 1,
  receivedAt: r.received_at,
});

/** Columns of `messages` in insert order; the upsert keeps the rowid the FTS index uses. */
const MESSAGE_COLUMNS = [
  'message_id',
  'conversation_id',
  'sender_user_id',
  'sender_device_id',
  'direction',
  'kind',
  'body',
  'reply_to',
  'sent_at',
  'sort_at',
  'created_at',
  'state',
  'expires_at',
  'edited_at',
  'edit_id',
  'deleted_at',
  'read_at',
  'reactions',
  'attachment',
] as const;

const UPSERT_MESSAGE = `INSERT INTO messages (${MESSAGE_COLUMNS.join(', ')})
  VALUES (${MESSAGE_COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT (message_id) DO UPDATE SET ${MESSAGE_COLUMNS.slice(1)
    .map((column) => `${column} = excluded.${column}`)
    .join(', ')}`;

const messageParams = (m: MessageRecord): SqlValue[] => [
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
  m.editedAt,
  m.editId,
  m.deletedAt,
  m.readAt,
  JSON.stringify(m.reactions),
  m.attachment ? JSON.stringify(m.attachment) : null,
];

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
  const groupId = typeof fields.groupId === 'string' ? { groupId: fields.groupId } : {};
  if (r.type === 'fanout') {
    return {
      ...base,
      type: 'fanout',
      conversationId: fields.conversationId as string,
      recipientUserIds: fields.recipientUserIds as string[],
      content: bytes(r.content) ?? new Uint8Array(),
      ...(fields.purpose ? { purpose: fields.purpose as 'message' | 'control' } : {}),
      ...groupId,
    };
  }
  if (r.type === 'device') {
    return {
      ...base,
      type: 'device',
      purpose: fields.purpose as DeviceItem['purpose'],
      recipientUserId: fields.recipientUserId as string,
      recipientDeviceId: fields.recipientDeviceId as string,
      newSession: fields.newSession === true,
      content: bytes(r.content) ?? new Uint8Array(),
      packet: bytes(r.packet),
      ...groupId,
      ...(fields.megolm === true ? { megolm: true } : {}),
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
      fields = {
        conversationId: item.conversationId,
        recipientUserIds: item.recipientUserIds,
        purpose: item.purpose,
        groupId: item.groupId,
      };
      content = item.content;
      break;
    case 'device':
      fields = {
        purpose: item.purpose,
        recipientUserId: item.recipientUserId,
        recipientDeviceId: item.recipientDeviceId,
        newSession: item.newSession,
        groupId: item.groupId,
        megolm: item.megolm,
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

interface GroupRow {
  group_id: string;
  version: number;
  members: string;
  server_version: number;
  server_members: string;
  name: string;
  description: string;
  avatar: Uint8Array | null;
  info_at: number;
  info_id: string;
  left_group: number;
  created_at: number;
  updated_at: number;
}

interface OutboundGroupSessionRow {
  group_id: string;
  session_id: string;
  pickle: string;
  created_at: number;
  message_count: number;
  shared_with: string;
  member_key: string;
}

interface InboundGroupSessionRow {
  sender_device_id: string;
  session_id: string;
  group_id: string;
  sender_user_id: string;
  sender_key: string;
  pickle: string;
  first_known_index: number;
  seen_indices: string;
  shared_at: string | null;
  created_at: number;
}

interface HeldRow {
  id: string;
  kind: string;
  group_id: string;
  session_id: string;
  sender_user_id: string;
  sender_device_id: string;
  payload: Uint8Array;
  received_at: number;
  requested_at: number;
}

const toGroup = (r: GroupRow): GroupRecord => ({
  groupId: r.group_id,
  version: r.version,
  members: JSON.parse(r.members) as GroupRecord['members'],
  serverVersion: r.server_version,
  serverMembers: JSON.parse(r.server_members) as GroupRecord['serverMembers'],
  name: r.name,
  description: r.description,
  avatar: bytes(r.avatar),
  infoAt: r.info_at,
  infoId: r.info_id,
  left: r.left_group === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toOutboundGroupSession = (r: OutboundGroupSessionRow): OutboundGroupSessionRecord => ({
  groupId: r.group_id,
  sessionId: r.session_id,
  pickle: r.pickle,
  createdAt: r.created_at,
  messageCount: r.message_count,
  sharedWith: JSON.parse(r.shared_with) as string[],
  memberKey: r.member_key,
});

const toInboundGroupSession = (r: InboundGroupSessionRow): InboundGroupSessionRecord => ({
  sessionId: r.session_id,
  groupId: r.group_id,
  senderUserId: r.sender_user_id,
  senderDeviceId: r.sender_device_id,
  senderKey: r.sender_key,
  pickle: r.pickle,
  firstKnownIndex: r.first_known_index,
  seenIndices: JSON.parse(r.seen_indices) as number[],
  createdAt: r.created_at,
  ...(r.shared_at === null ? {} : { sharedAt: JSON.parse(r.shared_at) as Record<string, number> }),
});

const toHeld = (r: HeldRow): HeldGroupRecord => ({
  id: r.id,
  kind: r.kind as HeldGroupRecord['kind'],
  groupId: r.group_id,
  sessionId: r.session_id,
  senderUserId: r.sender_user_id,
  senderDeviceId: r.sender_device_id,
  payload: bytes(r.payload) ?? new Uint8Array(),
  receivedAt: r.received_at,
  requestedAt: r.requested_at,
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
      for (const conversationId of b.deleteConversations ?? []) {
        await db.runAsync(
          `DELETE FROM delivery_state WHERE message_id IN
             (SELECT message_id FROM messages WHERE conversation_id = ?)`,
          [conversationId],
        );
        await db.runAsync('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
        await db.runAsync('DELETE FROM message_ops WHERE conversation_id = ?', [conversationId]);
        await db.runAsync('DELETE FROM conversations WHERE conversation_id = ?', [conversationId]);
      }
      for (const c of b.conversations ?? []) {
        await db.runAsync(
          `INSERT OR REPLACE INTO conversations (conversation_id, kind, peer_user_id, created_at,
             updated_at, last_message_id, unread_count, pinned_at, archived, muted_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            c.conversationId,
            c.kind,
            c.peerUserId,
            c.createdAt,
            c.updatedAt,
            c.lastMessageId,
            c.unreadCount,
            c.pinnedAt,
            c.archived ? 1 : 0,
            c.mutedUntil,
          ],
        );
      }
      for (const id of b.deleteMessages ?? []) {
        await db.runAsync('DELETE FROM delivery_state WHERE message_id = ?', [id]);
        await db.runAsync('DELETE FROM messages WHERE message_id = ?', [id]);
      }
      for (const m of b.messages ?? []) await db.runAsync(UPSERT_MESSAGE, messageParams(m));
      if (b.pruneOpsBefore !== undefined) {
        await db.runAsync('DELETE FROM message_ops WHERE received_at < ?', [b.pruneOpsBefore]);
      }
      for (const id of b.deleteOps ?? []) {
        await db.runAsync('DELETE FROM message_ops WHERE op_id = ?', [id]);
      }
      for (const op of b.ops ?? []) {
        await db.runAsync(
          `INSERT OR REPLACE INTO message_ops (op_id, type, target_message_id, conversation_id,
             sender_user_id, sent_at, body, remove, received_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            op.opId,
            op.type,
            op.targetMessageId,
            op.conversationId,
            op.senderUserId,
            op.sentAt,
            op.body,
            op.remove ? 1 : 0,
            op.receivedAt,
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
      await this.#applyGroups(b);
      await db.execAsync('COMMIT');
    } catch (error) {
      await db.execAsync('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  /** Groups, Megolm sessions and held group traffic (migration 004). */
  async #applyGroups(b: WriteBatch): Promise<void> {
    const { db } = this;
    for (const groupId of b.deleteGroups ?? []) {
      for (const table of ['groups', 'group_sessions_out', 'group_sessions_in', 'group_held']) {
        await db.runAsync(`DELETE FROM ${table} WHERE group_id = ?`, [groupId]);
      }
    }
    for (const g of b.groups ?? []) {
      await db.runAsync(
        `INSERT OR REPLACE INTO groups (group_id, version, members, server_version, server_members,
           name, description, avatar, info_at, info_id, left_group, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          g.groupId,
          g.version,
          JSON.stringify(g.members),
          g.serverVersion,
          JSON.stringify(g.serverMembers),
          g.name,
          g.description,
          g.avatar,
          g.infoAt,
          g.infoId,
          g.left ? 1 : 0,
          g.createdAt,
          g.updatedAt,
        ],
      );
    }
    for (const s of b.outboundGroupSessions ?? []) {
      await db.runAsync(
        `INSERT OR REPLACE INTO group_sessions_out (group_id, session_id, pickle, created_at,
           message_count, shared_with, member_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          s.groupId,
          s.sessionId,
          s.pickle,
          s.createdAt,
          s.messageCount,
          JSON.stringify(s.sharedWith),
          s.memberKey,
        ],
      );
    }
    for (const s of b.inboundGroupSessions ?? []) {
      await db.runAsync(
        `INSERT OR REPLACE INTO group_sessions_in (sender_device_id, session_id, group_id,
           sender_user_id, sender_key, pickle, first_known_index, seen_indices, shared_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          s.senderDeviceId,
          s.sessionId,
          s.groupId,
          s.senderUserId,
          s.senderKey,
          s.pickle,
          s.firstKnownIndex,
          JSON.stringify(s.seenIndices),
          s.sharedAt === undefined ? null : JSON.stringify(s.sharedAt),
          s.createdAt,
        ],
      );
    }
    if (b.pruneHeldBefore !== undefined) {
      await db.runAsync('DELETE FROM group_held WHERE received_at < ?', [b.pruneHeldBefore]);
    }
    for (const id of b.deleteHeld ?? []) {
      await db.runAsync('DELETE FROM group_held WHERE id = ?', [id]);
    }
    for (const h of b.held ?? []) {
      await db.runAsync(
        `INSERT OR REPLACE INTO group_held (id, kind, group_id, session_id, sender_user_id,
           sender_device_id, payload, received_at, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          h.id,
          h.kind,
          h.groupId,
          h.sessionId,
          h.senderUserId,
          h.senderDeviceId,
          h.payload,
          h.receivedAt,
          h.requestedAt,
        ],
      );
    }
  }

  async getGroup(groupId: string): Promise<GroupRecord | undefined> {
    const row = await this.db.getFirstAsync<GroupRow>('SELECT * FROM groups WHERE group_id = ?', [
      groupId,
    ]);
    return row ? toGroup(row) : undefined;
  }

  async listGroups(): Promise<GroupRecord[]> {
    const rows = await this.db.getAllAsync<GroupRow>(
      'SELECT * FROM groups ORDER BY created_at, group_id',
      [],
    );
    return rows.map(toGroup);
  }

  async getOutboundGroupSession(groupId: string): Promise<OutboundGroupSessionRecord | undefined> {
    const row = await this.db.getFirstAsync<OutboundGroupSessionRow>(
      'SELECT * FROM group_sessions_out WHERE group_id = ?',
      [groupId],
    );
    return row ? toOutboundGroupSession(row) : undefined;
  }

  async getInboundGroupSession(
    senderDeviceId: string,
    sessionId: string,
  ): Promise<InboundGroupSessionRecord | undefined> {
    const row = await this.db.getFirstAsync<InboundGroupSessionRow>(
      'SELECT * FROM group_sessions_in WHERE sender_device_id = ? AND session_id = ?',
      [senderDeviceId, sessionId],
    );
    return row ? toInboundGroupSession(row) : undefined;
  }

  async listHeld(groupId: string): Promise<HeldGroupRecord[]> {
    const rows = await this.db.getAllAsync<HeldRow>(
      'SELECT * FROM group_held WHERE group_id = ? ORDER BY received_at, id',
      [groupId],
    );
    return rows.map(toHeld);
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

  async listUnread(conversationId: string): Promise<MessageRecord[]> {
    const rows = await this.db.getAllAsync<MessageRow>(
      `SELECT * FROM messages WHERE conversation_id = ? AND direction = 'in' AND read_at IS NULL
       ORDER BY sort_at, message_id`,
      [conversationId],
    );
    return rows.map(toMessage);
  }

  /** FTS5 over the encrypted database; the query is built from quoted terms only. */
  async searchMessages(
    query: string,
    options: { conversationId?: string; limit: number },
  ): Promise<MessageRecord[]> {
    const match = ftsQuery(query);
    if (match === undefined) return [];
    const scoped = options.conversationId !== undefined;
    const rows = await this.db.getAllAsync<MessageRow>(
      `SELECT m.* FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.kind = 'text'${scoped ? ' AND m.conversation_id = ?' : ''}
       ORDER BY m.sort_at DESC, m.message_id DESC LIMIT ?`,
      [match, ...(scoped ? [options.conversationId!] : []), options.limit],
    );
    return rows.map(toMessage);
  }

  async listOps(targetMessageId: string): Promise<PendingOpRecord[]> {
    const rows = await this.db.getAllAsync<OpRow>(
      'SELECT * FROM message_ops WHERE target_message_id = ? ORDER BY received_at, op_id',
      [targetMessageId],
    );
    return rows.map(toOp);
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
