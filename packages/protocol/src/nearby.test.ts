// The nearby handshake's wire pieces (ADR 0024): Hello and Ack codecs and the signed statement.
import { create } from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';

import { decodeAck, decodeHello, encodeAck, encodeHello, MAX_ACK_IDS } from './codec';
import { ProtocolError } from './errors';
import { HelloCapability, HelloProofSchema, HelloSchema } from './gen/pingdost/v1/mesh_pb';
import { AckSchema } from './gen/pingdost/v1/packet_pb';
import { toBase64, uuidv7Bytes } from './ids';
import { HELLO_TOKEN_BYTES, nearbyHelloMessage, SIGNING_CONTEXTS } from './signing';

const token = (fill: number) => new Uint8Array(HELLO_TOKEN_BYTES).fill(fill);
const KEY = toBase64(new Uint8Array(32).fill(2)).replace(/=+$/, '');

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('Hello', () => {
  it('round-trips both stages', () => {
    const first = create(HelloSchema, {
      protocolVersion: 1,
      peerToken: token(1),
      capabilities: HelloCapability.DIRECT,
    });
    expect(decodeHello(encodeHello(first))).toEqual(first);
    const second = create(HelloSchema, {
      ...first,
      proof: create(HelloProofSchema, {
        identityKey: new Uint8Array(32).fill(2),
        signature: new Uint8Array(64).fill(3),
      }),
    });
    expect(decodeHello(encodeHello(second)).proof?.signature).toEqual(second.proof?.signature);
  });

  it('accepts a newer version but rejects a missing one, bad tokens and bad proofs', () => {
    const base = { protocolVersion: 2, peerToken: token(1) };
    expect(decodeHello(encodeHello(create(HelloSchema, base))).protocolVersion).toBe(2);
    expect(() => encodeHello(create(HelloSchema, { ...base, protocolVersion: 0 }))).toThrow(
      ProtocolError,
    );
    expect(() =>
      encodeHello(create(HelloSchema, { ...base, peerToken: token(1).slice(1) })),
    ).toThrow(ProtocolError);
    const proof = (identityKey: number, signature: number) =>
      create(HelloSchema, {
        ...base,
        proof: create(HelloProofSchema, {
          identityKey: new Uint8Array(identityKey),
          signature: new Uint8Array(signature),
        }),
      });
    expect(() => encodeHello(proof(31, 64))).toThrow(ProtocolError);
    expect(() => encodeHello(proof(32, 63))).toThrow(ProtocolError);
    expect(() => decodeHello(new Uint8Array(600))).toThrow(ProtocolError);
    expect(() => decodeHello(Uint8Array.of(0xff, 0xff))).toThrow(ProtocolError);
  });
});

describe('Ack', () => {
  it('round-trips and bounds its IDs', () => {
    const ids = [uuidv7Bytes(), uuidv7Bytes()];
    expect(decodeAck(encodeAck(create(AckSchema, { envelopeIds: ids }))).envelopeIds).toEqual(ids);
    expect(() => encodeAck(create(AckSchema, { envelopeIds: [] }))).toThrow(ProtocolError);
    expect(() => encodeAck(create(AckSchema, { envelopeIds: [new Uint8Array(15)] }))).toThrow(
      ProtocolError,
    );
    const many = Array.from({ length: MAX_ACK_IDS + 1 }, () => uuidv7Bytes());
    expect(() => encodeAck(create(AckSchema, { envelopeIds: many }))).toThrow(ProtocolError);
  });
});

describe('nearbyHelloMessage', () => {
  it('encodes exactly (golden)', () => {
    const message = nearbyHelloMessage(token(0xaa), token(0xbb), KEY, 3);
    const prefix = `${hex(new TextEncoder().encode(SIGNING_CONTEXTS.nearbyHello))}00`;
    expect(hex(message)).toBe(
      `${prefix}${'aa'.repeat(16)}${'bb'.repeat(16)}${'02'.repeat(32)}00000003`,
    );
  });

  it('differs per direction, so one side cannot reflect the other side’s proof', () => {
    expect(hex(nearbyHelloMessage(token(1), token(2), KEY, 1))).not.toBe(
      hex(nearbyHelloMessage(token(2), token(1), KEY, 1)),
    );
  });

  it('rejects tokens, keys and capabilities of the wrong shape', () => {
    expect(() => nearbyHelloMessage(token(1).slice(1), token(2), KEY, 1)).toThrow(ProtocolError);
    expect(() => nearbyHelloMessage(token(1), new Uint8Array(17), KEY, 1)).toThrow(ProtocolError);
    expect(() => nearbyHelloMessage(token(1), token(2), 'AAAA', 1)).toThrow(ProtocolError);
    expect(() => nearbyHelloMessage(token(1), token(2), KEY, -1)).toThrow(ProtocolError);
    expect(() => nearbyHelloMessage(token(1), token(2), KEY, 2 ** 32)).toThrow(ProtocolError);
  });
});
