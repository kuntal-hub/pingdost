/**
 * The `CryptoProvider` interface (ADR 0003; drafted in Phase 2, final since Phase 4).
 * Everything above the crypto package talks to this interface only, never to vodozemac or
 * generated bindings. Every implementation must pass `runCryptoConformance`.
 *
 * Keys and signatures are unpadded base64 strings (as vodozemac encodes them); message
 * bodies and plaintext are bytes. Every stateful object must be pickled (encrypted with a
 * 32-byte pickle key) before it is stored, and disposed when no longer needed.
 *
 * Later phases extend it by adding members only: the account identity signing key
 * (Phase 6) and attachment stream encryption (Phase 14, ADR 0004).
 */

/** A device's public identity keys (base64). */
export interface IdentityKeys {
  curve25519: string;
  ed25519: string;
}

/** A public one-time or fallback key (Curve25519, base64) with its key ID. */
export interface OneTimeKey {
  keyId: string;
  publicKey: string;
}

export type OlmMessageType = 'prekey' | 'normal';

/** An encrypted Olm message as carried inside an envelope. */
export interface OlmCiphertext {
  type: OlmMessageType;
  body: Uint8Array;
}

export interface Disposable {
  /** Frees the underlying WASM/native memory. The object is unusable afterwards. */
  dispose(): void;
}

/** A device's long-term Olm identity plus its one-time and fallback keys. */
export interface OlmAccount extends Disposable {
  identityKeys(): IdentityKeys;
  /** Ed25519 signature over `message`, base64. */
  sign(message: Uint8Array): string;
  /** How many unpublished one-time keys to keep on the server. */
  maxNumberOfOneTimeKeys(): number;
  generateOneTimeKeys(count: number): void;
  /** Unpublished one-time keys, sorted by key ID. */
  oneTimeKeys(): OneTimeKey[];
  markKeysAsPublished(): void;
  generateFallbackKey(): void;
  fallbackKey(): OneTimeKey | undefined;
  createOutboundSession(theirIdentityKey: string, theirOneTimeKey: string): OlmSession;
  /** Consumes the one-time key; the same pre-key message cannot open a second session. */
  createInboundSession(
    theirIdentityKey: string,
    message: OlmCiphertext,
  ): { session: OlmSession; plaintext: Uint8Array };
  pickle(pickleKey: Uint8Array): string;
}

/** One Olm (Double Ratchet) session with one remote device. */
export interface OlmSession extends Disposable {
  sessionId(): string;
  /** False until the peer replies; until then `encrypt` produces pre-key messages. */
  hasReceivedMessage(): boolean;
  encrypt(plaintext: Uint8Array): OlmCiphertext;
  /** Throws on tampering or replay (message keys are single-use). */
  decrypt(message: OlmCiphertext): Uint8Array;
  pickle(pickleKey: Uint8Array): string;
}

/** The sending side of a Megolm group session. */
export interface MegolmOutboundSession extends Disposable {
  sessionId(): string;
  /** Signed session key at the current index (base64). Secret: share only over Olm. */
  sessionKey(): string;
  messageIndex(): number;
  encrypt(plaintext: Uint8Array): Uint8Array;
  pickle(pickleKey: Uint8Array): string;
}

/** The receiving side of a Megolm group session. */
export interface MegolmInboundSession extends Disposable {
  sessionId(): string;
  firstKnownIndex(): number;
  /**
   * Megolm does not reject replays itself: callers must reject a
   * (sessionId, messageIndex) pair they have already accepted.
   */
  decrypt(message: Uint8Array): { plaintext: Uint8Array; messageIndex: number };
  /** Exported key from `index` onwards (base64), or undefined if unreachable. */
  exportAt(index: number): string | undefined;
  pickle(pickleKey: Uint8Array): string;
}

export interface CryptoProvider {
  /** Implementation name and version, e.g. for diagnostics. */
  readonly implementation: string;

  createAccount(): OlmAccount;
  restoreAccount(pickle: string, pickleKey: Uint8Array): OlmAccount;
  restoreSession(pickle: string, pickleKey: Uint8Array): OlmSession;
  /** The session a pre-key message belongs to, to route repeats to an existing session. */
  prekeyMessageSessionId(message: OlmCiphertext): string;

  createOutboundGroupSession(): MegolmOutboundSession;
  restoreOutboundGroupSession(pickle: string, pickleKey: Uint8Array): MegolmOutboundSession;
  /** From a signed session key received over Olm. */
  createInboundGroupSession(sessionKey: string): MegolmInboundSession;
  /** From an exported key (`exportAt`), e.g. for a member who joins later. */
  importInboundGroupSession(exportedKey: string): MegolmInboundSession;
  restoreInboundGroupSession(pickle: string, pickleKey: Uint8Array): MegolmInboundSession;

  /** Strict Ed25519 verification; returns false for a bad signature or malformed input. */
  verifyEd25519(publicKey: string, message: Uint8Array, signature: string): boolean;
}
