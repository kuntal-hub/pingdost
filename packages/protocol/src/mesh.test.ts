// The mesh relay's wire pieces (ADR 0025): routing tokens, codecs and signed statements.
import { createHash } from 'node:crypto';

import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';

import {
  decodeMeshAck,
  decodeMeshEnvelope,
  decodeMeshSummary,
  decodeTransportPacket,
  encodeMeshAck,
  encodeMeshEnvelope,
  encodeMeshSummary,
  encodeTransportPacket,
  MAX_MESH_SUMMARY_TOKENS,
} from './codec';
import { ProtocolError } from './errors';
import { CryptoType, EnvelopeSchema } from './gen/pingdost/v1/envelope_pb';
import {
  MeshAckSchema,
  MeshAckStatus,
  MeshEnvelopeSchema,
  MeshSummarySchema,
} from './gen/pingdost/v1/mesh_pb';
import { PacketKind, TransportPacketSchema } from './gen/pingdost/v1/packet_pb';
import { uuidToBytes, uuidv7Bytes } from './ids';
import { DEFAULT_ENVELOPE_MAX_BYTES } from './limits';
import {
  DAY_MS,
  fromMeshEnvelope,
  meshDay,
  meshRoutingToken,
  meshRoutingTokens,
  toMeshEnvelope,
} from './mesh';
import { meshAckMessage, meshEnvelopeMessage, SIGNING_CONTEXTS } from './signing';

const DEVICE = '01890a5d-ac96-774b-bcce-b302099a8057';
const OTHER = '01890a5d-ac96-774b-bcce-b302099a8058';
const bytes = (length: number, fill: number) => new Uint8Array(length).fill(fill);

function hex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const meshEnvelope = (overrides: Partial<Parameters<typeof create>[1]> = {}) =>
  create(MeshEnvelopeSchema, {
    originToken: bytes(16, 1),
    envelopeId: uuidv7Bytes(),
    cryptoType: CryptoType.OLM,
    ciphertext: bytes(40, 7),
    signature: bytes(64, 9),
    ...overrides,
  });

describe('routing tokens', () => {
  it('are 16 bytes, fixed per device and day, and differ across days and devices', () => {
    const day = meshDay(Date.UTC(2026, 10, 1, 12));
    const token = meshRoutingToken(DEVICE, day);
    expect(token).toHaveLength(16);
    expect(meshRoutingToken(uuidToBytes(DEVICE), day)).toEqual(token);
    expect(meshRoutingToken(DEVICE, day + 1)).not.toEqual(token);
    expect(meshRoutingToken(OTHER, day)).not.toEqual(token);
  });

  it('are SHA-256 over context ‖ NUL ‖ device ID ‖ day, so every platform derives the same', () => {
    const day = Buffer.alloc(4);
    day.writeUInt32BE(20_393);
    const expected = createHash('sha256')
      .update(Buffer.from('pingdost/mesh-route/v1\0'))
      .update(Buffer.from(DEVICE.replaceAll('-', ''), 'hex'))
      .update(day)
      .digest()
      .subarray(0, 16);
    expect(hex(meshRoutingToken(DEVICE, 20_393))).toBe(expected.toString('hex'));
    expect(SIGNING_CONTEXTS.meshRoute).toBe('pingdost/mesh-route/v1');
  });

  it('cover every day a live packet can have been made on, plus tomorrow', () => {
    const now = Date.UTC(2026, 10, 1, 12);
    const tokens = meshRoutingTokens(DEVICE, now, 14 * DAY_MS);
    expect(tokens).toHaveLength(16);
    expect(tokens[0]).toEqual(meshRoutingToken(DEVICE, meshDay(now) + 1));
    expect(tokens.at(-1)).toEqual(meshRoutingToken(DEVICE, meshDay(now) - 14));
    expect(meshRoutingTokens(DEVICE, now, 30 * DAY_MS).length).toBeLessThanOrEqual(
      MAX_MESH_SUMMARY_TOKENS,
    );
  });
});

describe('MeshEnvelope', () => {
  it('round-trips, and maps to and from the Envelope without the device IDs', () => {
    const envelope = create(EnvelopeSchema, {
      envelopeId: uuidv7Bytes(),
      senderDeviceId: uuidToBytes(DEVICE),
      recipientDeviceId: uuidToBytes(OTHER),
      cryptoType: CryptoType.MEGOLM,
      groupId: uuidv7Bytes(),
      megolmSessionId: 'session',
      ciphertext: bytes(30, 5),
    });
    const mesh = toMeshEnvelope(envelope, bytes(16, 3));
    mesh.signature = bytes(64, 4);
    const decoded = decodeMeshEnvelope(encodeMeshEnvelope(mesh));
    expect(decoded).toEqual(mesh);
    expect(fromMeshEnvelope(decoded, envelope.senderDeviceId, envelope.recipientDeviceId)).toEqual(
      envelope,
    );
  });

  it('rejects bad tokens, IDs, signatures, empty ciphertext and Megolm without a group', () => {
    for (const bad of [
      { originToken: bytes(15, 1) },
      { envelopeId: bytes(3, 1) },
      { signature: bytes(63, 1) },
      { ciphertext: new Uint8Array(0) },
      { cryptoType: CryptoType.UNSPECIFIED },
      { cryptoType: CryptoType.MEGOLM },
    ]) {
      expect(() => encodeMeshEnvelope(meshEnvelope(bad))).toThrow(ProtocolError);
    }
  });

  it('fits the envelope limit plus its overhead inside a MESH_ENVELOPE packet', () => {
    const mesh = meshEnvelope({ ciphertext: bytes(DEFAULT_ENVELOPE_MAX_BYTES - 100, 1) });
    const payload = encodeMeshEnvelope(mesh);
    expect(payload.length).toBeGreaterThan(DEFAULT_ENVELOPE_MAX_BYTES - 100);
    const now = Date.now();
    const packet = create(TransportPacketSchema, {
      version: 1,
      packetId: uuidv7Bytes(),
      kind: PacketKind.MESH_ENVELOPE,
      dst: bytes(16, 2),
      createdAtMs: BigInt(now),
      expiresAtMs: BigInt(now + 60_000),
      hopBudget: 8,
      copies: 8,
      payload,
    });
    expect(decodeTransportPacket(encodeTransportPacket(packet)).copies).toBe(8);
  });
});

describe('MeshSummary and MeshAck', () => {
  it('round-trip within their bounds', () => {
    const summary = create(MeshSummarySchema, {
      routingTokens: [bytes(16, 1), bytes(16, 2)],
      delivered: [uuidv7Bytes()],
    });
    expect(decodeMeshSummary(encodeMeshSummary(summary))).toEqual(summary);
    expect(() =>
      encodeMeshSummary(create(MeshSummarySchema, { routingTokens: [bytes(15, 1)] })),
    ).toThrow(ProtocolError);
    expect(() =>
      encodeMeshSummary(
        create(MeshSummarySchema, {
          routingTokens: Array.from({ length: MAX_MESH_SUMMARY_TOKENS + 1 }, () => bytes(16, 1)),
        }),
      ),
    ).toThrow(ProtocolError);

    const ack = create(MeshAckSchema, {
      packetId: uuidv7Bytes(),
      status: MeshAckStatus.ACCEPTED,
      signature: bytes(64, 1),
    });
    expect(decodeMeshAck(encodeMeshAck(ack))).toEqual(ack);
    expect(() => encodeMeshAck(create(MeshAckSchema, { ...ack, status: 0 }))).toThrow(
      ProtocolError,
    );
    expect(() => encodeMeshAck(create(MeshAckSchema, { ...ack, signature: bytes(1, 1) }))).toThrow(
      ProtocolError,
    );
  });
});

describe('signed statements', () => {
  const statement = {
    packetId: bytes(16, 1),
    createdAtMs: 1_000n,
    expiresAtMs: 2_000n,
    dst: bytes(16, 2),
    originToken: bytes(16, 3),
    envelopeId: bytes(16, 4),
    cryptoType: CryptoType.OLM,
    megolmSessionId: '',
    ciphertext: Uint8Array.of(9, 9),
  };

  it('lay out the envelope statement exactly, with its own context', () => {
    const message = meshEnvelopeMessage(statement);
    const context = 'pingdost/mesh-envelope/v1'.length + 1;
    expect(message.length).toBe(context + 16 + 8 + 8 + 16 + 16 + 16 + 4 + 1 + 2 + 2);
    expect(new TextDecoder().decode(message.slice(0, context - 1))).toBe(
      'pingdost/mesh-envelope/v1',
    );
    expect(message.at(-1)).toBe(9);
  });

  it('change with every signed field, and only those', () => {
    const base = hex(meshEnvelopeMessage(statement));
    for (const changed of [
      { packetId: bytes(16, 7) },
      { createdAtMs: 1_001n },
      { expiresAtMs: 2_001n },
      { dst: bytes(16, 7) },
      { originToken: bytes(16, 7) },
      { envelopeId: bytes(16, 7) },
      { cryptoType: CryptoType.OLM_PREKEY },
      { groupId: bytes(16, 7) },
      { megolmSessionId: 's' },
      { ciphertext: Uint8Array.of(9, 8) },
    ]) {
      expect(hex(meshEnvelopeMessage({ ...statement, ...changed }))).not.toBe(base);
    }
    expect(() => meshEnvelopeMessage({ ...statement, dst: bytes(17, 1) })).toThrow(ProtocolError);
  });

  it('bind an ACK to its link, packet and status', () => {
    const message = meshAckMessage(bytes(16, 1), bytes(16, 2), MeshAckStatus.ACCEPTED);
    expect(message.length).toBe('pingdost/mesh-ack/v1'.length + 1 + 16 + 16 + 4);
    expect(meshAckMessage(bytes(16, 1), bytes(16, 2), MeshAckStatus.DELIVERED)).not.toEqual(
      message,
    );
    expect(() => meshAckMessage(bytes(15, 1), bytes(16, 2), 1)).toThrow(ProtocolError);
  });
});
