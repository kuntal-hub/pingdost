/**
 * What a device checks before it stores, forwards or opens a relayed packet (REQ §11.4):
 * expired, malformed, oversized and over-budget packets are dropped. The signature is not
 * checked here: only the recipient holds the sender's key (ADR 0025).
 */
import {
  decodeMeshEnvelope,
  MESH_TOKEN_BYTES,
  PacketKind,
  ProtocolError,
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
  policy: Pick<MeshPolicy, 'maxHops' | 'ttlMs' | 'maxCopies' | 'clockSkewMs'>,
  nowMs: number,
  envelopeMaxBytes?: number,
): MeshCheck {
  if (packet.kind !== PacketKind.MESH_ENVELOPE) return { ok: false, reason: 'wrong_kind' };
  if (packet.dst.length !== MESH_TOKEN_BYTES) return { ok: false, reason: 'malformed' };
  const created = Number(packet.createdAtMs);
  const expires = Number(packet.expiresAtMs);
  if (expires <= nowMs) return { ok: false, reason: 'expired' };
  if (created > nowMs + policy.clockSkewMs) return { ok: false, reason: 'from_future' };
  if (expires - created > policy.ttlMs + policy.clockSkewMs) {
    return { ok: false, reason: 'ttl_too_long' };
  }
  if (packet.hopBudget > policy.maxHops) return { ok: false, reason: 'over_budget' };
  if (packet.copies < 1 || packet.copies > policy.maxCopies) {
    return { ok: false, reason: 'bad_copies' };
  }
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
