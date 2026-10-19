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
  conversationId: string;
  /** Groups arrive in Phase 13. */
  kind: 'direct';
  /** The other user of a direct conversation. */
  peerUserId: string;
  createdAt: number;
  /** The last activity: the chat list's sort key. */
  updatedAt: number;
  lastMessageId: string | null;
  /** Incoming messages not yet read on this device. */
  unreadCount: number;
}

export type MessageKind =
  | 'text'
  /** A notice the engine adds, e.g. a changed safety number; `body` is a `SystemNotice`. */
  | 'system'
  /** A body type this build does not know: shown as "update needed" (ADR 0006). */
  | 'unsupported';

export type SystemNotice = 'safety_number_changed';

export interface MessageRecord {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  /** Empty for system notices. */
  senderDeviceId: string;
  direction: 'in' | 'out';
  kind: MessageKind;
  /** The text, or the `SystemNotice` code. */
  body: string;
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
}

export type DevicePurpose = 'message' | 'receipt' | 'session_reset';

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

/** One atomic write. Upserts replace whole records by key. */
export interface WriteBatch {
  /** The device Olm account's new pickle. */
  account?: string;
  conversations?: ConversationRecord[];
  messages?: MessageRecord[];
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
}
