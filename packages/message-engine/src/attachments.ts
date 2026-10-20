/**
 * Attachment messages (Phase 14, ADR 0017): the engine sends and files the E2EE
 * `AttachmentManifest`; the file itself is encrypted and staged by `@pingdost/attachments`
 * before the message goes out, and downloaded on demand by the platform (Phase 15).
 */
import {
  AttachmentError,
  CHUNK_SIZE,
  readManifest,
  SCHEME,
  type CheckedManifest,
  type DecryptInput,
} from '@pingdost/attachments';
import {
  AttachmentManifestSchema,
  create,
  fromBase64,
  toBase64,
  uuidToBytes,
  type AttachmentManifest,
} from '@pingdost/protocol';

import { buildContent } from './content';
import type { AttachmentInfo, MessageRecord } from './store';

function infoFrom(checked: CheckedManifest): AttachmentInfo {
  return {
    attachmentId: checked.attachmentId,
    key: toBase64(checked.key),
    noncePrefix: toBase64(checked.noncePrefix),
    plaintextSize: checked.plaintextSize,
    chunkCount: checked.chunkCount,
    ciphertextSize: checked.ciphertextSize,
    mimeType: checked.mimeType,
    fileName: checked.fileName ?? null,
    ciphertextSha256: toBase64(checked.ciphertextSha256),
    chunkHashListSha256: toBase64(checked.chunkHashListSha256),
    thumbnail: checked.thumbnail ? infoFrom(checked.thumbnail) : null,
  };
}

/**
 * Checks a manifest (`readManifest`, REQ §10.1 size limit) and returns it with its caption,
 * or undefined when it is invalid: the receiver then keeps an "unsupported" placeholder.
 */
export function readAttachment(
  manifest: AttachmentManifest,
): { info: AttachmentInfo; caption: string } | undefined {
  try {
    const checked = readManifest(manifest);
    return { info: infoFrom(checked), caption: checked.caption };
  } catch (error) {
    if (error instanceof AttachmentError) return undefined;
    throw error;
  }
}

/** What `decryptStream` needs to open a downloaded attachment. */
export function attachmentDecryptInput(info: AttachmentInfo): DecryptInput {
  return {
    key: fromBase64(info.key),
    noncePrefix: fromBase64(info.noncePrefix),
    chunkCount: info.chunkCount,
    ciphertextSha256: fromBase64(info.ciphertextSha256),
  };
}

function manifestFrom(info: AttachmentInfo, caption: string): AttachmentManifest {
  return create(AttachmentManifestSchema, {
    attachmentId: uuidToBytes(info.attachmentId),
    scheme: SCHEME,
    key: fromBase64(info.key),
    noncePrefix: fromBase64(info.noncePrefix),
    plaintextSize: BigInt(info.plaintextSize),
    chunkSize: CHUNK_SIZE,
    chunkCount: info.chunkCount,
    mimeType: info.mimeType,
    ...(info.fileName ? { fileName: info.fileName } : {}),
    ciphertextSha256: fromBase64(info.ciphertextSha256),
    chunkHashListSha256: fromBase64(info.chunkHashListSha256),
    ...(info.thumbnail ? { thumbnail: manifestFrom(info.thumbnail, '') } : {}),
    ...(caption ? { caption } : {}),
  });
}

/** The Content of a stored outgoing attachment message (first send and retries). */
export function attachmentContentFor(
  message: MessageRecord,
  peerUserId: string | undefined,
  envelopeMaxBytes?: number,
): Uint8Array {
  if (!message.attachment) throw new Error('not an attachment message');
  return buildContent(
    {
      messageId: message.messageId,
      conversationId: message.conversationId,
      senderUserId: message.senderUserId,
      ...(peerUserId ? { recipientUserId: peerUserId } : {}),
      sentAt: message.sentAt,
      replyTo: message.replyTo,
    },
    { case: 'attachmentManifest', value: manifestFrom(message.attachment, message.body) },
    envelopeMaxBytes,
  );
}
