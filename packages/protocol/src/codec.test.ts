import { create, toBinary, type MessageInitShape } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';

import {
  decodeClientFrame,
  decodeContent,
  decodeContentHeader,
  decodeEnvelope,
  decodeServerFrame,
  decodeTransportPacket,
  encodeClientFrame,
  encodeContent,
  encodeEnvelope,
  encodeServerFrame,
  encodeTransportPacket,
} from './codec';
import { ProtocolError, type ProtocolErrorCode } from './errors';
import { ContentSchema, Receipt_Type, type Content } from './gen/pingdost/v1/content_pb';
import { CryptoType, EnvelopeSchema, type Envelope } from './gen/pingdost/v1/envelope_pb';
import {
  PacketKind,
  TransportPacketSchema,
  type TransportPacket,
} from './gen/pingdost/v1/packet_pb';
import { Accepted_Status, ClientFrameSchema, ServerFrameSchema } from './gen/pingdost/v1/ws_pb';
import { uuidv7Bytes } from './ids';
import { DEFAULT_ENVELOPE_MAX_BYTES, limitsFor, PROTOCOL_VERSION } from './limits';

const NOW = 1_760_000_000_000;
const options = { nowMs: NOW };

function expectProtocolError(run: () => unknown, code: ProtocolErrorCode, field?: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProtocolError);
  expect(caught).toMatchObject(field === undefined ? { code } : { code, field });
}

/** Field overrides for a test message (without the protobuf-es `$` metadata). */
type Fields<T> = Partial<Omit<T, '$typeName' | '$unknown'>>;

function envelope(overrides: Fields<Envelope> = {}): Envelope {
  return create(EnvelopeSchema, {
    envelopeId: uuidv7Bytes(),
    senderDeviceId: uuidv7Bytes(),
    recipientDeviceId: uuidv7Bytes(),
    cryptoType: CryptoType.OLM,
    ciphertext: new Uint8Array(100).fill(7),
    ...overrides,
  });
}

function packet(overrides: Fields<TransportPacket> = {}): TransportPacket {
  return create(TransportPacketSchema, {
    version: PROTOCOL_VERSION,
    packetId: uuidv7Bytes(),
    kind: PacketKind.ENVELOPE,
    dst: uuidv7Bytes(),
    createdAtMs: BigInt(NOW - 1_000),
    expiresAtMs: BigInt(NOW + 60_000),
    payload: encodeEnvelope(envelope()),
    ...overrides,
  });
}

function content(body: MessageInitShape<typeof ContentSchema>['body']): Content {
  return create(ContentSchema, {
    header: {
      version: PROTOCOL_VERSION,
      messageId: uuidv7Bytes(),
      conversationId: uuidv7Bytes(),
      senderUserId: uuidv7Bytes(),
      sentAtMs: BigInt(NOW),
    },
    body,
  });
}

function textContent(text: string): Content {
  return content({ case: 'text', value: { body: text } });
}

describe('TransportPacket', () => {
  it('round-trips', () => {
    const original = packet();
    expect(decodeTransportPacket(encodeTransportPacket(original, options), options)).toEqual(
      original,
    );
  });

  it('rejects expired packets on encode and decode', () => {
    const expired = packet({ expiresAtMs: BigInt(NOW) });
    expectProtocolError(() => encodeTransportPacket(expired, options), 'EXPIRED', 'expires_at_ms');
    const bytes = toBinary(TransportPacketSchema, expired);
    expectProtocolError(() => decodeTransportPacket(bytes, options), 'EXPIRED');
    expect(decodeTransportPacket(bytes, { nowMs: NOW - 1 }).expiresAtMs).toBe(BigInt(NOW));
  });

  it('rejects other major versions', () => {
    const bytes = toBinary(TransportPacketSchema, packet({ version: 2 }));
    expectProtocolError(
      () => decodeTransportPacket(bytes, options),
      'UNSUPPORTED_VERSION',
      'version',
    );
    expectProtocolError(
      () => decodeTransportPacket(toBinary(TransportPacketSchema, packet({ version: 0 })), options),
      'MISSING_FIELD',
      'version',
    );
  });

  it('rejects missing and invalid fields', () => {
    const decode = (overrides: Fields<TransportPacket>) => () =>
      decodeTransportPacket(toBinary(TransportPacketSchema, packet(overrides)), options);
    expectProtocolError(decode({ packetId: new Uint8Array() }), 'MISSING_FIELD', 'packet_id');
    expectProtocolError(decode({ packetId: new Uint8Array(15) }), 'INVALID_FIELD', 'packet_id');
    expectProtocolError(decode({ kind: PacketKind.UNSPECIFIED }), 'MISSING_FIELD', 'kind');
    expectProtocolError(decode({ dst: new Uint8Array() }), 'MISSING_FIELD', 'dst');
    expectProtocolError(decode({ dst: new Uint8Array(65) }), 'INVALID_FIELD', 'dst');
    expectProtocolError(decode({ createdAtMs: 0n }), 'MISSING_FIELD', 'created_at_ms');
    expectProtocolError(
      decode({ createdAtMs: BigInt(NOW + 60_000) }),
      'INVALID_FIELD',
      'expires_at_ms',
    );
  });

  it('rejects oversized packets and payloads', () => {
    const big = new Uint8Array(DEFAULT_ENVELOPE_MAX_BYTES + 1);
    expectProtocolError(
      () => encodeTransportPacket(packet({ payload: big }), options),
      'OVERSIZED',
      'payload',
    );
    expectProtocolError(
      () => decodeTransportPacket(new Uint8Array(limitsFor().packet + 1), options),
      'OVERSIZED',
    );
    // A smaller ENVELOPE_MAX_BYTES applies to the payload.
    expectProtocolError(
      () =>
        encodeTransportPacket(packet({ payload: new Uint8Array(2_000) }), {
          ...options,
          envelopeMaxBytes: 1_024,
        }),
      'OVERSIZED',
    );
    // Mesh chunks may carry one 64 KiB ciphertext chunk.
    const chunk = packet({ kind: PacketKind.MESH_CHUNK, payload: new Uint8Array(65_552 + 64) });
    expect(decodeTransportPacket(encodeTransportPacket(chunk, options), options).kind).toBe(
      PacketKind.MESH_CHUNK,
    );
  });

  it('rejects malformed bytes', () => {
    expectProtocolError(
      () => decodeTransportPacket(Uint8Array.from([0xff, 0xff, 0xff]), options),
      'MALFORMED',
    );
    const bytes = encodeTransportPacket(packet(), options);
    expectProtocolError(
      () => decodeTransportPacket(bytes.subarray(0, bytes.length - 5), options),
      'MALFORMED',
    );
    expectProtocolError(
      () => decodeTransportPacket(new Uint8Array(), options),
      'MISSING_FIELD',
      'version',
    );
  });

  it('keeps unknown packet kinds for the caller to ignore', () => {
    const future = packet({ kind: 42 as PacketKind });
    expect(decodeTransportPacket(encodeTransportPacket(future, options), options).kind).toBe(42);
  });
});

describe('Envelope', () => {
  it('round-trips every crypto type', () => {
    for (const cryptoType of [CryptoType.OLM_PREKEY, CryptoType.OLM]) {
      const original = envelope({ cryptoType });
      expect(decodeEnvelope(encodeEnvelope(original))).toEqual(original);
    }
    const megolm = envelope({
      cryptoType: CryptoType.MEGOLM,
      groupId: uuidv7Bytes(),
      megolmSessionId: 'c2Vzc2lvbg',
    });
    expect(decodeEnvelope(encodeEnvelope(megolm))).toEqual(megolm);
  });

  it('requires a group and session for Megolm', () => {
    expectProtocolError(
      () =>
        encodeEnvelope(envelope({ cryptoType: CryptoType.MEGOLM, megolmSessionId: 'c2Vzc2lvbg' })),
      'MISSING_FIELD',
      'group_id',
    );
    expectProtocolError(
      () => encodeEnvelope(envelope({ cryptoType: CryptoType.MEGOLM, groupId: uuidv7Bytes() })),
      'MISSING_FIELD',
      'megolm_session_id',
    );
  });

  it('rejects missing fields, oversized and malformed input', () => {
    expectProtocolError(
      () => encodeEnvelope(envelope({ cryptoType: CryptoType.UNSPECIFIED })),
      'MISSING_FIELD',
      'crypto_type',
    );
    expectProtocolError(
      () => encodeEnvelope(envelope({ ciphertext: new Uint8Array() })),
      'MISSING_FIELD',
      'ciphertext',
    );
    expectProtocolError(
      () => encodeEnvelope(envelope({ recipientDeviceId: new Uint8Array(8) })),
      'INVALID_FIELD',
      'recipient_device_id',
    );
    expectProtocolError(
      () => encodeEnvelope(envelope({ ciphertext: new Uint8Array(DEFAULT_ENVELOPE_MAX_BYTES) })),
      'OVERSIZED',
    );
    expectProtocolError(
      () => decodeEnvelope(new Uint8Array(DEFAULT_ENVELOPE_MAX_BYTES + 1)),
      'OVERSIZED',
    );
    expectProtocolError(() => decodeEnvelope(Uint8Array.from([0x0a, 0x10, 0x01])), 'MALFORMED');
  });
});

describe('Content', () => {
  it('round-trips, ignoring padding', () => {
    const original = textContent('Hello');
    const decoded = decodeContent(encodeContent(original));
    expect(decoded.padding.length).toBeGreaterThan(0);
    expect({ ...decoded, padding: new Uint8Array() }).toEqual(original);
  });

  it('round-trips a receipt with a hop count', () => {
    const original = content({
      case: 'receipt',
      value: { type: Receipt_Type.READ, messageIds: [uuidv7Bytes()], hopCount: 2 },
    });
    const decoded = decodeContent(encodeContent(original));
    expect(decoded.body).toEqual(original.body);
  });

  it('rejects other major versions and missing fields', () => {
    const wrongVersion = textContent('x');
    if (wrongVersion.header) wrongVersion.header.version = 2;
    expectProtocolError(
      () => decodeContent(toBinary(ContentSchema, wrongVersion)),
      'UNSUPPORTED_VERSION',
      'header.version',
    );
    expectProtocolError(() => encodeContent(create(ContentSchema)), 'MISSING_FIELD', 'header');
    const noBody = textContent('x');
    noBody.body = { case: undefined };
    expectProtocolError(() => encodeContent(noBody), 'MISSING_FIELD', 'body');
    const noTarget = content({ case: 'delete', value: {} });
    expectProtocolError(() => encodeContent(noTarget), 'MISSING_FIELD', 'delete.target_message_id');
  });

  it('reports a body from a newer version as UNKNOWN_BODY', () => {
    const noBody = textContent('x');
    noBody.body = { case: undefined };
    // Field 16 is not defined in v1: a newer peer's body type.
    const bytes = Uint8Array.from([...toBinary(ContentSchema, noBody), 0x82, 0x01, 0x01, 0x00]);
    expectProtocolError(() => decodeContent(bytes), 'UNKNOWN_BODY', 'body');
    // The header alone still decodes, for an "update needed" placeholder.
    expect(decodeContentHeader(bytes)).toEqual(noBody.header);
  });

  it('checks the recipient user ID', () => {
    const direct = textContent('x');
    if (direct.header) direct.header.recipientUserId = uuidv7Bytes();
    expect(decodeContent(encodeContent(direct)).header).toEqual(direct.header);
    if (direct.header) direct.header.recipientUserId = new Uint8Array(3);
    expectProtocolError(() => encodeContent(direct), 'INVALID_FIELD', 'header.recipient_user_id');
    expectProtocolError(() => decodeContentHeader(new Uint8Array()), 'MISSING_FIELD', 'header');
  });

  it('rejects content that cannot fit in an envelope', () => {
    expectProtocolError(
      () => encodeContent(textContent('x'.repeat(DEFAULT_ENVELOPE_MAX_BYTES))),
      'OVERSIZED',
    );
    expectProtocolError(() => decodeContent(new Uint8Array(limitsFor().content + 1)), 'OVERSIZED');
  });
});

describe('WebSocket frames', () => {
  it('round-trip client and server frames', () => {
    const send = create(ClientFrameSchema, {
      requestId: 3,
      body: { case: 'send', value: { packet: packet() } },
    });
    expect(decodeClientFrame(encodeClientFrame(send, options), options)).toEqual(send);
    const accepted = create(ServerFrameSchema, {
      requestId: 3,
      body: {
        case: 'accepted',
        value: {
          packetId: uuidv7Bytes(),
          envelopeId: uuidv7Bytes(),
          status: Accepted_Status.DELIVERED_TRANSPORT,
        },
      },
    });
    expect(decodeServerFrame(encodeServerFrame(accepted, options), options)).toEqual(accepted);
  });

  it('validates the packet inside Send, Deliver and Ephemeral', () => {
    const wrongKind = create(ClientFrameSchema, {
      body: { case: 'send', value: { packet: packet({ kind: PacketKind.EPHEMERAL }) } },
    });
    expectProtocolError(
      () => encodeClientFrame(wrongKind, options),
      'INVALID_FIELD',
      'send.packet.kind',
    );
    const expired = create(ServerFrameSchema, {
      body: { case: 'deliver', value: { packet: packet({ expiresAtMs: BigInt(NOW - 1) }) } },
    });
    expectProtocolError(
      () => decodeServerFrame(toBinary(ServerFrameSchema, expired), options),
      'EXPIRED',
      'deliver.packet.expires_at_ms',
    );
    const missing = create(ServerFrameSchema, { body: { case: 'ephemeral', value: {} } });
    expectProtocolError(
      () => encodeServerFrame(missing, options),
      'MISSING_FIELD',
      'ephemeral.packet',
    );
  });

  it('rejects an Auth with another major version', () => {
    const auth = create(ClientFrameSchema, {
      body: { case: 'auth', value: { accessToken: 'token', protocolVersion: 2 } },
    });
    expectProtocolError(
      () => decodeClientFrame(toBinary(ClientFrameSchema, auth), options),
      'UNSUPPORTED_VERSION',
      'auth.protocol_version',
    );
  });

  it('rejects empty, oversized and malformed frames', () => {
    expectProtocolError(
      () => decodeClientFrame(new Uint8Array(), options),
      'MISSING_FIELD',
      'body',
    );
    expectProtocolError(
      () => decodeServerFrame(new Uint8Array(limitsFor().frame + 1), options),
      'OVERSIZED',
    );
    expectProtocolError(
      () => decodeServerFrame(Uint8Array.from([0x22, 0x05, 0x01]), options),
      'MALFORMED',
    );
    const unknown = Uint8Array.from([0x08, 0x01, 0xfa, 0x01, 0x00]); // request_id 1 + field 31
    expectProtocolError(() => decodeServerFrame(unknown, options), 'UNKNOWN_BODY', 'body');
  });
});

describe('Presence', () => {
  it('limits the watch list and checks its IDs', () => {
    const frame = (watchUserIds: Uint8Array[]) =>
      create(ClientFrameSchema, {
        body: { case: 'presence', value: { online: true, watchUserIds } },
      });
    const ids = (count: number) => Array.from({ length: count }, () => uuidv7Bytes());
    expect(decodeClientFrame(encodeClientFrame(frame(ids(32)))).body.case).toBe('presence');
    expectProtocolError(
      () => encodeClientFrame(frame(ids(33))),
      'INVALID_FIELD',
      'presence.watch_user_ids',
    );
    expectProtocolError(
      () => encodeClientFrame(frame([new Uint8Array(4)])),
      'INVALID_FIELD',
      'presence.watch_user_ids',
    );
  });
});
