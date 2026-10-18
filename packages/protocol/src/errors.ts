/** Why the codec rejected a protocol message. */
export type ProtocolErrorCode =
  /** Larger than the configured limit (`ENVELOPE_MAX_BYTES` and derived limits). */
  | 'OVERSIZED'
  /** Not valid protobuf for the expected message. */
  | 'MALFORMED'
  /** A protocol major version this build does not speak. */
  | 'UNSUPPORTED_VERSION'
  /** A oneof body this build does not know (sent by a newer client or server). */
  | 'UNKNOWN_BODY'
  /** Past its absolute expiry. */
  | 'EXPIRED'
  | 'MISSING_FIELD'
  | 'INVALID_FIELD';

/**
 * Thrown by the codecs and ID helpers. Messages name the rule and the field only: never
 * payload bytes, keys or plaintext (ARCHITECTURE A10).
 */
export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;
  /** The offending field's proto name, when there is one. */
  readonly field: string | undefined;

  constructor(code: ProtocolErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.field = field;
  }
}
