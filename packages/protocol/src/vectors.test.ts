import {
  createRegistry,
  equals,
  fromBinary,
  fromJson,
  toBinary,
  type DescEnum,
} from '@bufbuild/protobuf';
import { describe, expect, it } from 'vitest';

import stored from '@pingdost/test-fixtures/protocol/v1.json';

import {
  decodeClientFrame,
  decodeContent,
  decodeEnvelope,
  decodeServerFrame,
  decodeTransportPacket,
} from './codec';
import { ContentSchema, file_pingdost_v1_content } from './gen/pingdost/v1/content_pb';
import { CryptoTypeSchema, file_pingdost_v1_envelope } from './gen/pingdost/v1/envelope_pb';
import { file_pingdost_v1_mesh } from './gen/pingdost/v1/mesh_pb';
import { file_pingdost_v1_packet, PacketKindSchema } from './gen/pingdost/v1/packet_pb';
import { ClientFrameSchema, file_pingdost_v1_ws, ServerFrameSchema } from './gen/pingdost/v1/ws_pb';
import { fromBase64 } from './ids';
import { createVectors, type ProtocolVectors } from './vectors';

const golden = stored as unknown as ProtocolVectors;
const registry = createRegistry(
  file_pingdost_v1_content,
  file_pingdost_v1_envelope,
  file_pingdost_v1_mesh,
  file_pingdost_v1_packet,
  file_pingdost_v1_ws,
);
const decoders: Record<string, (bytes: Uint8Array, options: { nowMs: number }) => unknown> = {
  'pingdost.v1.TransportPacket': decodeTransportPacket,
  'pingdost.v1.Envelope': decodeEnvelope,
  'pingdost.v1.Content': decodeContent,
  'pingdost.v1.ClientFrame': decodeClientFrame,
  'pingdost.v1.ServerFrame': decodeServerFrame,
};

function schemaFor(type: string) {
  const schema = registry.getMessage(type);
  if (!schema) throw new Error(`unknown type ${type}`);
  return schema;
}

describe('golden protocol vectors (test-fixtures/protocol/v1.json)', () => {
  it('match the vector sources (regenerate with make-vectors only for a deliberate wire change)', () => {
    expect(createVectors()).toEqual(golden);
  });

  it.each(golden.vectors.map((vector) => [vector.name, vector] as const))(
    '%s: bytes and JSON agree, and the codec accepts it',
    (_name, vector) => {
      const schema = schemaFor(vector.type);
      const bytes = fromBase64(vector.binary);
      const fromBytes = fromBinary(schema, bytes);
      const fromJsonValue = fromJson(schema, vector.json);
      expect(equals(schema, fromBytes, fromJsonValue)).toBe(true);
      expect(toBinary(schema, fromJsonValue)).toEqual(bytes);
      decoders[vector.type]?.(bytes, { nowMs: golden.nowMs });
    },
  );

  it('cover every oneof body, packet kind and crypto type', () => {
    const names = new Set(golden.vectors.map((vector) => vector.name));
    const kebab = (name: string) => name.replaceAll('_', '-');
    const bodies = (
      schema: typeof ContentSchema | typeof ClientFrameSchema | typeof ServerFrameSchema,
      prefix: string,
    ) =>
      schema.oneofs.flatMap((oneof) =>
        oneof.fields.map((field) => `${prefix}/${kebab(field.name)}`),
      );
    const values = (schema: DescEnum, prefix: string) =>
      schema.values
        .filter((value) => value.number !== 0)
        .map((value) => `${prefix}/${kebab(value.localName.toLowerCase())}`);

    const expected = [
      ...bodies(ContentSchema, 'content'),
      ...bodies(ClientFrameSchema, 'client-frame'),
      ...bodies(ServerFrameSchema, 'server-frame'),
      ...values(PacketKindSchema, 'packet'),
      ...values(CryptoTypeSchema, 'envelope'),
      'ack',
      'mesh-ack',
      'mesh-chunk',
      'hello',
      'mesh-header',
    ];
    expect(expected.filter((name) => !names.has(name))).toEqual([]);
  });
});
