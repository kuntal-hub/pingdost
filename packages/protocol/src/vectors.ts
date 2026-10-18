/**
 * Golden protocol vectors: one per message type and per oneof body, as protobuf JSON plus the
 * exact bytes (base64). `pnpm --filter @pingdost/protocol make-vectors` writes them to
 * `@pingdost/test-fixtures/protocol/v1.json`; `vectors.test.ts` checks the stored file still
 * matches. Any change to that file is a wire change: review it as one.
 */
import {
  create,
  fromBinary,
  toBinary,
  toJson,
  type DescMessage,
  type JsonValue,
  type MessageInitShape,
} from '@bufbuild/protobuf';

import {
  encodeClientFrame,
  encodeContent,
  encodeEnvelope,
  encodeServerFrame,
  encodeTransportPacket,
} from './codec';
import {
  CallSignal_Type,
  ContentSchema,
  GroupControl_Action,
  Receipt_Type,
} from './gen/pingdost/v1/content_pb';
import { CryptoType, EnvelopeSchema } from './gen/pingdost/v1/envelope_pb';
import {
  HelloSchema,
  MeshAckSchema,
  MeshChunkSchema,
  MeshHeaderSchema,
} from './gen/pingdost/v1/mesh_pb';
import {
  AckSchema,
  PacketFlag,
  PacketKind,
  TransportPacketSchema,
} from './gen/pingdost/v1/packet_pb';
import { Accepted_Status, ClientFrameSchema, ServerFrameSchema } from './gen/pingdost/v1/ws_pb';
import { envelopeIdFor, toBase64, uuidToBytes } from './ids';
import { PROTOCOL_VERSION } from './limits';

export interface ProtocolVector {
  name: string;
  /** Fully qualified protobuf type name. */
  type: string;
  /** Canonical protobuf JSON. */
  json: JsonValue;
  /** The encoded bytes, standard base64. */
  binary: string;
}

export interface ProtocolVectors {
  protocolVersion: number;
  /** A time at which every vector's packets are still valid, for codec checks. */
  nowMs: number;
  vectors: ProtocolVector[];
}

const CREATED_AT_MS = 1_760_000_000_000n;
const EXPIRES_AT_MS = CREATED_AT_MS + 14n * 24n * 3_600_000n;
const NOW_MS = Number(CREATED_AT_MS) + 1_000;

/** A fixed, valid UUIDv7 per `n`. */
function id(n: number): Uint8Array {
  return uuidToBytes(`0192f1a0-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
}

const USER_A = id(0xa1);
const USER_B = id(0xb1);
const DEVICE_A = id(0xa2);
const DEVICE_B = id(0xb2);
const GROUP = id(0x61);
const MESSAGE = id(0x01);
const ENVELOPE_ID = envelopeIdFor(MESSAGE, DEVICE_B);
const ROUTING_TOKEN = Uint8Array.from([0x52, 0x54, 0x4b, 0x01, 0x02, 0x03, 0x04, 0x05]);
const MEGOLM_SESSION_ID = 'ZXhhbXBsZS1tZWdvbG0tc2Vzc2lvbi1pZA';

/** Stand-in ciphertext: vectors pin the framing, not the crypto. */
function filler(length: number, seed: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => (seed + i * 31) & 0xff);
}

function vector<Desc extends DescMessage>(
  name: string,
  schema: Desc,
  bytes: Uint8Array,
): ProtocolVector {
  return {
    name,
    type: schema.typeName,
    json: toJson(schema, fromBinary(schema, bytes)),
    binary: toBase64(bytes),
  };
}

function plain<Desc extends DescMessage>(
  name: string,
  schema: Desc,
  init: MessageInitShape<Desc>,
): ProtocolVector {
  return vector(name, schema, toBinary(schema, create(schema, init)));
}

function packet(
  kind: PacketKind,
  payload: Uint8Array,
  extra: { dst?: Uint8Array; flags?: number; hopBudget?: number } = {},
) {
  return create(TransportPacketSchema, {
    version: PROTOCOL_VERSION,
    packetId: id(0x100 + kind),
    kind,
    dst: extra.dst ?? DEVICE_B,
    createdAtMs: CREATED_AT_MS,
    expiresAtMs: EXPIRES_AT_MS,
    hopBudget: extra.hopBudget ?? 0,
    flags: extra.flags ?? 0,
    payload,
  });
}

type ContentBody = MessageInitShape<typeof ContentSchema>['body'];

function content(body: ContentBody, replyTo?: Uint8Array): Uint8Array {
  return encodeContent(
    create(ContentSchema, {
      header: {
        version: PROTOCOL_VERSION,
        messageId: MESSAGE,
        conversationId: GROUP,
        senderUserId: USER_A,
        sentAtMs: CREATED_AT_MS,
        replyTo,
      },
      body,
    }),
  );
}

export function createVectors(): ProtocolVectors {
  const options = { nowMs: NOW_MS };

  const envelope = (cryptoType: CryptoType, seed: number) =>
    encodeEnvelope(
      create(EnvelopeSchema, {
        envelopeId: ENVELOPE_ID,
        senderDeviceId: DEVICE_A,
        recipientDeviceId: DEVICE_B,
        cryptoType,
        ...(cryptoType === CryptoType.MEGOLM
          ? { groupId: GROUP, megolmSessionId: MEGOLM_SESSION_ID }
          : {}),
        ciphertext: filler(48, seed),
      }),
    );
  const olmPrekey = envelope(CryptoType.OLM_PREKEY, 1);
  const olm = envelope(CryptoType.OLM, 2);
  const megolm = envelope(CryptoType.MEGOLM, 3);

  const chunkRef = { transferId: id(0x71), index: 2, count: 3, chunkSha256: filler(32, 7) };
  const ack = toBinary(AckSchema, create(AckSchema, { envelopeIds: [ENVELOPE_ID] }));
  const meshAck = toBinary(MeshAckSchema, create(MeshAckSchema, { packetId: id(0x101) }));
  const meshChunk = toBinary(
    MeshChunkSchema,
    create(MeshChunkSchema, { ref: chunkRef, data: filler(64, 9) }),
  );
  const hello = toBinary(
    HelloSchema,
    create(HelloSchema, { protocolVersion: PROTOCOL_VERSION, peerToken: ROUTING_TOKEN }),
  );

  const envelopePacket = packet(PacketKind.ENVELOPE, olm);
  const ephemeralPacket = packet(PacketKind.EPHEMERAL, olmPrekey, { flags: PacketFlag.URGENT });

  const clientFrame = (body: MessageInitShape<typeof ClientFrameSchema>['body'], requestId = 7) =>
    encodeClientFrame(create(ClientFrameSchema, { requestId, body }), options);
  const serverFrame = (body: MessageInitShape<typeof ServerFrameSchema>['body'], requestId = 0) =>
    encodeServerFrame(create(ServerFrameSchema, { requestId, body }), options);

  const vectors: ProtocolVector[] = [
    // Envelope, one per crypto type.
    vector('envelope/olm-prekey', EnvelopeSchema, olmPrekey),
    vector('envelope/olm', EnvelopeSchema, olm),
    vector('envelope/megolm', EnvelopeSchema, megolm),

    // Packet payloads.
    vector('ack', AckSchema, ack),
    vector('mesh-ack', MeshAckSchema, meshAck),
    vector('mesh-chunk', MeshChunkSchema, meshChunk),
    vector('hello', HelloSchema, hello),
    plain('mesh-header', MeshHeaderSchema, {
      packetId: id(0x104),
      createdAtMs: CREATED_AT_MS,
      expiresAtMs: EXPIRES_AT_MS,
      dstRoutingToken: ROUTING_TOKEN,
      hopBudget: 8,
      originToken: filler(8, 5),
      chunkRef,
    }),

    // TransportPacket, one per kind.
    vector(
      'packet/envelope',
      TransportPacketSchema,
      encodeTransportPacket(envelopePacket, options),
    ),
    vector(
      'packet/ack',
      TransportPacketSchema,
      encodeTransportPacket(packet(PacketKind.ACK, ack, { dst: DEVICE_A }), options),
    ),
    vector(
      'packet/mesh-ack',
      TransportPacketSchema,
      encodeTransportPacket(
        packet(PacketKind.MESH_ACK, meshAck, { dst: ROUTING_TOKEN, hopBudget: 7 }),
        options,
      ),
    ),
    vector(
      'packet/mesh-chunk',
      TransportPacketSchema,
      encodeTransportPacket(
        packet(PacketKind.MESH_CHUNK, meshChunk, { dst: ROUTING_TOKEN, hopBudget: 8 }),
        options,
      ),
    ),
    vector(
      'packet/ephemeral',
      TransportPacketSchema,
      encodeTransportPacket(ephemeralPacket, options),
    ),
    vector(
      'packet/hello',
      TransportPacketSchema,
      encodeTransportPacket(packet(PacketKind.HELLO, hello, { dst: ROUTING_TOKEN }), options),
    ),

    // Content, one per body (padded as sent).
    vector(
      'content/text',
      ContentSchema,
      content({ case: 'text', value: { body: 'Hello, PingDost!' } }),
    ),
    vector(
      'content/reaction',
      ContentSchema,
      content({ case: 'reaction', value: { targetMessageId: id(0x02), emoji: '👍' } }),
    ),
    vector(
      'content/edit',
      ContentSchema,
      content({ case: 'edit', value: { targetMessageId: id(0x02), body: 'Hello again' } }),
    ),
    vector(
      'content/delete',
      ContentSchema,
      content({ case: 'delete', value: { targetMessageId: id(0x02) } }),
    ),
    vector(
      'content/receipt',
      ContentSchema,
      content({
        case: 'receipt',
        value: { type: Receipt_Type.DELIVERED, messageIds: [id(0x02), id(0x03)], hopCount: 3 },
      }),
    ),
    vector(
      'content/attachment-manifest',
      ContentSchema,
      content({
        case: 'attachmentManifest',
        value: {
          attachmentId: id(0x71),
          scheme: 'xchacha20poly1305-stream-be32-64k/1',
          key: filler(32, 11),
          noncePrefix: filler(19, 13),
          plaintextSize: 150_000n,
          chunkSize: 65_536,
          chunkCount: 3,
          mimeType: 'image/jpeg',
          fileName: 'photo.jpg',
          ciphertextSha256: filler(32, 17),
          chunkHashListSha256: filler(32, 19),
        },
      }),
    ),
    vector(
      'content/group-control',
      ContentSchema,
      content({
        case: 'groupControl',
        value: {
          groupId: GROUP,
          action: GroupControl_Action.CREATE,
          memberUserIds: [USER_A, USER_B],
          name: 'Weekend trip',
        },
      }),
    ),
    vector(
      'content/room-key',
      ContentSchema,
      content({
        case: 'roomKey',
        value: {
          groupId: GROUP,
          sessionId: MEGOLM_SESSION_ID,
          sessionKey: 'c2Vzc2lvbi1rZXktc3RhbmQtaW4',
        },
      }),
    ),
    vector(
      'content/sync-chunk',
      ContentSchema,
      content({
        case: 'syncChunk',
        value: { syncId: id(0x81), sequence: 4, last: true, data: filler(40, 23) },
      }),
    ),
    vector(
      'content/call-signal',
      ContentSchema,
      content({
        case: 'callSignal',
        value: { callId: id(0x91), type: CallSignal_Type.OFFER, video: true, sdp: 'v=0\r\n' },
      }),
    ),
    vector(
      'content/session-reset',
      ContentSchema,
      content({ case: 'sessionReset', value: { sessionId: 'b2xkLXNlc3Npb24' } }),
    ),
    vector(
      'content/key-change',
      ContentSchema,
      content({ case: 'keyChange', value: { keyVersion: 4 } }),
    ),
    vector(
      'content/text-reply',
      ContentSchema,
      content({ case: 'text', value: { body: 'Replying' } }, id(0x02)),
    ),

    // ClientFrame, one per body.
    vector(
      'client-frame/auth',
      ClientFrameSchema,
      clientFrame(
        {
          case: 'auth',
          value: { accessToken: 'access-token-stand-in', protocolVersion: PROTOCOL_VERSION },
        },
        1,
      ),
    ),
    vector(
      'client-frame/send',
      ClientFrameSchema,
      clientFrame({ case: 'send', value: { packet: envelopePacket } }),
    ),
    vector(
      'client-frame/ack',
      ClientFrameSchema,
      clientFrame({ case: 'ack', value: { envelopeIds: [ENVELOPE_ID] } }, 0),
    ),
    vector(
      'client-frame/presence',
      ClientFrameSchema,
      clientFrame({ case: 'presence', value: { online: true } }, 0),
    ),
    vector(
      'client-frame/typing',
      ClientFrameSchema,
      clientFrame(
        { case: 'typing', value: { recipientDeviceIds: [DEVICE_B], groupId: GROUP, active: true } },
        0,
      ),
    ),
    vector(
      'client-frame/ephemeral',
      ClientFrameSchema,
      clientFrame({ case: 'ephemeral', value: { packet: ephemeralPacket } }),
    ),
    vector(
      'client-frame/ping',
      ClientFrameSchema,
      clientFrame({ case: 'ping', value: { nonce: 42 } }, 9),
    ),

    // ServerFrame, one per body.
    vector(
      'server-frame/auth-ok',
      ServerFrameSchema,
      serverFrame(
        {
          case: 'authOk',
          value: {
            userId: USER_B,
            deviceId: DEVICE_B,
            serverTimeMs: CREATED_AT_MS,
            heartbeatIntervalMs: 25_000,
          },
        },
        1,
      ),
    ),
    vector(
      'server-frame/accepted',
      ServerFrameSchema,
      serverFrame(
        {
          case: 'accepted',
          value: {
            packetId: envelopePacket.packetId,
            envelopeId: ENVELOPE_ID,
            status: Accepted_Status.STORED,
          },
        },
        7,
      ),
    ),
    vector(
      'server-frame/deliver',
      ServerFrameSchema,
      serverFrame({ case: 'deliver', value: { packet: envelopePacket } }),
    ),
    vector(
      'server-frame/presence',
      ServerFrameSchema,
      serverFrame({ case: 'presence', value: { userId: USER_A, online: true } }),
    ),
    vector(
      'server-frame/typing',
      ServerFrameSchema,
      serverFrame({
        case: 'typing',
        value: { senderDeviceId: DEVICE_A, groupId: GROUP, active: true },
      }),
    ),
    vector(
      'server-frame/ephemeral',
      ServerFrameSchema,
      serverFrame({ case: 'ephemeral', value: { packet: ephemeralPacket } }),
    ),
    vector(
      'server-frame/otk-low',
      ServerFrameSchema,
      serverFrame({ case: 'otkLow', value: { remaining: 5 } }),
    ),
    vector(
      'server-frame/revoked',
      ServerFrameSchema,
      serverFrame({ case: 'revoked', value: { revokedAtMs: CREATED_AT_MS } }),
    ),
    vector(
      'server-frame/error',
      ServerFrameSchema,
      serverFrame(
        {
          case: 'error',
          value: { code: 'RATE_LIMITED', retryable: true, message: 'Too many requests' },
        },
        7,
      ),
    ),
    vector(
      'server-frame/pong',
      ServerFrameSchema,
      serverFrame({ case: 'pong', value: { nonce: 42 } }, 9),
    ),
  ];

  return { protocolVersion: PROTOCOL_VERSION, nowMs: NOW_MS, vectors };
}
