/**
 * The QR code a browser shows to be linked (REQ §13.1, ADR 0019). It names one pairing request
 * and the browser's identity keys, and nothing in it grants access on its own: the phone must
 * approve with its own keys, and the browser must then prove it holds the keys shown.
 */
import { ProtocolError } from './errors';
import { fromBase64, toBase64Url, uuidToBytes } from './ids';
import { KEY_BYTES, NONCE_BYTES } from './signing';

export const PAIRING_QR_PREFIX = 'pingdost-pair:v1:';

export interface PairingQr {
  pairingId: string;
  /** 32 random bytes, base64url: must match the server's copy when the phone approves. */
  challenge: string;
  /** The browser's Olm identity keys (unpadded base64). */
  curve25519: string;
  ed25519: string;
  /** The web app's origin as the browser saw it (shown to the user; not trusted alone). */
  origin: string;
}

interface Wire {
  p: string;
  c: string;
  k: string;
  e: string;
  o: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function bytesOf(value: unknown, length: number, field: string): string {
  if (typeof value !== 'string' || value.length > 64) {
    throw new ProtocolError('INVALID_FIELD', `${field} is missing`, field);
  }
  if (fromBase64(value).length !== length) {
    throw new ProtocolError('INVALID_FIELD', `${field} must be ${length} bytes`, field);
  }
  return value;
}

function originOf(value: unknown): string {
  if (typeof value !== 'string' || value.length > 255) {
    throw new ProtocolError('INVALID_FIELD', 'origin is missing', 'origin');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProtocolError('INVALID_FIELD', 'origin is not a URL', 'origin');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== value) {
    throw new ProtocolError('INVALID_FIELD', 'origin must be an http(s) origin', 'origin');
  }
  return value;
}

export function encodePairingQr(qr: PairingQr): string {
  const wire: Wire = {
    p: qr.pairingId,
    c: qr.challenge,
    k: qr.curve25519,
    e: qr.ed25519,
    o: qr.origin,
  };
  return PAIRING_QR_PREFIX + toBase64Url(encoder.encode(JSON.stringify(wire)));
}

/** Reads a scanned code; throws `ProtocolError` for anything that is not a valid pairing QR. */
export function parsePairingQr(text: string): PairingQr {
  if (!text.startsWith(PAIRING_QR_PREFIX) || text.length > 1_024) {
    throw new ProtocolError('INVALID_FIELD', 'not a PingDost pairing code', 'qr');
  }
  let wire: Partial<Wire>;
  try {
    wire = JSON.parse(
      decoder.decode(fromBase64(text.slice(PAIRING_QR_PREFIX.length))),
    ) as Partial<Wire>;
  } catch {
    throw new ProtocolError('INVALID_FIELD', 'the pairing code is damaged', 'qr');
  }
  if (typeof wire !== 'object' || wire === null) {
    throw new ProtocolError('INVALID_FIELD', 'the pairing code is damaged', 'qr');
  }
  if (typeof wire.p !== 'string')
    throw new ProtocolError('INVALID_FIELD', 'no pairing ID', 'pairing_id');
  uuidToBytes(wire.p);
  return {
    pairingId: wire.p,
    challenge: bytesOf(wire.c, NONCE_BYTES, 'challenge'),
    curve25519: bytesOf(wire.k, KEY_BYTES, 'curve25519'),
    ed25519: bytesOf(wire.e, KEY_BYTES, 'ed25519'),
    origin: originOf(wire.o),
  };
}
