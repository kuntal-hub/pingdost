/**
 * Ed25519 verification for proofs of possession and signed keys (ADR 0008), with Node's
 * built-in crypto. The server checks these as defence in depth; clients verify everything
 * they trust with vodozemac's strict verification.
 */
import { createPublicKey, verify } from 'node:crypto';

/** False for a bad signature or malformed key/signature (unpadded base64 inputs). */
export function verifyEd25519(publicKey: string, message: Uint8Array, signature: string): boolean {
  try {
    const raw = Buffer.from(publicKey, 'base64');
    const sig = Buffer.from(signature, 'base64');
    if (raw.length !== 32 || sig.length !== 64) return false;
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: raw.toString('base64url') },
      format: 'jwk',
    });
    return verify(null, message, key, sig);
  } catch {
    return false;
  }
}
