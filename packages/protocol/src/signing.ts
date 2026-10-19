/**
 * The exact bytes that devices and the account identity key sign (ADR 0003, ADR 0008).
 * Every statement starts with its own context string and a NUL byte, so a signature made for
 * one purpose can never be presented as another. Fields have fixed lengths, except a
 * length-prefixed key ID, so the encoding is unambiguous.
 */
import { ProtocolError } from './errors';
import { fromBase64, uuidToBytes, UUID_BYTES } from './ids';

export const SIGNING_CONTEXTS = {
  /** Signed by the account identity key: this device belongs to the account. */
  deviceCertificate: 'pingdost/device-certificate/v1',
  /** Signed by the device's ed25519 key at registration: proof of possession. */
  deviceRegistration: 'pingdost/device-registration/v1',
  /** Signed by the device's ed25519 key for each published one-time key. */
  oneTimeKey: 'pingdost/one-time-key/v1',
  /** Signed by the device's ed25519 key for its fallback key. */
  fallbackKey: 'pingdost/fallback-key/v1',
} as const;

export const KEY_BYTES = 32;
export const NONCE_BYTES = 32;
const MAX_KEY_ID_BYTES = 64;

export interface DeviceIdentityKeys {
  /** Unpadded base64, as vodozemac reports them. */
  curve25519: string;
  ed25519: string;
}

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function context(label: string): Uint8Array {
  return concat([encoder.encode(label), Uint8Array.of(0)]);
}

function deviceIdBytes(deviceId: string | Uint8Array): Uint8Array {
  const bytes = typeof deviceId === 'string' ? uuidToBytes(deviceId) : deviceId;
  if (bytes.length !== UUID_BYTES) {
    throw new ProtocolError('INVALID_FIELD', `a device ID is ${UUID_BYTES} bytes`, 'device_id');
  }
  return bytes;
}

function exactBytes(base64: string, length: number, field: string): Uint8Array {
  const bytes = fromBase64(base64);
  if (bytes.length !== length) {
    throw new ProtocolError('INVALID_FIELD', `${field} must be ${length} bytes`, field);
  }
  return bytes;
}

function identityBytes(keys: DeviceIdentityKeys): Uint8Array[] {
  return [
    exactBytes(keys.curve25519, KEY_BYTES, 'curve25519'),
    exactBytes(keys.ed25519, KEY_BYTES, 'ed25519'),
  ];
}

/** context ‖ deviceId (16) ‖ curve25519 (32) ‖ ed25519 (32). */
export function deviceCertificateMessage(
  deviceId: string | Uint8Array,
  keys: DeviceIdentityKeys,
): Uint8Array {
  return concat([
    context(SIGNING_CONTEXTS.deviceCertificate),
    deviceIdBytes(deviceId),
    ...identityBytes(keys),
  ]);
}

/** context ‖ nonce (32) ‖ deviceId (16) ‖ curve25519 (32) ‖ ed25519 (32). */
export function deviceRegistrationMessage(
  nonce: string | Uint8Array,
  deviceId: string | Uint8Array,
  keys: DeviceIdentityKeys,
): Uint8Array {
  const nonceBytes = typeof nonce === 'string' ? exactBytes(nonce, NONCE_BYTES, 'nonce') : nonce;
  if (nonceBytes.length !== NONCE_BYTES) {
    throw new ProtocolError('INVALID_FIELD', `nonce must be ${NONCE_BYTES} bytes`, 'nonce');
  }
  return concat([
    context(SIGNING_CONTEXTS.deviceRegistration),
    nonceBytes,
    deviceIdBytes(deviceId),
    ...identityBytes(keys),
  ]);
}

/** context ‖ deviceId (16) ‖ keyId length (1) ‖ keyId (UTF-8) ‖ publicKey (32). */
export function signedKeyMessage(
  kind: 'one_time' | 'fallback',
  deviceId: string | Uint8Array,
  keyId: string,
  publicKey: string,
): Uint8Array {
  const id = encoder.encode(keyId);
  if (id.length === 0 || id.length > MAX_KEY_ID_BYTES) {
    throw new ProtocolError(
      'INVALID_FIELD',
      `key_id must be 1-${MAX_KEY_ID_BYTES} bytes`,
      'key_id',
    );
  }
  return concat([
    context(kind === 'one_time' ? SIGNING_CONTEXTS.oneTimeKey : SIGNING_CONTEXTS.fallbackKey),
    deviceIdBytes(deviceId),
    Uint8Array.of(id.length),
    id,
    exactBytes(publicKey, KEY_BYTES, 'public_key'),
  ]);
}
