/**
 * History sync records (ADR 0021): store records ↔ the `SyncBatch` protos. Only history
 * travels: conversations, group state and messages with their receipt state and attachment
 * manifests. Never sessions, keys or local-only fields (pins, archive, mute).
 */
import {
  bytesToUuid,
  create,
  GroupMember_Role,
  GroupMemberSchema,
  SyncConversationSchema,
  SyncGroupSchema,
  SyncMessage_Kind,
  SyncMessageSchema,
  SyncReactionSchema,
  uuidToBytes,
  type GroupMember,
  type SyncConversation,
  type SyncGroup,
  type SyncMessage,
} from '@pingdost/protocol';
import { MessageStateSchema } from '@pingdost/shared-types';

import { manifestFrom, readAttachment } from '../attachments';
import type {
  ConversationRecord,
  GroupMemberRecord,
  GroupRecord,
  MessageKind,
  MessageRecord,
  ReactionEntry,
} from '../store';

/** Largest encoded batch: with the chunk around it, it fits in one Content (64 KiB envelope). */
export const SYNC_DATA_MAX = 60_000;
/** Batches are filled to about this size, so most land in the 48 KiB padding step. */
export const SYNC_BATCH_TARGET = 44_000;

const KINDS: Record<MessageKind, SyncMessage_Kind> = {
  text: SyncMessage_Kind.TEXT,
  attachment: SyncMessage_Kind.ATTACHMENT,
  system: SyncMessage_Kind.SYSTEM,
  unsupported: SyncMessage_Kind.UNSUPPORTED,
  deleted: SyncMessage_Kind.DELETED,
};

const ROLES = {
  owner: GroupMember_Role.OWNER,
  admin: GroupMember_Role.ADMIN,
  member: GroupMember_Role.MEMBER,
} as const;

const id = (value: string): Uint8Array => uuidToBytes(value);
const optionalId = (value: string | null): Uint8Array => (value ? id(value) : new Uint8Array(0));
const readId = (bytes: Uint8Array): string | null => (bytes.length > 0 ? bytesToUuid(bytes) : null);

function membersTo(members: GroupMemberRecord[]): GroupMember[] {
  return members.map((m) =>
    create(GroupMemberSchema, { userId: id(m.userId), role: ROLES[m.role] }),
  );
}

function membersFrom(members: GroupMember[]): GroupMemberRecord[] {
  const out: GroupMemberRecord[] = [];
  for (const m of members) {
    const role =
      m.role === GroupMember_Role.OWNER
        ? 'owner'
        : m.role === GroupMember_Role.ADMIN
          ? 'admin'
          : m.role === GroupMember_Role.MEMBER
            ? 'member'
            : undefined;
    if (role) out.push({ userId: bytesToUuid(m.userId), role });
  }
  return out;
}

export function conversationToSync(conversation: ConversationRecord): SyncConversation {
  return create(SyncConversationSchema, {
    conversationId: id(conversation.conversationId),
    group: conversation.kind === 'group',
    peerUserId: optionalId(conversation.peerUserId || null),
    createdAtMs: BigInt(conversation.createdAt),
    updatedAtMs: BigInt(conversation.updatedAt),
  });
}

export function groupToSync(group: GroupRecord): SyncGroup {
  return create(SyncGroupSchema, {
    groupId: id(group.groupId),
    version: BigInt(group.version),
    members: membersTo(group.members),
    serverVersion: BigInt(group.serverVersion),
    serverMembers: membersTo(group.serverMembers),
    name: group.name,
    description: group.description,
    avatar: group.avatar ?? new Uint8Array(0),
    infoAtMs: BigInt(group.infoAt),
    infoId: optionalId(group.infoId || null),
    left: group.left,
    createdAtMs: BigInt(group.createdAt),
  });
}

function reactionsTo(reactions: ReactionEntry[]): SyncMessage['reactions'] {
  return reactions.map((r) =>
    create(SyncReactionSchema, {
      userId: id(r.userId),
      emoji: r.emoji ?? '',
      removed: r.emoji === null,
      atMs: BigInt(r.at),
      id: id(r.id),
    }),
  );
}

export function messageToSync(message: MessageRecord): SyncMessage {
  return create(SyncMessageSchema, {
    messageId: id(message.messageId),
    conversationId: id(message.conversationId),
    senderUserId: id(message.senderUserId),
    senderDeviceId: optionalId(message.senderDeviceId || null),
    kind: KINDS[message.kind],
    body: message.body,
    ...(message.attachment ? { attachment: manifestFrom(message.attachment, '') } : {}),
    ...(message.replyTo ? { replyTo: id(message.replyTo) } : {}),
    sentAtMs: BigInt(message.sentAt),
    sortAtMs: BigInt(message.sortAt),
    state: message.state ?? '',
    editedAtMs: BigInt(message.editedAt ?? 0),
    editId: optionalId(message.editId),
    deletedAtMs: BigInt(message.deletedAt ?? 0),
    readAtMs: BigInt(message.readAt ?? 0),
    reactions: reactionsTo(message.reactions),
  });
}

/** A conversation from the phone, for a device that does not have it yet. */
export function conversationFromSync(
  sync: SyncConversation,
  now: number,
): ConversationRecord | undefined {
  try {
    return {
      conversationId: bytesToUuid(sync.conversationId),
      kind: sync.group ? 'group' : 'direct',
      peerUserId: sync.group ? '' : bytesToUuid(sync.peerUserId),
      createdAt: Number(sync.createdAtMs) || now,
      updatedAt: Number(sync.updatedAtMs) || now,
      lastMessageId: null,
      unreadCount: 0,
      pinnedAt: null,
      archived: false,
      mutedUntil: null,
    };
  } catch {
    return undefined;
  }
}

export function groupFromSync(sync: SyncGroup, now: number): GroupRecord | undefined {
  try {
    return {
      groupId: bytesToUuid(sync.groupId),
      version: Number(sync.version),
      members: membersFrom(sync.members),
      serverVersion: Number(sync.serverVersion),
      serverMembers: membersFrom(sync.serverMembers),
      name: sync.name,
      description: sync.description,
      avatar: sync.avatar.length > 0 ? sync.avatar : null,
      infoAt: Number(sync.infoAtMs),
      infoId: readId(sync.infoId) ?? '',
      left: sync.left,
      createdAt: Number(sync.createdAtMs) || now,
      updatedAt: now,
    };
  } catch {
    return undefined;
  }
}

const KIND_NAMES = new Map<SyncMessage_Kind, MessageKind>(
  Object.entries(KINDS).map(([name, kind]) => [kind, name as MessageKind]),
);

/**
 * A message from the phone as this device files it. Undefined when it is malformed. The
 * phone's receipt state and read time come along; this device sends no receipts for it.
 */
export function messageFromSync(
  sync: SyncMessage,
  selfUserId: string,
  now: number,
): MessageRecord | undefined {
  try {
    const kind = KIND_NAMES.get(sync.kind) ?? 'unsupported';
    const senderUserId = bytesToUuid(sync.senderUserId);
    const own = senderUserId === selfUserId;
    let attachment: MessageRecord['attachment'] = null;
    if (kind === 'attachment') {
      const read = sync.attachment ? readAttachment(sync.attachment) : undefined;
      if (!read) return undefined;
      attachment = read.info;
    }
    const state = own ? MessageStateSchema.safeParse(sync.state) : undefined;
    const sentAt = Number(sync.sentAtMs);
    const readAt = Number(sync.readAtMs);
    return {
      messageId: bytesToUuid(sync.messageId),
      conversationId: bytesToUuid(sync.conversationId),
      senderUserId,
      senderDeviceId: readId(sync.senderDeviceId) ?? '',
      direction: own ? 'out' : 'in',
      kind,
      body: sync.body,
      attachment,
      replyTo: sync.replyTo ? bytesToUuid(sync.replyTo) : null,
      sentAt,
      sortAt: Math.min(Number(sync.sortAtMs) || sentAt, now),
      createdAt: now,
      state: own ? (state?.success ? state.data : 'sent_to_server') : null,
      expiresAt: null,
      editedAt: Number(sync.editedAtMs) || null,
      editId: readId(sync.editId),
      deletedAt: Number(sync.deletedAtMs) || null,
      readAt: readAt > 0 ? readAt : own || kind === 'system' ? now : null,
      reactions: sync.reactions.map((r) => ({
        userId: bytesToUuid(r.userId),
        emoji: r.removed ? null : r.emoji,
        at: Number(r.atMs),
        id: bytesToUuid(r.id),
      })),
    };
  } catch {
    return undefined;
  }
}
