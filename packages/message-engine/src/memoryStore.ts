/**
 * An in-memory `EngineStore` for tests and the sim client. Records are copied in and out, so
 * callers cannot change stored state by mutating what they hold, as with a real database.
 */
import type { MessageState } from '@pingdost/shared-types';

import { matchesQuery } from './search';
import type {
  ConversationRecord,
  DeliveryRecord,
  DirectoryRecord,
  EngineStore,
  GroupRecord,
  HeldGroupRecord,
  InboundGroupSessionRecord,
  MessageCursor,
  MessageRecord,
  OutboundGroupSessionRecord,
  OutboxItem,
  PendingOpRecord,
  SessionRecord,
  WriteBatch,
} from './store';

const FINAL_STATES: readonly MessageState[] = [
  'delivered_to_recipient_device',
  'read',
  'expired_undelivered',
];

const copy = <T>(value: T): T => structuredClone(value);

export function compareMessages(a: MessageRecord, b: MessageRecord): number {
  return (
    b.sortAt - a.sortAt || (a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0)
  );
}

export class MemoryEngineStore implements EngineStore {
  /** The latest account pickle, for tests that restart an engine. */
  account: string | undefined;
  readonly #conversations = new Map<string, ConversationRecord>();
  readonly #messages = new Map<string, MessageRecord>();
  readonly #deliveries = new Map<string, DeliveryRecord>();
  readonly #outbox = new Map<string, OutboxItem>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #directory = new Map<string, DirectoryRecord>();
  readonly #seen = new Map<string, number>();
  readonly #settings = new Map<string, unknown>();
  readonly #ops = new Map<string, PendingOpRecord>();
  readonly #groups = new Map<string, GroupRecord>();
  readonly #outboundGroup = new Map<string, OutboundGroupSessionRecord>();
  readonly #inboundGroup = new Map<string, InboundGroupSessionRecord>();
  readonly #held = new Map<string, HeldGroupRecord>();
  /** Fault injection for tests: the next `apply` rejects with this error and writes nothing. */
  failNextApply: Error | undefined;

  #deleteMessage(messageId: string): void {
    this.#messages.delete(messageId);
    for (const key of this.#deliveries.keys()) {
      if (key.startsWith(`${messageId}/`)) this.#deliveries.delete(key);
    }
  }

  apply(batch: WriteBatch): Promise<void> {
    if (this.failNextApply) {
      const error = this.failNextApply;
      this.failNextApply = undefined;
      return Promise.reject(error);
    }
    const b = copy(batch);
    if (b.account !== undefined) this.account = b.account;
    for (const conversationId of b.deleteConversations ?? []) {
      this.#conversations.delete(conversationId);
      for (const m of [...this.#messages.values()]) {
        if (m.conversationId === conversationId) this.#deleteMessage(m.messageId);
      }
      for (const [id, op] of this.#ops)
        if (op.conversationId === conversationId) this.#ops.delete(id);
    }
    for (const c of b.conversations ?? []) this.#conversations.set(c.conversationId, c);
    for (const id of b.deleteMessages ?? []) this.#deleteMessage(id);
    for (const m of b.messages ?? []) this.#messages.set(m.messageId, m);
    if (b.pruneOpsBefore !== undefined) {
      for (const [id, op] of this.#ops) if (op.receivedAt < b.pruneOpsBefore) this.#ops.delete(id);
    }
    for (const id of b.deleteOps ?? []) this.#ops.delete(id);
    for (const op of b.ops ?? []) this.#ops.set(op.opId, op);
    for (const d of b.deleteDeliveries ?? [])
      this.#deliveries.delete(`${d.messageId}/${d.deviceId}`);
    for (const d of b.deliveries ?? []) this.#deliveries.set(`${d.messageId}/${d.deviceId}`, d);
    for (const id of b.deleteOutbox ?? []) this.#outbox.delete(id);
    for (const item of b.outbox ?? []) this.#outbox.set(item.id, item);
    for (const s of b.sessions ?? []) this.#sessions.set(s.sessionId, s);
    for (const d of b.directory ?? []) this.#directory.set(d.userId, d);
    if (b.pruneSeenBefore !== undefined) {
      for (const [id, at] of this.#seen) if (at < b.pruneSeenBefore) this.#seen.delete(id);
    }
    for (const s of b.seen ?? []) this.#seen.set(s.id, s.seenAt);
    for (const [key, value] of Object.entries(b.settings ?? {})) {
      if (value === null) this.#settings.delete(key);
      else this.#settings.set(key, value);
    }
    for (const groupId of b.deleteGroups ?? []) {
      this.#groups.delete(groupId);
      this.#outboundGroup.delete(groupId);
      for (const [id, s] of this.#inboundGroup)
        if (s.groupId === groupId) this.#inboundGroup.delete(id);
      for (const [id, h] of this.#held) if (h.groupId === groupId) this.#held.delete(id);
    }
    for (const g of b.groups ?? []) this.#groups.set(g.groupId, g);
    for (const s of b.outboundGroupSessions ?? []) this.#outboundGroup.set(s.groupId, s);
    for (const s of b.inboundGroupSessions ?? []) {
      this.#inboundGroup.set(`${s.senderDeviceId}:${s.sessionId}`, s);
    }
    if (b.pruneHeldBefore !== undefined) {
      for (const [id, h] of this.#held) if (h.receivedAt < b.pruneHeldBefore) this.#held.delete(id);
    }
    for (const id of b.deleteHeld ?? []) this.#held.delete(id);
    for (const h of b.held ?? []) this.#held.set(h.id, h);
    return Promise.resolve();
  }

  getGroup(groupId: string): Promise<GroupRecord | undefined> {
    return Promise.resolve(copy(this.#groups.get(groupId)));
  }

  listGroups(): Promise<GroupRecord[]> {
    return Promise.resolve(
      copy([...this.#groups.values()].sort((a, b) => a.createdAt - b.createdAt)),
    );
  }

  getOutboundGroupSession(groupId: string): Promise<OutboundGroupSessionRecord | undefined> {
    return Promise.resolve(copy(this.#outboundGroup.get(groupId)));
  }

  getInboundGroupSession(
    senderDeviceId: string,
    sessionId: string,
  ): Promise<InboundGroupSessionRecord | undefined> {
    return Promise.resolve(copy(this.#inboundGroup.get(`${senderDeviceId}:${sessionId}`)));
  }

  listHeld(groupId: string): Promise<HeldGroupRecord[]> {
    return Promise.resolve(
      copy(
        [...this.#held.values()]
          .filter((h) => h.groupId === groupId)
          .sort((a, b) => a.receivedAt - b.receivedAt || (a.id < b.id ? -1 : 1)),
      ),
    );
  }

  getConversation(conversationId: string): Promise<ConversationRecord | undefined> {
    return Promise.resolve(copy(this.#conversations.get(conversationId)));
  }

  listConversations(): Promise<ConversationRecord[]> {
    return Promise.resolve(
      copy([...this.#conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt)),
    );
  }

  getMessage(messageId: string): Promise<MessageRecord | undefined> {
    return Promise.resolve(copy(this.#messages.get(messageId)));
  }

  listMessages(
    conversationId: string,
    options: { before?: MessageCursor; limit: number },
  ): Promise<MessageRecord[]> {
    const { before } = options;
    const older = (m: MessageRecord) =>
      !before ||
      m.sortAt < before.sortAt ||
      (m.sortAt === before.sortAt && m.messageId < before.messageId);
    return Promise.resolve(
      copy(
        [...this.#messages.values()]
          .filter((m) => m.conversationId === conversationId && older(m))
          .sort(compareMessages)
          .slice(0, options.limit),
      ),
    );
  }

  listExpiring(now: number): Promise<MessageRecord[]> {
    return Promise.resolve(
      copy(
        [...this.#messages.values()].filter(
          (m) =>
            m.direction === 'out' &&
            m.expiresAt !== null &&
            m.expiresAt <= now &&
            m.state !== null &&
            !FINAL_STATES.includes(m.state),
        ),
      ),
    );
  }

  listUnread(conversationId: string): Promise<MessageRecord[]> {
    return Promise.resolve(
      copy(
        [...this.#messages.values()]
          .filter(
            (m) => m.conversationId === conversationId && m.direction === 'in' && m.readAt === null,
          )
          .sort((a, b) => compareMessages(b, a)),
      ),
    );
  }

  searchMessages(
    query: string,
    options: { conversationId?: string; limit: number },
  ): Promise<MessageRecord[]> {
    return Promise.resolve(
      copy(
        [...this.#messages.values()]
          .filter(
            (m) =>
              m.kind === 'text' &&
              (options.conversationId === undefined ||
                m.conversationId === options.conversationId) &&
              matchesQuery(m.body, query),
          )
          .sort(compareMessages)
          .slice(0, options.limit),
      ),
    );
  }

  listOps(targetMessageId: string): Promise<PendingOpRecord[]> {
    return Promise.resolve(
      copy(
        [...this.#ops.values()]
          .filter((op) => op.targetMessageId === targetMessageId)
          .sort((a, b) => a.receivedAt - b.receivedAt || (a.opId < b.opId ? -1 : 1)),
      ),
    );
  }

  listDeliveries(messageId: string): Promise<DeliveryRecord[]> {
    return Promise.resolve(
      copy([...this.#deliveries.values()].filter((d) => d.messageId === messageId)),
    );
  }

  listDeliveriesTo(deviceId: string, states: readonly MessageState[]): Promise<DeliveryRecord[]> {
    return Promise.resolve(
      copy(
        [...this.#deliveries.values()].filter(
          (d) => d.deviceId === deviceId && states.includes(d.state),
        ),
      ),
    );
  }

  listOutbox(): Promise<OutboxItem[]> {
    return Promise.resolve(
      copy([...this.#outbox.values()].sort((a, b) => a.createdAt - b.createdAt)),
    );
  }

  getOutboxItem(id: string): Promise<OutboxItem | undefined> {
    return Promise.resolve(copy(this.#outbox.get(id)));
  }

  listSessions(deviceId: string): Promise<SessionRecord[]> {
    return Promise.resolve(
      copy([...this.#sessions.values()].filter((s) => s.deviceId === deviceId)),
    );
  }

  getDirectory(userId: string): Promise<DirectoryRecord | undefined> {
    return Promise.resolve(copy(this.#directory.get(userId)));
  }

  findDeviceOwner(deviceId: string): Promise<string | undefined> {
    for (const record of this.#directory.values()) {
      if (record.devices.some((d) => d.deviceId === deviceId))
        return Promise.resolve(record.userId);
    }
    return Promise.resolve(undefined);
  }

  hasSeen(id: string): Promise<boolean> {
    return Promise.resolve(this.#seen.has(id));
  }

  getSetting(key: string): Promise<unknown> {
    return Promise.resolve(copy(this.#settings.get(key)));
  }

  /** Every message, for test assertions. */
  allMessages(): MessageRecord[] {
    return copy([...this.#messages.values()].sort(compareMessages));
  }
}
