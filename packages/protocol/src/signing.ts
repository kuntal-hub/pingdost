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
  /** Signed by the primary phone's device key: it approves this browser (ADR 0019). */
  pairingApproval: 'pingdost/pairing-approval/v1',
  /** Hashed (not signed) into the check code both phones show for a phone change (ADR 0022). */
  primaryTransferCode: 'pingdost/primary-transfer-code/v1',
  /** The approving phone's Olm message to the new phone: the account identity key (ADR 0022). */
  primaryTransferPayload: 'pingdost/primary-transfer-payload/v1',
  /** Signed by a device's ed25519 key in the nearby handshake (ADR 0024). */
  nearbyHello: 'pingdost/nearby-hello/v1',
  /** Hashed (not signed) with a device ID and a day into a mesh routing token (ADR 0025). */
  meshRoute: 'pingdost/mesh-route/v1',
  /** Signed by the sender device's ed25519 key for each relayed envelope (ADR 0025). */
  meshEnvelope: 'pingdost/mesh-envelope/v1',
  /** Signed by the answering device's ed25519 key for each mesh ACK (ADR 0025). */
  meshAck: 'pingdost/mesh-ack/v1',
} as const;

export const KEY_BYTES = 32;
export const NONCE_BYTES = 32;
/** `Hello.peer_token`: fresh random bytes per nearby link (ADR 0024). */
export const HELLO_TOKEN_BYTES = 16;
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

/**
 * context ‖ pairingId (16) ‖ challenge (32) ‖ webDeviceId (16) ‖ curve25519 (32) ‖ ed25519 (32):
 * the phone approves exactly this pairing request for exactly these browser keys.
 */
export function pairingApprovalMessage(
  pairingId: string,
  challenge: string,
  webDeviceId: string,
  webKeys: DeviceIdentityKeys,
): Uint8Array {
  return concat([
    context(SIGNING_CONTEXTS.pairingApproval),
    deviceIdBytes(pairingId),
    exactBytes(challenge, NONCE_BYTES, 'challenge'),
    deviceIdBytes(webDeviceId),
    ...identityBytes(webKeys),
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

/**
 * context ‖ requestId (16) ‖ deviceId (16) ‖ curve25519 (32) ‖ ed25519 (32). Both phones hash
 * this (SHA-256) and show `primaryTransferCode(digest)`: equal codes mean the old phone is
 * about to certify exactly the keys the new phone made (ADR 0022).
 */
export function primaryTransferCodeMessage(
  requestId: string,
  deviceId: string,
  keys: DeviceIdentityKeys,
): Uint8Array {
  return concat([
    context(SIGNING_CONTEXTS.primaryTransferCode),
    deviceIdBytes(requestId),
    deviceIdBytes(deviceId),
    ...identityBytes(keys),
  ]);
}

/**
 * context ‖ signer's token (16) ‖ other side's token (16) ‖ ed25519 (32) ‖ capabilities (4,
 * big-endian): this key speaks on exactly this link, with these capabilities (ADR 0024).
 */
export function nearbyHelloMessage(
  ownToken: Uint8Array,
  peerToken: Uint8Array,
  identityKey: string,
  capabilities: number,
): Uint8Array {
  for (const [token, field] of [
    [ownToken, 'own_token'],
    [peerToken, 'peer_token'],
  ] as const) {
    if (token.length !== HELLO_TOKEN_BYTES) {
      throw new ProtocolError(
        'INVALID_FIELD',
        `${field} must be ${HELLO_TOKEN_BYTES} bytes`,
        field,
      );
    }
  }
  if (!Number.isInteger(capabilities) || capabilities < 0 || capabilities > 0xffff_ffff) {
    throw new ProtocolError('INVALID_FIELD', 'capabilities must be a uint32', 'capabilities');
  }
  const caps = new Uint8Array(4);
  new DataView(caps.buffer).setUint32(0, capabilities);
  return concat([
    context(SIGNING_CONTEXTS.nearbyHello),
    ownToken,
    peerToken,
    exactBytes(identityKey, KEY_BYTES, 'identity_key'),
    caps,
  ]);
}

/** A routing token or link token in a mesh statement: exactly 16 bytes. */
export const MESH_TOKEN_BYTES = 16;

function fixed(bytes: Uint8Array, length: number, field: string): Uint8Array {
  if (bytes.length !== length) {
    throw new ProtocolError('INVALID_FIELD', `${field} must be ${length} bytes`, field);
  }
  return bytes;
}

function uint(value: number | bigint, bytes: 2 | 4 | 8, field: string): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  const max = bytes === 8 ? 0xffff_ffff_ffff_ffffn : BigInt(2 ** (bytes * 8) - 1);
  const big = BigInt(value);
  if (big < 0n || big > max) {
    throw new ProtocolError('INVALID_FIELD', `${field} must fit in ${bytes} bytes`, field);
  }
  if (bytes === 8) view.setBigUint64(0, big);
  else if (bytes === 4) view.setUint32(0, Number(big));
  else view.setUint16(0, Number(big));
  return out;
}

/** The fields of a relayed envelope that its sender signs (ADR 0025). */
export interface MeshEnvelopeStatement {
  packetId: Uint8Array;
  createdAtMs: bigint;
  expiresAtMs: bigint;
  /** The recipient's routing token (`TransportPacket.dst`). */
  dst: Uint8Array;
  originToken: Uint8Array;
  envelopeId: Uint8Array;
  cryptoType: number;
  groupId?: Uint8Array | undefined;
  megolmSessionId: string;
  ciphertext: Uint8Array;
}

/**
 * context ‖ packet ID (16) ‖ created (8) ‖ expires (8) ‖ dst (16) ‖ origin token (16) ‖
 * envelope ID (16) ‖ crypto type (4) ‖ has group (1) ‖ group ID (16 or none) ‖ session ID
 * length (2) ‖ session ID (UTF-8) ‖ ciphertext, integers big-endian. Everything a relay must not
 * change; the hop budget and spray copies are left out because relays change them.
 */
export function meshEnvelopeMessage(statement: MeshEnvelopeStatement): Uint8Array {
  const session = encoder.encode(statement.megolmSessionId);
  return concat([
    context(SIGNING_CONTEXTS.meshEnvelope),
    fixed(statement.packetId, UUID_BYTES, 'packet_id'),
    uint(statement.createdAtMs, 8, 'created_at_ms'),
    uint(statement.expiresAtMs, 8, 'expires_at_ms'),
    fixed(statement.dst, MESH_TOKEN_BYTES, 'dst'),
    fixed(statement.originToken, MESH_TOKEN_BYTES, 'origin_token'),
    fixed(statement.envelopeId, UUID_BYTES, 'envelope_id'),
    uint(statement.cryptoType, 4, 'crypto_type'),
    statement.groupId === undefined
      ? Uint8Array.of(0)
      : concat([Uint8Array.of(1), fixed(statement.groupId, UUID_BYTES, 'group_id')]),
    uint(session.length, 2, 'megolm_session_id'),
    session,
    statement.ciphertext,
  ]);
}

/**
 * context ‖ the other side's link token (16) ‖ packet ID (16) ‖ status (4, big-endian): this
 * device answered this packet so, on exactly this link (ADR 0025).
 */
export function meshAckMessage(
  linkToken: Uint8Array,
  packetId: Uint8Array,
  status: number,
): Uint8Array {
  return concat([
    context(SIGNING_CONTEXTS.meshAck),
    fixed(linkToken, HELLO_TOKEN_BYTES, 'link_token'),
    fixed(packetId, UUID_BYTES, 'packet_id'),
    uint(status, 4, 'status'),
  ]);
}

/** The bytes hashed into a routing token: context ‖ device ID (16) ‖ UTC day (4, big-endian). */
export function meshRouteInput(deviceId: string | Uint8Array, day: number): Uint8Array {
  return concat([
    context(SIGNING_CONTEXTS.meshRoute),
    deviceIdBytes(deviceId),
    uint(day, 4, 'day'),
  ]);
}

/** Six digits from a SHA-256 digest, shown as "123 456". */
export function primaryTransferCode(digest: Uint8Array): string {
  if (digest.length < 4) throw new ProtocolError('INVALID_FIELD', 'digest too short', 'digest');
  const value = new DataView(digest.buffer, digest.byteOffset, 4).getUint32(0) % 1_000_000;
  const digits = String(value).padStart(6, '0');
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** What the old phone seals to the new phone over Olm (JSON inside the context prefix). */
export interface PrimaryTransferPayload {
  requestId: string;
  userId: string;
  /** `SigningKey.exportSecret()`. Secret. */
  accountIdentityKeySecret: string;
}

export function encodePrimaryTransferPayload(payload: PrimaryTransferPayload): Uint8Array {
  return concat([
    context(SIGNING_CONTEXTS.primaryTransferPayload),
    encoder.encode(JSON.stringify(payload)),
  ]);
}

export function decodePrimaryTransferPayload(bytes: Uint8Array): PrimaryTransferPayload {
  const prefix = context(SIGNING_CONTEXTS.primaryTransferPayload);
  if (bytes.length <= prefix.length || !prefix.every((b, i) => bytes[i] === b)) {
    throw new ProtocolError('INVALID_FIELD', 'not a transfer payload', 'payload');
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes.subarray(prefix.length)));
  } catch {
    throw new ProtocolError('INVALID_FIELD', 'malformed transfer payload', 'payload');
  }
  const v = value as Partial<PrimaryTransferPayload> | null;
  if (
    typeof v?.requestId !== 'string' ||
    typeof v.userId !== 'string' ||
    typeof v.accountIdentityKeySecret !== 'string'
  ) {
    throw new ProtocolError('INVALID_FIELD', 'malformed transfer payload', 'payload');
  }
  return {
    requestId: v.requestId,
    userId: v.userId,
    accountIdentityKeySecret: v.accountIdentityKeySecret,
  };
}
