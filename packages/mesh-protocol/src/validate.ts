/**
 * What a device checks before it stores, forwards or opens a relayed packet (REQ §11.4):
 * expired, malformed, oversized and over-budget packets are dropped. The signature is not
 * checked here: only the recipient holds the sender's key (ADR 0025).
 */
import {
  bytesEqual,
  decodeMeshChunk,
  decodeMeshEnvelope,
  MESH_TOKEN_BYTES,
  meshChunkDigest,
  meshChunkPacketId,
  PacketKind,
  ProtocolError,
  type MeshChunk,
  type MeshEnvelope,
  type TransportPacket,
} from '@pingdost/protocol';

import type { MeshPolicy } from './policy';

export type MeshRejection =
  | 'wrong_kind'
  | 'malformed'
  | 'oversized'
  | 'expired'
  | 'from_future'
  | 'ttl_too_long'
  | 'over_budget'
  | 'bad_copies';

export type MeshCheck = { ok: true; envelope: MeshEnvelope } | { ok: false; reason: MeshRejection };

/**
 * Checks a decoded `MESH_ENVELOPE` packet (the transport codec already checked the version,
 * IDs, sizes and expiry at `nowMs`) against the relay policy, and decodes its payload.
 */
export function checkMeshPacket(
  packet: TransportPacket,
  policy: HeaderPolicy,
  nowMs: number,
  envelopeMaxBytes?: number,
): MeshCheck {
  if (packet.kind !== PacketKind.MESH_ENVELOPE) return { ok: false, reason: 'wrong_kind' };
  const header = checkHeader(packet, policy, nowMs);
  if (header) return { ok: false, reason: header };
  try {
    const envelope = decodeMeshEnvelope(
      packet.payload,
      envelopeMaxBytes === undefined ? {} : { envelopeMaxBytes },
    );
    return { ok: true, envelope };
  } catch (error) {
    const oversized = error instanceof ProtocolError && error.code === 'OVERSIZED';
    return { ok: false, reason: oversized ? 'oversized' : 'malformed' };
  }
}

type HeaderPolicy = Pick<MeshPolicy, 'maxHops' | 'ttlMs' | 'maxCopies' | 'clockSkewMs'>;

/** The relay header rules every mesh packet follows. */
function checkHeader(
  packet: TransportPacket,
  policy: HeaderPolicy,
  nowMs: number,
): MeshRejection | undefined {
  if (packet.dst.length !== MESH_TOKEN_BYTES) return 'malformed';
  const created = Number(packet.createdAtMs);
  const expires = Number(packet.expiresAtMs);
  if (expires <= nowMs) return 'expired';
  if (created > nowMs + policy.clockSkewMs) return 'from_future';
  if (expires - created > policy.ttlMs + policy.clockSkewMs) return 'ttl_too_long';
  if (packet.hopBudget > policy.maxHops) return 'over_budget';
  if (packet.copies < 1 || packet.copies > policy.maxCopies) return 'bad_copies';
  return undefined;
}

export type MeshChunkCheck =
  { ok: true; chunk: MeshChunk } | { ok: false; reason: MeshRejection | 'corrupt' };

/**
 * Checks a decoded `MESH_CHUNK` packet (ADR 0027): the header rules, the payload, the packet ID
 * (`meshChunkPacketId` of its transfer and index) and the data against its own hash, so a
 * holder drops a corrupt chunk instead of carrying it. Only the recipient checks the signature.
 */
export function checkMeshChunkPacket(
  packet: TransportPacket,
  policy: HeaderPolicy,
  nowMs: number,
): MeshChunkCheck {
  if (packet.kind !== PacketKind.MESH_CHUNK) return { ok: false, reason: 'wrong_kind' };
  const header = checkHeader(packet, policy, nowMs);
  if (header) return { ok: false, reason: header };
  let chunk: MeshChunk;
  try {
    chunk = decodeMeshChunk(packet.payload);
  } catch (error) {
    const oversized = error instanceof ProtocolError && error.code === 'OVERSIZED';
    return { ok: false, reason: oversized ? 'oversized' : 'malformed' };
  }
  const ref = chunk.ref!;
  if (!bytesEqual(meshChunkPacketId(ref.transferId, ref.index), packet.packetId)) {
    return { ok: false, reason: 'malformed' };
  }
  if (!bytesEqual(meshChunkDigest(chunk.data), ref.chunkSha256)) {
    return { ok: false, reason: 'corrupt' };
  }
  return { ok: true, chunk };
}

/** Binary spray-and-wait: hand half the copies on, keep the rest (at least one). */
export function splitCopies(copies: number): { give: number; keep: number } {
  const give = Math.floor(copies / 2);
  return { give, keep: copies - give };
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
