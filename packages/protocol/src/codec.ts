/**
 * Codecs (ARCHITECTURE A4, ADR 0006). Every encode/decode enforces the size limits, the
 * protocol major version, expiry and required fields, and throws `ProtocolError`. Use these
 * instead of calling `toBinary`/`fromBinary` directly.
 *
 * Unknown enum values and unknown fields from newer peers are kept, not rejected, except a
 * oneof body this build does not know (`UNKNOWN_BODY`).
 */
import { fromBinary, toBinary, type DescMessage, type MessageShape } from '@bufbuild/protobuf';

import { ProtocolError } from './errors';
import { ContentSchema, type Content, type ContentHeader } from './gen/pingdost/v1/content_pb';
import { CryptoType, EnvelopeSchema, type Envelope } from './gen/pingdost/v1/envelope_pb';
import {
  PacketKind,
  TransportPacketSchema,
  type TransportPacket,
} from './gen/pingdost/v1/packet_pb';
import {
  ClientFrameSchema,
  ServerFrameSchema,
  type ClientFrame,
  type ServerFrame,
} from './gen/pingdost/v1/ws_pb';
import { UUID_BYTES } from './ids';
import {
  limitsFor,
  MAX_DST_BYTES,
  MESH_CHUNK_MAX_BYTES,
  PROTOCOL_VERSION,
  type CodecOptions,
} from './limits';
import { encodePaddedContent } from './padding';

/** Longest `ContentHeader.conversation_id` (a 16-byte ID, or a 32-byte hash). */
const MAX_CONVERSATION_ID_BYTES = 32;

function missing(field: string): ProtocolError {
  return new ProtocolError('MISSING_FIELD', `${field} is required`, field);
}

function invalid(field: string, rule: string): ProtocolError {
  return new ProtocolError('INVALID_FIELD', `${field} ${rule}`, field);
}

/** A oneof with no case set: unknown fields there mean a newer peer sent a body we do not know. */
function missingBody(message: { $unknown?: unknown[] }, field: string): ProtocolError {
  return message.$unknown?.length
    ? new ProtocolError('UNKNOWN_BODY', `${field} has a type this version does not know`, field)
    : missing(field);
}

function checkVersion(version: number, field: string): void {
  if (version === 0) throw missing(field);
  if (version !== PROTOCOL_VERSION) {
    throw new ProtocolError(
      'UNSUPPORTED_VERSION',
      `major version ${version} is not supported`,
      field,
    );
  }
}

/** Enum fields: the zero value means "not set". */
function checkEnumSet(value: number, field: string): void {
  if (value === 0) throw missing(field);
}

function checkId(value: Uint8Array | undefined, field: string): void {
  if (value === undefined || value.length === 0) throw missing(field);
  if (value.length !== UUID_BYTES) throw invalid(field, `must be ${UUID_BYTES} bytes`);
}

function checkOptionalId(value: Uint8Array | undefined, field: string): void {
  if (value !== undefined) checkId(value, field);
}

function checkIds(values: Uint8Array[], field: string): void {
  if (values.length === 0) throw missing(field);
  for (const value of values) checkId(value, field);
}

function checkText(value: string, field: string): void {
  if (value === '') throw missing(field);
}

function parse<Desc extends DescMessage>(
  schema: Desc,
  bytes: Uint8Array,
  max: number,
): MessageShape<Desc> {
  if (bytes.length > max) {
    throw new ProtocolError('OVERSIZED', `${schema.name} exceeds ${max} bytes`);
  }
  try {
    return fromBinary(schema, bytes);
  } catch {
    throw new ProtocolError('MALFORMED', `not a valid ${schema.name}`);
  }
}

function serialize<Desc extends DescMessage>(
  schema: Desc,
  message: MessageShape<Desc>,
  max: number,
): Uint8Array {
  const bytes = toBinary(schema, message);
  if (bytes.length > max) {
    throw new ProtocolError('OVERSIZED', `${schema.name} exceeds ${max} bytes`);
  }
  return bytes;
}

// TransportPacket

function checkTransportPacket(
  packet: TransportPacket,
  options: CodecOptions,
  expectedKind?: PacketKind,
  path = '',
): void {
  checkVersion(packet.version, `${path}version`);
  checkId(packet.packetId, `${path}packet_id`);
  checkEnumSet(packet.kind, `${path}kind`);
  if (expectedKind !== undefined && packet.kind !== expectedKind) {
    throw invalid(`${path}kind`, `must be ${PacketKind[expectedKind]}`);
  }
  if (packet.dst.length === 0) throw missing(`${path}dst`);
  if (packet.dst.length > MAX_DST_BYTES) {
    throw invalid(`${path}dst`, `must be at most ${MAX_DST_BYTES} bytes`);
  }
  if (packet.createdAtMs <= 0n) throw missing(`${path}created_at_ms`);
  if (packet.expiresAtMs <= packet.createdAtMs) {
    throw invalid(`${path}expires_at_ms`, 'must be after created_at_ms');
  }
  const now = BigInt(Math.floor(options.nowMs ?? Date.now()));
  if (packet.expiresAtMs <= now) {
    throw new ProtocolError('EXPIRED', 'the packet has expired', `${path}expires_at_ms`);
  }
  const maxPayload =
    packet.kind === PacketKind.MESH_CHUNK ? MESH_CHUNK_MAX_BYTES : limitsFor(options).envelope;
  if (packet.payload.length > maxPayload) {
    throw new ProtocolError('OVERSIZED', `payload exceeds ${maxPayload} bytes`, `${path}payload`);
  }
}

function checkPacketField(
  packet: TransportPacket | undefined,
  kind: PacketKind,
  field: string,
  options: CodecOptions,
): void {
  if (packet === undefined) throw missing(field);
  checkTransportPacket(packet, options, kind, `${field}.`);
}

export function encodeTransportPacket(
  packet: TransportPacket,
  options: CodecOptions = {},
): Uint8Array {
  checkTransportPacket(packet, options);
  return serialize(TransportPacketSchema, packet, limitsFor(options).packet);
}

export function decodeTransportPacket(
  bytes: Uint8Array,
  options: CodecOptions = {},
): TransportPacket {
  const packet = parse(TransportPacketSchema, bytes, limitsFor(options).packet);
  checkTransportPacket(packet, options);
  return packet;
}

// Envelope

function checkEnvelope(envelope: Envelope): void {
  checkId(envelope.envelopeId, 'envelope_id');
  checkId(envelope.senderDeviceId, 'sender_device_id');
  checkId(envelope.recipientDeviceId, 'recipient_device_id');
  checkEnumSet(envelope.cryptoType, 'crypto_type');
  checkOptionalId(envelope.groupId, 'group_id');
  if (envelope.cryptoType === CryptoType.MEGOLM) {
    checkId(envelope.groupId, 'group_id');
    checkText(envelope.megolmSessionId, 'megolm_session_id');
  }
  if (envelope.ciphertext.length === 0) throw missing('ciphertext');
}

export function encodeEnvelope(envelope: Envelope, options: CodecOptions = {}): Uint8Array {
  checkEnvelope(envelope);
  return serialize(EnvelopeSchema, envelope, limitsFor(options).envelope);
}

export function decodeEnvelope(bytes: Uint8Array, options: CodecOptions = {}): Envelope {
  const envelope = parse(EnvelopeSchema, bytes, limitsFor(options).envelope);
  checkEnvelope(envelope);
  return envelope;
}

// Content

function checkHeader(header: ContentHeader | undefined): void {
  if (header === undefined) throw missing('header');
  checkVersion(header.version, 'header.version');
  checkId(header.messageId, 'header.message_id');
  if (header.conversationId.length === 0) throw missing('header.conversation_id');
  if (header.conversationId.length > MAX_CONVERSATION_ID_BYTES) {
    throw invalid('header.conversation_id', `must be at most ${MAX_CONVERSATION_ID_BYTES} bytes`);
  }
  checkId(header.senderUserId, 'header.sender_user_id');
  if (header.sentAtMs <= 0n) throw missing('header.sent_at_ms');
  checkOptionalId(header.replyTo, 'header.reply_to');
  checkOptionalId(header.recipientUserId, 'header.recipient_user_id');
}

function checkContent(content: Content): void {
  const { header, body } = content;
  checkHeader(header);

  switch (body.case) {
    case undefined:
      throw missingBody(content, 'body');
    case 'reaction':
    case 'edit':
    case 'delete':
      checkId(body.value.targetMessageId, `${body.case}.target_message_id`);
      break;
    case 'receipt':
      checkEnumSet(body.value.type, 'receipt.type');
      checkIds(body.value.messageIds, 'receipt.message_ids');
      break;
    case 'attachmentManifest':
      checkId(body.value.attachmentId, 'attachment_manifest.attachment_id');
      break;
    case 'groupControl':
      checkId(body.value.groupId, 'group_control.group_id');
      checkEnumSet(body.value.action, 'group_control.action');
      break;
    case 'roomKey':
      checkId(body.value.groupId, 'room_key.group_id');
      checkText(body.value.sessionId, 'room_key.session_id');
      checkText(body.value.sessionKey, 'room_key.session_key');
      break;
    case 'syncChunk':
      checkId(body.value.syncId, 'sync_chunk.sync_id');
      break;
    case 'callSignal':
      checkId(body.value.callId, 'call_signal.call_id');
      checkEnumSet(body.value.type, 'call_signal.type');
      break;
    case 'text':
    case 'sessionReset':
    case 'keyChange':
      break;
  }
}

/** Encodes `content` padded to its size bucket (ADR 0006), ready to encrypt. */
export function encodeContent(content: Content, options: CodecOptions = {}): Uint8Array {
  checkContent(content);
  return encodePaddedContent(content, limitsFor(options).content);
}

/** Decodes a decrypted Content. Padding is ignored. */
export function decodeContent(bytes: Uint8Array, options: CodecOptions = {}): Content {
  const content = parse(ContentSchema, bytes, limitsFor(options).content);
  checkContent(content);
  return content;
}

/**
 * Only the checked header of a decrypted Content, for one `decodeContent` rejected with
 * `UNKNOWN_BODY`: the receiver can still file an "update needed" placeholder (ADR 0006).
 */
export function decodeContentHeader(bytes: Uint8Array, options: CodecOptions = {}): ContentHeader {
  const { header } = parse(ContentSchema, bytes, limitsFor(options).content);
  checkHeader(header);
  return header as ContentHeader;
}

// WebSocket frames

function checkClientFrame(frame: ClientFrame, options: CodecOptions): void {
  const { body } = frame;
  switch (body.case) {
    case undefined:
      throw missingBody(frame, 'body');
    case 'auth':
      checkText(body.value.accessToken, 'auth.access_token');
      checkVersion(body.value.protocolVersion, 'auth.protocol_version');
      break;
    case 'send':
      checkPacketField(body.value.packet, PacketKind.ENVELOPE, 'send.packet', options);
      break;
    case 'ephemeral':
      checkPacketField(body.value.packet, PacketKind.EPHEMERAL, 'ephemeral.packet', options);
      break;
    case 'ack':
      checkIds(body.value.envelopeIds, 'ack.envelope_ids');
      break;
    case 'typing':
      checkIds(body.value.recipientDeviceIds, 'typing.recipient_device_ids');
      checkOptionalId(body.value.groupId, 'typing.group_id');
      break;
    case 'presence':
    case 'ping':
      break;
  }
}

function checkServerFrame(frame: ServerFrame, options: CodecOptions): void {
  const { body } = frame;
  switch (body.case) {
    case undefined:
      throw missingBody(frame, 'body');
    case 'authOk':
      checkId(body.value.userId, 'auth_ok.user_id');
      checkId(body.value.deviceId, 'auth_ok.device_id');
      break;
    case 'accepted':
      checkId(body.value.packetId, 'accepted.packet_id');
      checkId(body.value.envelopeId, 'accepted.envelope_id');
      checkEnumSet(body.value.status, 'accepted.status');
      break;
    case 'deliver':
      checkPacketField(body.value.packet, PacketKind.ENVELOPE, 'deliver.packet', options);
      break;
    case 'ephemeral':
      checkPacketField(body.value.packet, PacketKind.EPHEMERAL, 'ephemeral.packet', options);
      break;
    case 'presence':
      checkId(body.value.userId, 'presence.user_id');
      break;
    case 'typing':
      checkId(body.value.senderDeviceId, 'typing.sender_device_id');
      checkOptionalId(body.value.groupId, 'typing.group_id');
      break;
    case 'error':
      checkText(body.value.code, 'error.code');
      break;
    case 'otkLow':
    case 'revoked':
    case 'pong':
      break;
  }
}

export function encodeClientFrame(frame: ClientFrame, options: CodecOptions = {}): Uint8Array {
  checkClientFrame(frame, options);
  return serialize(ClientFrameSchema, frame, limitsFor(options).frame);
}

export function decodeClientFrame(bytes: Uint8Array, options: CodecOptions = {}): ClientFrame {
  const frame = parse(ClientFrameSchema, bytes, limitsFor(options).frame);
  checkClientFrame(frame, options);
  return frame;
}

export function encodeServerFrame(frame: ServerFrame, options: CodecOptions = {}): Uint8Array {
  checkServerFrame(frame, options);
  return serialize(ServerFrameSchema, frame, limitsFor(options).frame);
}

export function decodeServerFrame(bytes: Uint8Array, options: CodecOptions = {}): ServerFrame {
  const frame = parse(ServerFrameSchema, bytes, limitsFor(options).frame);
  checkServerFrame(frame, options);
  return frame;
}
