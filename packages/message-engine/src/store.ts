/**
 * What the engine persists (REQ §14.1), behind one interface so each platform brings its own
 * storage: in memory for tests and the sim client, SQLCipher on Android (Phase 10), Dexie on
 * the web (Phase 17).
 *
 * Every write goes through `apply(batch)`, which must be atomic: a decrypted message, the
 * advanced Olm session, the seen ID and the receipt to send are stored together or not at
 * all, before the transport ACK (ARCHITECTURE A3). Reads may run outside a batch.
 *
 * The stores hold plaintext (message text, encoded Content in the outbox), so they must sit
 * in encrypted storage. Olm state is stored only as pickles, encrypted with the pickle key.
 */
import type { MessageState } from '@pingdost/shared-types';

export interface ConversationRecord {
  /** A group's conversation ID is its group ID (ADR 0016). */
  conversationId: string;
  kind: 'direct' | 'group';
  /** The other user of a direct conversation; empty for a group. */
  peerUserId: string;
  createdAt: number;
  /** The last activity: the chat list's sort key. */
  updatedAt: number;
  lastMessageId: string | null;
  /** Incoming messages not yet read on this device. */
  unreadCount: number;
  /** Local only (ADR 0014). Pinned chats come first, most recently pinned on top. */
  pinnedAt: number | null;
  /** Local only: listed under "Archived"; new messages leave it there. */
  archived: boolean;
  /** Local only: no notifications until then (`MUTED_FOREVER` for always), or null. */
  mutedUntil: number | null;
}

/** `mutedUntil` for "until I unmute". */
export const MUTED_FOREVER = Number.MAX_SAFE_INTEGER;

export type MessageKind =
  | 'text'
  /** A file (`attachment` set); `body` is its caption, possibly empty (ADR 0017). */
  | 'attachment'
  /** A notice the engine adds, e.g. a changed safety number; `body` is a `SystemNotice`. */
  | 'system'
  /** A body type this build does not know: shown as "update needed" (ADR 0006). */
  | 'unsupported'
  /** Deleted for everyone by its sender: a tombstone, `body` is empty. */
  | 'deleted';

/**
 * `safety_number_changed` (the sender's account key changed), or a group event as `group:`
 * plus JSON (`groups/notices.ts`).
 */
export type SystemNotice = string;

export type GroupRole = 'owner' | 'admin' | 'member';

export interface GroupMemberRecord {
  userId: string;
  role: GroupRole;
}

/**
 * A group as this device knows it (ADR 0016). Membership comes from E2EE `GroupControl`s
 * sent by admins; the server's view only ever removes members or lowers roles here.
 */
export interface GroupRecord {
  groupId: string;
  /** The membership version (the server's numbering) of the state applied last. */
  version: number;
  members: GroupMemberRecord[];
  /** The server's members and roles as last fetched, and its version (0: never fetched). */
  serverVersion: number;
  serverMembers: GroupMemberRecord[];
  name: string;
  description: string;
  /** A small image, or null. */
  avatar: Uint8Array | null;
  /** Last-write-wins key of the shown info: its control's header time and message ID. */
  infoAt: number;
  infoId: string;
  /** This user left or was removed: read-only, no keys are shared any more. */
  left: boolean;
  createdAt: number;
  updatedAt: number;
}

/** This device's current Megolm session for a group. */
export interface OutboundGroupSessionRecord {
  groupId: string;
  sessionId: string;
  pickle: string;
  createdAt: number;
  /** Messages encrypted with it; rotation after 100. */
  messageCount: number;
  /** Devices that were sent its key: a device that is no longer a recipient forces a rotation. */
  sharedWith: string[];
  /** The member set it was made for (sorted user IDs); any change forces a rotation. */
  memberKey: string;
}

/** A Megolm session of a sender device, received over Olm. */
export interface InboundGroupSessionRecord {
  sessionId: string;
  groupId: string;
  senderUserId: string;
  senderDeviceId: string;
  /** The sender device's Curve25519 key when the session arrived. */
  senderKey: string;
  pickle: string;
  firstKnownIndex: number;
  /** Message indices already accepted: Megolm does not reject replays itself (ADR 0003). */
  seenIndices: number[];
  createdAt: number;
  /**
   * This device's own sessions only: each device it was shared with and the first message
   * index that device may read. Only these get a `RoomKeyRequest` answered, from that index.
   */
  sharedAt?: Record<string, number>;
}

/**
 * Group traffic that cannot be read yet, kept until it can: a Megolm message whose key has
 * not arrived (`megolm`), or a room key for a group this device does not know yet
 * (`room_key`, the decrypted Content). Pruned with the pending ops.
 */
export interface HeldGroupRecord {
  /** The envelope ID. */
  id: string;
  kind: 'megolm' | 'room_key';
  groupId: string;
  sessionId: string;
  senderUserId: string;
  senderDeviceId: string;
  payload: Uint8Array;
  receivedAt: number;
  /** When this device last asked the sender for the key (0: never). */
  requestedAt: number;
}

/**
 * A checked `AttachmentManifest` (ADR 0004), as JSON-friendly fields: how to fetch and
 * decrypt the file from staging. Byte fields are standard base64. `key` is secret: it lives
 * only in the encrypted store and is never logged. The local copy and its download state
 * belong to the platform (Phase 15).
 */
export interface AttachmentInfo {
  attachmentId: string;
  key: string;
  noncePrefix: string;
  plaintextSize: number;
  chunkCount: number;
  ciphertextSize: number;
  /** Sniffed by the sender from the file's bytes. */
  mimeType: string;
  fileName: string | null;
  ciphertextSha256: string;
  chunkHashListSha256: string;
  /** An encrypted preview staged as its own attachment, or null. */
  thumbnail: AttachmentInfo | null;
}

/** One user's reaction to a message; the newest event per user wins (ADR 0014). */
export interface ReactionEntry {
  userId: string;
  /** Null: the user withdrew their reaction (kept, so an older event cannot revive it). */
  emoji: string | null;
  /** The reaction event's header time, and its message ID to break ties. */
  at: number;
  id: string;
}

export interface MessageRecord {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  /** Empty for system notices. */
  senderDeviceId: string;
  direction: 'in' | 'out';
  kind: MessageKind;
  /** The text, an attachment's caption, or the `SystemNotice` code. */
  body: string;
  /** `attachment` messages only; cleared when the sender deletes it for everyone. */
  attachment: AttachmentInfo | null;
  replyTo: string | null;
  /** The sender's clock, epoch ms. */
  sentAt: number;
  /** The display order: the sender's clock, never later than when this device stored it. */
  sortAt: number;
  /** When this device stored it. */
  createdAt: number;
  /** Outgoing messages only: the aggregate state (REQ §8.3). */
  state: MessageState | null;
  /** Outgoing: past this without a delivery receipt, the message is `expired_undelivered`. */
  expiresAt: number | null;
  /**
   * The edit now shown (its header time and message ID, for last-write-wins); null if never
   * edited. Earlier texts are not kept, on either side.
   */
  editedAt: number | null;
  editId: string | null;
  /** When the sender deleted it for everyone (`kind` is then `deleted`). */
  deletedAt: number | null;
  /** Incoming: when this device's user read it; null = unread (a read receipt is due). */
  readAt: number | null;
  /** At most one entry per user. */
  reactions: ReactionEntry[];
}

export type OpType = 'edit' | 'delete' | 'reaction';

/**
 * An edit, delete or reaction whose target message is not here yet (e.g. sent from another
 * device of the sender, or reordered by a repair). Applied when the target arrives; pruned
 * once older than any envelope can be.
 */
export interface PendingOpRecord {
  /** The op's own Content message ID. */
  opId: string;
  type: OpType;
  targetMessageId: string;
  conversationId: string;
  senderUserId: string;
  /** The op's header time. */
  sentAt: number;
  /** Edit: the new text; reaction: the emoji (empty when `remove`). */
  body: string;
  remove: boolean;
  receivedAt: number;
}

/** Paging position: messages strictly older than this one. */
export interface MessageCursor {
  sortAt: number;
  messageId: string;
}

/** One outgoing message's state at one recipient device. */
export interface DeliveryRecord {
  messageId: string;
  deviceId: string;
  userId: string;
  /** The sender's own other device. It never counts toward the message state. */
  own: boolean;
  state: MessageState;
  updatedAt: number;
}

interface OutboxBase {
  id: string;
  /** The Content's message ID. */
  messageId: string;
  createdAt: number;
  /** Past this, the item is dropped (and its message expires). */
  expiresAt: number;
  /** Failed attempts so far; drives the backoff. */
  attempts: number;
  nextAttemptAt: number;
}

/** A new message waiting to be expanded into one item per recipient device. */
export interface FanoutItem extends OutboxBase {
  type: 'fanout';
  /** `id` is the message ID. */
  conversationId: string;
  /** The peer and, for the sender's other devices, the sender. */
  recipientUserIds: string[];
  /** The encoded, padded Content. */
  content: Uint8Array;
  /** What the device items will be; default `message`. */
  purpose?: 'message' | 'control';
  /** Group traffic: encrypted once with the group's Megolm session (ADR 0016). */
  groupId?: string;
}

/**
 * `control`: an edit, delete, reaction or group control; no delivery rows or message state.
 * `room_key`: a Megolm session key for one member device.
 */
export type DevicePurpose = 'message' | 'control' | 'receipt' | 'session_reset' | 'room_key';

/** One Content to one device. `id` is the envelope ID. */
export interface DeviceItem extends OutboxBase {
  type: 'device';
  purpose: DevicePurpose;
  recipientUserId: string;
  recipientDeviceId: string;
  content: Uint8Array;
  /** The encrypted TransportPacket once made: retransmits resend these exact bytes. */
  packet: Uint8Array | null;
  /** Encrypt with a fresh Olm session (session repair). */
  newSession: boolean;
  /** The envelope names this group, so the server checks membership (room keys, Megolm). */
  groupId?: string;
  /** Megolm-encrypted at fan-out: `packet` is final and never re-encrypted with Olm. */
  megolm?: boolean;
}

/** A receipt to send; queued receipts to one device go out together as one Content. */
export interface ReceiptItem extends OutboxBase {
  type: 'receipt';
  /** `messageId` is the message being acknowledged. */
  receipt: 'delivered' | 'read';
  recipientUserId: string;
  recipientDeviceId: string;
}

export type OutboxItem = FanoutItem | DeviceItem | ReceiptItem;

/** One Olm session with one remote device. */
export interface SessionRecord {
  sessionId: string;
  deviceId: string;
  userId: string;
  /** The remote device's Curve25519 identity key. */
  identityKey: string;
  pickle: string;
  createdAt: number;
  /** The last message this session decrypted (0 = none): the busiest session is preferred. */
  lastReceivedAt: number;
}

export interface SignedKeyRecord {
  keyId: string;
  publicKey: string;
  signature: string;
}

/** A device whose certificate checked out against the account identity key. */
export interface DirectoryDeviceRecord {
  deviceId: string;
  platform: 'android' | 'ios' | 'web';
  role: 'primary' | 'linked';
  curve25519: string;
  ed25519: string;
  /** Signature-checked; cached for offline first contact over the mesh (ADR 0003). */
  fallbackKey: SignedKeyRecord | null;
}

/** The cached, verified key directory of one user. */
export interface DirectoryRecord {
  userId: string;
  accountIdentityKey: string | null;
  keyVersion: number;
  devices: DirectoryDeviceRecord[];
  fetchedAt: number;
  /** The account identity key the user verified (QR); the contact is verified while it matches. */
  verifiedIdentityKey: string | null;
}

export interface SeenRecord {
  /** A message ID or an envelope ID. */
  id: string;
  seenAt: number;
}

/** One atomic write. Upserts replace whole records by key; deletions run before upserts. */
export interface WriteBatch {
  /** The device Olm account's new pickle. */
  account?: string;
  /** Deletes each conversation with its messages, their deliveries and pending ops. */
  deleteConversations?: string[];
  conversations?: ConversationRecord[];
  /** Deletes messages with their deliveries ("delete for me"). */
  deleteMessages?: string[];
  messages?: MessageRecord[];
  ops?: PendingOpRecord[];
  deleteOps?: string[];
  /** Deletes pending ops received before this time. */
  pruneOpsBefore?: number;
  deliveries?: DeliveryRecord[];
  deleteDeliveries?: { messageId: string; deviceId: string }[];
  outbox?: OutboxItem[];
  deleteOutbox?: string[];
  sessions?: SessionRecord[];
  directory?: DirectoryRecord[];
  seen?: SeenRecord[];
  /** Deletes seen IDs recorded before this time. */
  pruneSeenBefore?: number;
  /** JSON values; `null` deletes the key. */
  settings?: Record<string, unknown>;
  /** Deletes each group with its Megolm sessions and held records. */
  deleteGroups?: string[];
  groups?: GroupRecord[];
  /** Upserted by group ID: one current session per group. */
  outboundGroupSessions?: OutboundGroupSessionRecord[];
  inboundGroupSessions?: InboundGroupSessionRecord[];
  held?: HeldGroupRecord[];
  deleteHeld?: string[];
  /** Deletes held records received before this time. */
  pruneHeldBefore?: number;
}

export interface EngineStore {
  apply(batch: WriteBatch): Promise<void>;

  getConversation(conversationId: string): Promise<ConversationRecord | undefined>;
  /** Most recent activity first. */
  listConversations(): Promise<ConversationRecord[]>;

  getMessage(messageId: string): Promise<MessageRecord | undefined>;
  /** Newest first, older than `before`. */
  listMessages(
    conversationId: string,
    options: { before?: MessageCursor; limit: number },
  ): Promise<MessageRecord[]>;
  /** Outgoing messages past `expiresAt` that are not delivered, read or already expired. */
  listExpiring(now: number): Promise<MessageRecord[]>;
  /** Incoming messages with no `readAt`, oldest first. */
  listUnread(conversationId: string): Promise<MessageRecord[]>;
  /**
   * Text messages matching `query` as `search.ts` defines it (SQLite: FTS5), newest first,
   * optionally in one conversation. The index lives inside the encrypted database.
   */
  searchMessages(
    query: string,
    options: { conversationId?: string; limit: number },
  ): Promise<MessageRecord[]>;

  /** Pending ops for `targetMessageId`, oldest first. */
  listOps(targetMessageId: string): Promise<PendingOpRecord[]>;

  listDeliveries(messageId: string): Promise<DeliveryRecord[]>;
  /** Deliveries to `deviceId` in any of `states`. */
  listDeliveriesTo(deviceId: string, states: readonly MessageState[]): Promise<DeliveryRecord[]>;

  /** The whole outbox, oldest first: it holds only what the next hop has not accepted yet. */
  listOutbox(): Promise<OutboxItem[]>;
  getOutboxItem(id: string): Promise<OutboxItem | undefined>;

  listSessions(deviceId: string): Promise<SessionRecord[]>;

  getDirectory(userId: string): Promise<DirectoryRecord | undefined>;
  /** The user whose cached directory lists `deviceId`. */
  findDeviceOwner(deviceId: string): Promise<string | undefined>;

  hasSeen(id: string): Promise<boolean>;

  getSetting(key: string): Promise<unknown>;

  getGroup(groupId: string): Promise<GroupRecord | undefined>;
  listGroups(): Promise<GroupRecord[]>;
  getOutboundGroupSession(groupId: string): Promise<OutboundGroupSessionRecord | undefined>;
  /**
   * Keyed by sender device and session ID: a session is trusted only for the device that
   * shared it, so no member can claim another device's session ID first.
   */
  getInboundGroupSession(
    senderDeviceId: string,
    sessionId: string,
  ): Promise<InboundGroupSessionRecord | undefined>;
  /** Held records of a group, oldest first. */
  listHeld(groupId: string): Promise<HeldGroupRecord[]>;
}
