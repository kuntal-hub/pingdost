// The engine's `EngineStore` on IndexedDB (Phase 17, ADR 0011, 0020). Every record is sealed
// with this browser's vault key (`vault.ts`, AAD = table and key); only the fields its indexes
// need stay readable: IDs, times and flags, never text, keys, pickles or envelopes.
// - `apply(batch)` seals everything first and then writes it in one IndexedDB transaction
//   (Web Crypto must not be awaited inside one, or IndexedDB commits it early). Applies are
//   queued, so two batches never interleave.
// - Decrypted records are cached by their IV, so a re-read of an unchanged row costs nothing.
// - Search: text and caption bodies are kept in memory once the first search builds the
//   index (decrypting every message once), then updated by each apply; matching follows the
//   shared `matchesQuery` rules (ADR 0014). Nothing about it is written to disk.
import {
  matchesQuery,
  type ConversationRecord,
  type DeliveryRecord,
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
import { fromBase64, toBase64 } from '@pingdost/protocol';
import type { MessageState } from '@pingdost/shared-types';

import type { EngineRow, PingdostDb, VaultKey } from './db';
import { decryptBytes, encryptBytes, encryptRecord } from './vault';

const FINAL_STATES: readonly MessageState[] = [
  'delivered_to_recipient_device',
  'read',
  'expired_undelivered',
];

/** The `records` row the Olm account pickle lives in (shared with `session.ts`). */
export const ACCOUNT_RECORD = 'olm-account';

const CACHE_SIZE = 5_000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encode(value: unknown): Uint8Array {
  return encoder.encode(
    JSON.stringify(value, (_key, v: unknown) =>
      v instanceof Uint8Array ? { $u8: toBase64(v) } : v,
    ),
  );
}

function decode<T>(bytes: Uint8Array): T {
  return JSON.parse(decoder.decode(bytes), (_key, v: unknown) => {
    if (v !== null && typeof v === 'object' && '$u8' in v) {
      const encoded = v.$u8;
      if (typeof encoded === 'string' && Object.keys(v).length === 1) return fromBase64(encoded);
    }
    return v;
  }) as T;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function newestFirst(a: MessageRecord, b: MessageRecord): number {
  return (
    b.sortAt - a.sortAt || (a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0)
  );
}

type Table =
  | 'conversations'
  | 'messages'
  | 'deliveries'
  | 'outbox'
  | 'sessions'
  | 'directory'
  | 'settings'
  | 'ops'
  | 'groups'
  | 'groupSessionsOut'
  | 'groupSessionsIn'
  | 'held';

interface Searchable {
  conversationId: string;
  sortAt: number;
  body: string;
}

export class DexieEngineStore implements EngineStore {
  #queue: Promise<unknown> = Promise.resolve();
  readonly #cache = new Map<string, { iv: Uint8Array; value: unknown }>();
  #search: Map<string, Searchable> | undefined;

  constructor(
    private readonly db: PingdostDb,
    private readonly key: VaultKey,
  ) {}

  // Sealing

  #remember(cacheKey: string, iv: Uint8Array, value: unknown): void {
    this.#cache.delete(cacheKey);
    this.#cache.set(cacheKey, { iv, value });
    if (this.#cache.size > CACHE_SIZE) this.#cache.delete(this.#cache.keys().next().value!);
  }

  async #seal<T extends object>(
    table: Table,
    key: string,
    value: unknown,
    index: T,
  ): Promise<EngineRow & T> {
    const cacheKey = `${table}:${key}`;
    const sealed = await encryptBytes(this.key, encode(value), cacheKey);
    this.#remember(cacheKey, sealed.iv, structuredClone(value));
    return { ...index, iv: sealed.iv, data: sealed.data };
  }

  async #open<T>(table: Table, key: string, row: EngineRow | undefined): Promise<T | undefined> {
    if (!row) return undefined;
    const cacheKey = `${table}:${key}`;
    const hit = this.#cache.get(cacheKey);
    if (hit && sameBytes(hit.iv, row.iv)) return structuredClone(hit.value) as T;
    const value = decode<T>(await decryptBytes(this.key, row, cacheKey));
    this.#remember(cacheKey, row.iv, structuredClone(value));
    return value;
  }

  async #openAll<T>(
    table: Table,
    keyOf: (row: EngineRow) => string,
    rows: EngineRow[],
  ): Promise<T[]> {
    const out: T[] = [];
    for (const row of rows) {
      const value = await this.#open<T>(table, keyOf(row), row);
      if (value !== undefined) out.push(value);
    }
    return out;
  }

  // Writes

  apply(batch: WriteBatch): Promise<void> {
    const run = this.#queue.then(() => this.#apply(batch));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #apply(b: WriteBatch): Promise<void> {
    const { db } = this;
    // Everything sealed before the transaction opens.
    const account =
      b.account !== undefined
        ? {
            id: ACCOUNT_RECORD,
            ...(await encryptRecord(this.key, { pickle: b.account }, ACCOUNT_RECORD)),
          }
        : undefined;
    const conversations = await Promise.all(
      (b.conversations ?? []).map((c) =>
        this.#seal('conversations', c.conversationId, c, { id: c.conversationId }),
      ),
    );
    const messages = await Promise.all(
      (b.messages ?? []).map((m) => {
        const index: Record<string, unknown> = {
          id: m.messageId,
          conversationId: m.conversationId,
          sortAt: m.sortAt,
          unread: m.direction === 'in' && m.readAt === null ? 1 : 0,
        };
        if (
          m.direction === 'out' &&
          m.expiresAt !== null &&
          m.state !== null &&
          !FINAL_STATES.includes(m.state)
        ) {
          index.expiring = m.expiresAt;
        }
        return this.#seal('messages', m.messageId, m, index);
      }),
    );
    const ops = await Promise.all(
      (b.ops ?? []).map((op) =>
        this.#seal('ops', op.opId, op, {
          id: op.opId,
          targetMessageId: op.targetMessageId,
          conversationId: op.conversationId,
          receivedAt: op.receivedAt,
        }),
      ),
    );
    const deliveries = await Promise.all(
      (b.deliveries ?? []).map((d) =>
        this.#seal('deliveries', `${d.messageId}/${d.deviceId}`, d, {
          messageId: d.messageId,
          deviceId: d.deviceId,
          state: d.state,
        }),
      ),
    );
    const outbox = await Promise.all(
      (b.outbox ?? []).map((item) =>
        this.#seal('outbox', item.id, item, { id: item.id, createdAt: item.createdAt }),
      ),
    );
    const sessions = await Promise.all(
      (b.sessions ?? []).map((s) =>
        this.#seal('sessions', s.sessionId, s, { id: s.sessionId, deviceId: s.deviceId }),
      ),
    );
    const directory = await Promise.all(
      (b.directory ?? []).map((d) => this.#seal('directory', d.userId, d, { userId: d.userId })),
    );
    const settings: { key: string; row: EngineRow | null }[] = [];
    for (const [key, value] of Object.entries(b.settings ?? {})) {
      settings.push({
        key,
        row: value === null ? null : await this.#seal('settings', key, value, { key }),
      });
    }
    const groups = await Promise.all(
      (b.groups ?? []).map((g) =>
        this.#seal('groups', g.groupId, g, { id: g.groupId, createdAt: g.createdAt }),
      ),
    );
    const outbound = await Promise.all(
      (b.outboundGroupSessions ?? []).map((s) =>
        this.#seal('groupSessionsOut', s.groupId, s, { groupId: s.groupId }),
      ),
    );
    const inbound = await Promise.all(
      (b.inboundGroupSessions ?? []).map((s) => {
        const key = `${s.senderDeviceId}:${s.sessionId}`;
        return this.#seal('groupSessionsIn', key, s, { key, groupId: s.groupId });
      }),
    );
    const held = await Promise.all(
      (b.held ?? []).map((h) =>
        this.#seal('held', h.id, h, { id: h.id, groupId: h.groupId, receivedAt: h.receivedAt }),
      ),
    );

    const removedMessages: string[] = [];
    const tables = [
      db.records,
      db.conversations,
      db.messages,
      db.deliveries,
      db.outbox,
      db.sessions,
      db.directory,
      db.directoryDevices,
      db.seen,
      db.settings,
      db.ops,
      db.groups,
      db.groupSessionsOut,
      db.groupSessionsIn,
      db.held,
    ];
    await db.transaction('rw', tables, async () => {
      if (account) await db.records.put(account);
      for (const conversationId of b.deleteConversations ?? []) {
        await db.conversations.delete(conversationId);
        const ids = await db.messages.where('conversationId').equals(conversationId).primaryKeys();
        await db.messages.bulkDelete(ids);
        if (ids.length > 0) await db.deliveries.where('messageId').anyOf(ids).delete();
        await db.ops.where('conversationId').equals(conversationId).delete();
        removedMessages.push(...ids);
      }
      await db.conversations.bulkPut(conversations);
      const deleteMessages = b.deleteMessages ?? [];
      if (deleteMessages.length > 0) {
        await db.messages.bulkDelete(deleteMessages);
        await db.deliveries.where('messageId').anyOf(deleteMessages).delete();
        removedMessages.push(...deleteMessages);
      }
      await db.messages.bulkPut(messages);
      if (b.pruneOpsBefore !== undefined)
        await db.ops.where('receivedAt').below(b.pruneOpsBefore).delete();
      await db.ops.bulkDelete(b.deleteOps ?? []);
      await db.ops.bulkPut(ops);
      await db.deliveries.bulkDelete(
        (b.deleteDeliveries ?? []).map((d) => [d.messageId, d.deviceId]),
      );
      await db.deliveries.bulkPut(deliveries);
      await db.outbox.bulkDelete(b.deleteOutbox ?? []);
      await db.outbox.bulkPut(outbox);
      await db.sessions.bulkPut(sessions);
      for (const [i, record] of (b.directory ?? []).entries()) {
        await db.directory.put(directory[i]!);
        await db.directoryDevices.where('userId').equals(record.userId).delete();
        await db.directoryDevices.bulkPut(
          record.devices.map((d) => ({ deviceId: d.deviceId, userId: record.userId })),
        );
      }
      if (b.pruneSeenBefore !== undefined)
        await db.seen.where('seenAt').below(b.pruneSeenBefore).delete();
      await db.seen.bulkPut((b.seen ?? []).map((s) => ({ id: s.id, seenAt: s.seenAt })));
      for (const { key, row } of settings) {
        if (row) await db.settings.put(row);
        else await db.settings.delete(key);
      }
      for (const groupId of b.deleteGroups ?? []) {
        await db.groups.delete(groupId);
        await db.groupSessionsOut.delete(groupId);
        await db.groupSessionsIn.where('groupId').equals(groupId).delete();
        await db.held.where('groupId').equals(groupId).delete();
      }
      await db.groups.bulkPut(groups);
      await db.groupSessionsOut.bulkPut(outbound);
      await db.groupSessionsIn.bulkPut(inbound);
      if (b.pruneHeldBefore !== undefined)
        await db.held.where('receivedAt').below(b.pruneHeldBefore).delete();
      await db.held.bulkDelete(b.deleteHeld ?? []);
      await db.held.bulkPut(held);
    });

    // After the commit: keep the search index in step.
    const search = this.#search;
    if (search) {
      for (const conversationId of b.deleteConversations ?? []) {
        for (const [id, entry] of search)
          if (entry.conversationId === conversationId) search.delete(id);
      }
      for (const id of removedMessages) search.delete(id);
      for (const m of b.messages ?? []) {
        if (m.kind === 'text' || m.kind === 'attachment') {
          search.set(m.messageId, {
            conversationId: m.conversationId,
            sortAt: m.sortAt,
            body: m.body,
          });
        } else {
          search.delete(m.messageId);
        }
      }
    }
  }

  // Reads

  getConversation(conversationId: string): Promise<ConversationRecord | undefined> {
    return this.db.conversations
      .get(conversationId)
      .then((row) => this.#open<ConversationRecord>('conversations', conversationId, row));
  }

  async listConversations(): Promise<ConversationRecord[]> {
    const rows = await this.db.conversations.toArray();
    const all = await this.#openAll<ConversationRecord>(
      'conversations',
      (r) => r.id as string,
      rows,
    );
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getMessage(messageId: string): Promise<MessageRecord | undefined> {
    return this.db.messages
      .get(messageId)
      .then((row) => this.#open<MessageRecord>('messages', messageId, row));
  }

  async listMessages(
    conversationId: string,
    options: { before?: MessageCursor; limit: number },
  ): Promise<MessageRecord[]> {
    const { before } = options;
    const rows = await this.db.messages
      .where('[conversationId+sortAt+id]')
      .between(
        [conversationId, -Infinity, ''],
        // Message IDs are ASCII UUIDs: every one sorts below U+FFFF.
        before
          ? [conversationId, before.sortAt, before.messageId]
          : [conversationId, Infinity, '￿'],
        true,
        before === undefined,
      )
      .reverse()
      .limit(options.limit)
      .toArray();
    return this.#openAll<MessageRecord>('messages', (r) => r.id as string, rows);
  }

  async listExpiring(now: number): Promise<MessageRecord[]> {
    const rows = await this.db.messages.where('expiring').belowOrEqual(now).toArray();
    return this.#openAll<MessageRecord>('messages', (r) => r.id as string, rows);
  }

  async listUnread(conversationId: string): Promise<MessageRecord[]> {
    const rows = await this.db.messages
      .where('[conversationId+unread]')
      .equals([conversationId, 1])
      .toArray();
    const all = await this.#openAll<MessageRecord>('messages', (r) => r.id as string, rows);
    return all.sort((a, b) => newestFirst(b, a));
  }

  async #searchIndex(): Promise<Map<string, Searchable>> {
    if (this.#search) return this.#search;
    const index = new Map<string, Searchable>();
    const rows = await this.db.messages.toArray();
    for (const m of await this.#openAll<MessageRecord>('messages', (r) => r.id as string, rows)) {
      if (m.kind === 'text' || m.kind === 'attachment') {
        index.set(m.messageId, {
          conversationId: m.conversationId,
          sortAt: m.sortAt,
          body: m.body,
        });
      }
    }
    // An apply may have run meanwhile: keep the index it already maintains.
    this.#search ??= index;
    return this.#search;
  }

  async searchMessages(
    query: string,
    options: { conversationId?: string; limit: number },
  ): Promise<MessageRecord[]> {
    const index = await this.#searchIndex();
    const hits = [...index.entries()]
      .filter(
        ([, entry]) =>
          (options.conversationId === undefined ||
            entry.conversationId === options.conversationId) &&
          matchesQuery(entry.body, query),
      )
      .sort(([idA, a], [idB, b]) => b.sortAt - a.sortAt || (idA < idB ? 1 : idA > idB ? -1 : 0))
      .slice(0, options.limit);
    const out: MessageRecord[] = [];
    for (const [id] of hits) {
      const message = await this.getMessage(id);
      if (message) out.push(message);
    }
    return out;
  }

  async listOps(targetMessageId: string): Promise<PendingOpRecord[]> {
    const rows = await this.db.ops.where('targetMessageId').equals(targetMessageId).toArray();
    const all = await this.#openAll<PendingOpRecord>('ops', (r) => r.id as string, rows);
    return all.sort((a, b) => a.receivedAt - b.receivedAt || (a.opId < b.opId ? -1 : 1));
  }

  async listDeliveries(messageId: string): Promise<DeliveryRecord[]> {
    const rows = await this.db.deliveries.where('messageId').equals(messageId).toArray();
    return this.#openAll<DeliveryRecord>(
      'deliveries',
      (r) => `${r.messageId as string}/${r.deviceId as string}`,
      rows,
    );
  }

  async listDeliveriesTo(
    deviceId: string,
    states: readonly MessageState[],
  ): Promise<DeliveryRecord[]> {
    if (states.length === 0) return [];
    const rows = await this.db.deliveries
      .where('[deviceId+state]')
      .anyOf(states.map((state) => [deviceId, state]))
      .toArray();
    return this.#openAll<DeliveryRecord>(
      'deliveries',
      (r) => `${r.messageId as string}/${r.deviceId as string}`,
      rows,
    );
  }

  async listOutbox(): Promise<OutboxItem[]> {
    const rows = await this.db.outbox.orderBy('createdAt').toArray();
    return this.#openAll<OutboxItem>('outbox', (r) => r.id as string, rows);
  }

  getOutboxItem(id: string): Promise<OutboxItem | undefined> {
    return this.db.outbox.get(id).then((row) => this.#open<OutboxItem>('outbox', id, row));
  }

  async listSessions(deviceId: string): Promise<SessionRecord[]> {
    const rows = await this.db.sessions.where('deviceId').equals(deviceId).toArray();
    return this.#openAll<SessionRecord>('sessions', (r) => r.id as string, rows);
  }

  getDirectory(userId: string): Promise<DirectoryRecord | undefined> {
    return this.db.directory
      .get(userId)
      .then((row) => this.#open<DirectoryRecord>('directory', userId, row));
  }

  async listDirectories(): Promise<DirectoryRecord[]> {
    const rows = await this.db.directory.toArray();
    return this.#openAll<DirectoryRecord>('directory', (r) => r.userId as string, rows);
  }

  async findDeviceOwner(deviceId: string): Promise<string | undefined> {
    return (await this.db.directoryDevices.get(deviceId))?.userId;
  }

  async hasSeen(id: string): Promise<boolean> {
    return (await this.db.seen.get(id)) !== undefined;
  }

  getSetting(key: string): Promise<unknown> {
    return this.db.settings.get(key).then((row) => this.#open<unknown>('settings', key, row));
  }

  getGroup(groupId: string): Promise<GroupRecord | undefined> {
    return this.db.groups
      .get(groupId)
      .then((row) => this.#open<GroupRecord>('groups', groupId, row));
  }

  async listGroups(): Promise<GroupRecord[]> {
    const rows = await this.db.groups.orderBy('createdAt').toArray();
    return this.#openAll<GroupRecord>('groups', (r) => r.id as string, rows);
  }

  getOutboundGroupSession(groupId: string): Promise<OutboundGroupSessionRecord | undefined> {
    return this.db.groupSessionsOut
      .get(groupId)
      .then((row) => this.#open<OutboundGroupSessionRecord>('groupSessionsOut', groupId, row));
  }

  getInboundGroupSession(
    senderDeviceId: string,
    sessionId: string,
  ): Promise<InboundGroupSessionRecord | undefined> {
    const key = `${senderDeviceId}:${sessionId}`;
    return this.db.groupSessionsIn
      .get(key)
      .then((row) => this.#open<InboundGroupSessionRecord>('groupSessionsIn', key, row));
  }

  async listInboundGroupSessions(groupId: string): Promise<InboundGroupSessionRecord[]> {
    const rows = await this.db.groupSessionsIn.where('groupId').equals(groupId).toArray();
    const all = await this.#openAll<InboundGroupSessionRecord>(
      'groupSessionsIn',
      (r) => r.key as string,
      rows,
    );
    return all.sort((a, b) => a.createdAt - b.createdAt || (a.sessionId < b.sessionId ? -1 : 1));
  }

  async listHeld(groupId: string): Promise<HeldGroupRecord[]> {
    const rows = await this.db.held.where('groupId').equals(groupId).toArray();
    const all = await this.#openAll<HeldGroupRecord>('held', (r) => r.id as string, rows);
    return all.sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : 1));
  }
}
