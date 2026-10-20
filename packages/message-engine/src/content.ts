/**
 * Building and checking Content (ARCHITECTURE A4). `encodeContent` pads to the size buckets,
 * so "encode → pad → encrypt" is `encodeContent` → Olm (ADR 0006).
 */
import {
  bytesToUuid,
  ContentSchema,
  create,
  directConversationIdFor,
  encodeContent,
  PROTOCOL_VERSION,
  Receipt_Type,
  uuidToBytes,
  type ContentHeader,
  type MessageInitShape,
} from '@pingdost/protocol';

import type { MessageRecord } from './store';

type Body = MessageInitShape<typeof ContentSchema>['body'];

export interface HeaderFields {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  /** Direct conversations: the other user. */
  recipientUserId?: string;
  sentAt: number;
  replyTo?: string | null;
}

export function buildContent(
  header: HeaderFields,
  body: Body,
  envelopeMaxBytes?: number,
): Uint8Array {
  return encodeContent(
    create(ContentSchema, {
      header: {
        version: PROTOCOL_VERSION,
        messageId: uuidToBytes(header.messageId),
        conversationId: uuidToBytes(header.conversationId),
        senderUserId: uuidToBytes(header.senderUserId),
        sentAtMs: BigInt(header.sentAt),
        ...(header.replyTo ? { replyTo: uuidToBytes(header.replyTo) } : {}),
        ...(header.recipientUserId ? { recipientUserId: uuidToBytes(header.recipientUserId) } : {}),
      },
      body,
    }),
    envelopeMaxBytes ? { envelopeMaxBytes } : {},
  );
}

/**
 * The Content of a stored outgoing text message, e.g. to send it again after a repair.
 * `peerUserId` is undefined for a group.
 */
export function textContentFor(
  message: MessageRecord,
  peerUserId: string | undefined,
  envelopeMaxBytes?: number,
): Uint8Array {
  return buildContent(
    {
      messageId: message.messageId,
      conversationId: message.conversationId,
      senderUserId: message.senderUserId,
      ...(peerUserId ? { recipientUserId: peerUserId } : {}),
      sentAt: message.sentAt,
      replyTo: message.replyTo,
    },
    { case: 'text', value: { body: message.body } },
    envelopeMaxBytes,
  );
}

export function receiptBody(type: 'delivered' | 'read', messageIds: string[]): Body {
  return {
    case: 'receipt',
    value: {
      type: type === 'read' ? Receipt_Type.READ : Receipt_Type.DELIVERED,
      messageIds: messageIds.map((id) => uuidToBytes(id)),
    },
  };
}

export interface CheckedHeader {
  messageId: string;
  conversationId: string;
  senderUserId: string;
  recipientUserId: string | undefined;
  sentAt: number;
  replyTo: string | null;
}

/**
 * Reads a decrypted header and checks it against what the envelope proved: the sending
 * device belongs to `senderUserId` (from the verified directory). Direct messages must name
 * this user (or come from this user's own other device) and carry the matching conversation
 * ID, so a sender cannot file a message into someone else's conversation.
 */
function readHeader(header: ContentHeader): CheckedHeader | undefined {
  try {
    return {
      messageId: bytesToUuid(header.messageId),
      conversationId: bytesToUuid(header.conversationId),
      senderUserId: bytesToUuid(header.senderUserId),
      recipientUserId: header.recipientUserId ? bytesToUuid(header.recipientUserId) : undefined,
      sentAt: Number(header.sentAtMs),
      replyTo: header.replyTo ? bytesToUuid(header.replyTo) : null,
    };
  } catch {
    return undefined; // not a 16-byte ID
  }
}

/**
 * Group content (Megolm messages, and group controls and keys over Olm; ADR 0016): it names
 * no recipient, its conversation is the group, and its sender owns the sending device.
 */
export function checkGroupHeader(
  header: ContentHeader,
  sender: { userId: string },
  groupId: string,
): CheckedHeader | undefined {
  const checked = readHeader(header);
  if (!checked || checked.senderUserId !== sender.userId) return undefined;
  if (checked.recipientUserId !== undefined || checked.conversationId !== groupId) return undefined;
  return checked;
}

export function checkHeader(
  header: ContentHeader,
  sender: { userId: string },
  selfUserId: string,
): CheckedHeader | undefined {
  const checked = readHeader(header);
  if (!checked) return undefined;
  if (checked.senderUserId !== sender.userId) return undefined;
  const { recipientUserId } = checked;
  if (recipientUserId === undefined) return undefined; // group content: `checkGroupHeader`
  const forUs = recipientUserId === selfUserId || checked.senderUserId === selfUserId;
  if (!forUs) return undefined;
  if (checked.conversationId !== directConversationIdFor(checked.senderUserId, recipientUserId)) {
    return undefined;
  }
  return checked;
}
