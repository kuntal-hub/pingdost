/** Mirrors the Rust `CryptoError` variants in `crates/pingdost-crypto`. */
export type CryptoErrorCode =
  | 'InvalidKey'
  | 'InvalidMessage'
  | 'InvalidSignature'
  | 'SessionCreation'
  | 'Encryption'
  | 'Decryption'
  | 'Pickle'
  | 'InvalidArgument'
  | 'Internal';

/**
 * Thrown by every `CryptoProvider` operation. Messages are fixed strings from the Rust
 * wrapper: they never contain keys, plaintext or ciphertext (ARCHITECTURE A10).
 */
export class CryptoOperationError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string) {
    super(message);
    this.name = 'CryptoOperationError';
    this.code = code;
  }
}
