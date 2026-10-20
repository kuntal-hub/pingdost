/**
 * Server-side secret helpers: keyed hashes for OTPs, refresh tokens and IP addresses, and
 * random tokens. No custom cryptography: HMAC-SHA256 and the CSPRNG from node:crypto.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

/** Keyed hashing with `SERVER_HMAC_PEPPER`. Each purpose has its own domain. */
export class Hasher {
  readonly #pepper: Buffer;

  constructor(pepperBase64: string) {
    this.#pepper = Buffer.from(pepperBase64, 'base64');
  }

  /** HMAC-SHA256(pepper, purpose ‖ 0x00 ‖ value), base64url. */
  hash(
    purpose: 'otp' | 'refresh' | 'ip' | 'attachment-upload' | 'attachment-download',
    value: string,
  ): string {
    return createHmac('sha256', this.#pepper)
      .update(purpose)
      .update('\0')
      .update(value)
      .digest('base64url');
  }
}

/** A URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** A uniformly random 6-digit code. */
export function sixDigitCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** Constant-time string comparison (for equal-length hashes). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
