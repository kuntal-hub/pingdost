/**
 * Mesh routing tokens and the envelope ⇄ mesh envelope mapping (ADR 0025).
 *
 * A routing token names a device for one UTC day: the first 16 bytes of
 * SHA-256(`meshRouteInput(deviceId, day)`). It is a hash of identifiers, not a key: whoever
 * knows the device ID (its contacts, the server) can compute it; a relay that does not cannot
 * turn it back into the device ID. Relayed packets carry the recipient's token as `dst` and
 * the sender's as `origin_token`, for the day the packet was made, so a relay never sees a
 * device ID.
 */
import { create } from '@bufbuild/protobuf';
import { sha256 } from '@noble/hashes/sha2.js';

import { EnvelopeSchema, type Envelope } from './gen/pingdost/v1/envelope_pb';
import { MeshEnvelopeSchema, type MeshEnvelope } from './gen/pingdost/v1/mesh_pb';
import { MESH_TOKEN_BYTES, meshRouteInput } from './signing';

export const DAY_MS = 86_400_000;

/** The UTC day number of an epoch-millisecond time. */
export function meshDay(ms: number | bigint): number {
  return Math.floor(Number(ms) / DAY_MS);
}

/** The device's routing token for one UTC day. */
export function meshRoutingToken(deviceId: string | Uint8Array, day: number): Uint8Array {
  return sha256(meshRouteInput(deviceId, day)).slice(0, MESH_TOKEN_BYTES);
}

/**
 * Every token a live packet to this device can carry: one per day from `now - ttl` to
 * `now + 1 day` (the sender's clock may run ahead), newest first.
 */
export function meshRoutingTokens(
  deviceId: string | Uint8Array,
  nowMs: number,
  ttlMs: number,
): Uint8Array[] {
  const tokens: Uint8Array[] = [];
  for (let day = meshDay(nowMs + DAY_MS); day >= meshDay(nowMs - ttlMs); day--) {
    tokens.push(meshRoutingToken(deviceId, day));
  }
  return tokens;
}

/** The Envelope's fields a relay may see, plus the sender's token; unsigned until signed. */
export function toMeshEnvelope(envelope: Envelope, originToken: Uint8Array): MeshEnvelope {
  return create(MeshEnvelopeSchema, {
    originToken,
    envelopeId: envelope.envelopeId,
    cryptoType: envelope.cryptoType,
    ...(envelope.groupId === undefined ? {} : { groupId: envelope.groupId }),
    megolmSessionId: envelope.megolmSessionId,
    ciphertext: envelope.ciphertext,
  });
}

/** The Envelope again, once the recipient resolved the sender's token. */
export function fromMeshEnvelope(
  mesh: MeshEnvelope,
  senderDeviceId: Uint8Array,
  recipientDeviceId: Uint8Array,
): Envelope {
  return create(EnvelopeSchema, {
    envelopeId: mesh.envelopeId,
    senderDeviceId,
    recipientDeviceId,
    cryptoType: mesh.cryptoType,
    ...(mesh.groupId === undefined ? {} : { groupId: mesh.groupId }),
    megolmSessionId: mesh.megolmSessionId,
    ciphertext: mesh.ciphertext,
  });
}
