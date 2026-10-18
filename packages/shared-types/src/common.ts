import { z } from 'zod';

/** A UUIDv7 ID in canonical lowercase form (ARCHITECTURE A8; 16 bytes in protobuf). */
export const IdSchema = z.uuidv7().toLowerCase();

/** Epoch milliseconds (ARCHITECTURE A8). */
export const EpochMsSchema = z.int().nonnegative();

/**
 * Unpadded standard base64, as vodozemac encodes keys and signatures (an Ed25519 or
 * Curve25519 key is 43 characters, an Ed25519 signature 86).
 */
export const UnpaddedBase64Schema = z
  .string()
  .max(1024)
  .regex(/^[A-Za-z0-9+/]+$/, 'must be unpadded base64');

/** URL-safe base64 without padding: nonces, challenges and opaque tokens. */
export const Base64UrlSchema = z.base64url().max(1024);

/** Opaque pagination cursor. */
export const CursorSchema = z.string().min(1).max(512);
