/** The protocol major version in `TransportPacket.version`, `ContentHeader.version` and `Auth`. */
export const PROTOCOL_VERSION = 1;

/** Default `ENVELOPE_MAX_BYTES` (ARCHITECTURE A4, A11). */
export const DEFAULT_ENVELOPE_MAX_BYTES = 65_536;

/** ADR 0004: a 64 KiB plaintext chunk is 65,552 bytes of ciphertext. */
export const ATTACHMENT_CHUNK_CIPHERTEXT_BYTES = 65_552;

/** Largest `MeshChunk` payload: one ciphertext chunk plus its chunk reference. */
export const MESH_CHUNK_MAX_BYTES = ATTACHMENT_CHUNK_CIPHERTEXT_BYTES + 256;

/** Room for the `TransportPacket` fields around its payload. */
export const PACKET_OVERHEAD_BYTES = 256;

/** Room for the WebSocket frame fields around a packet. */
export const FRAME_OVERHEAD_BYTES = 256;

/** Room for the Olm/Megolm framing and the other `Envelope` fields around a Content. */
export const CIPHERTEXT_OVERHEAD_BYTES = 1024;

/** Longest `TransportPacket.dst` (a device ID is 16 bytes; mesh routing tokens fit too). */
export const MAX_DST_BYTES = 64;

export interface CodecOptions {
  /** `ENVELOPE_MAX_BYTES`; default 64 KiB. Every other limit derives from it. */
  envelopeMaxBytes?: number;
  /** The current time for expiry checks, epoch milliseconds; default `Date.now()`. */
  nowMs?: number;
}

export interface Limits {
  envelope: number;
  /** An encoded, padded Content: it must fit in an envelope once encrypted. */
  content: number;
  packet: number;
  frame: number;
}

export function limitsFor(options: CodecOptions = {}): Limits {
  const envelope = options.envelopeMaxBytes ?? DEFAULT_ENVELOPE_MAX_BYTES;
  const payload = Math.max(envelope, MESH_CHUNK_MAX_BYTES);
  return {
    envelope,
    content: envelope - CIPHERTEXT_OVERHEAD_BYTES,
    packet: payload + PACKET_OVERHEAD_BYTES,
    frame: payload + PACKET_OVERHEAD_BYTES + FRAME_OVERHEAD_BYTES,
  };
}
