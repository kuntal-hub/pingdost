// Fair dice without a server (ADR 0049, amended 2026-11-21): each seat commits to a hash chain
// of secrets when it joins (its `anchor` = the chain's end), and reveals them backwards, one per
// roll, never skipping one. A roll comes from the revealed secret and the salt of the latest
// event by another device. The roller's secrets were all fixed before that salt existed, and
// the salt's author could not know the secret, so neither can steer the die. Plain SHA-256 (the
// platform's `CryptoProvider.sha256`), domain-separated: no new primitive.

export type Sha256 = (data: Uint8Array) => Uint8Array;

/** Secrets per seat: more rolls than a game of Ludo needs (about 4 ms to build). */
export const CHAIN_LENGTH = 1024;

const encoder = new TextEncoder();
const CHAIN = encoder.encode('pingdost/game/chain/v1');
const ROLL = encoder.encode('pingdost/game/roll/v1');
const STATE = encoder.encode('pingdost/game/state/v1');
const FIRST = encoder.encode('pingdost/game/first/v1');

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** One step down the chain. */
export function chainStep(sha256: Sha256, secret: Uint8Array): Uint8Array {
  return sha256(concat(CHAIN, secret));
}

/**
 * The whole chain from a seat's seed: `chain[0]` is the seed, `chain[CHAIN_LENGTH]` the anchor
 * it publishes. Reveal k (k = 1, 2, …) is `chain[CHAIN_LENGTH - k]`.
 */
export function buildChain(sha256: Sha256, seed: Uint8Array, length = CHAIN_LENGTH): Uint8Array[] {
  const chain = [seed];
  for (let i = 0; i < length; i++) chain.push(chainStep(sha256, chain[i]!));
  return chain;
}

/**
 * Whether `reveal` is the secret right below `previous` (the anchor or the seat's last reveal).
 * A secret is never skipped: otherwise a roller could pick the best of several dice.
 */
export function isNextReveal(sha256: Sha256, previous: Uint8Array, reveal: Uint8Array): boolean {
  return sameBytes(chainStep(sha256, reveal), previous);
}

/** The secret a seat reveals for its `count`-th roll (1-based). */
export function revealAt(chain: readonly Uint8Array[], count: number): Uint8Array {
  const secret = chain[chain.length - 1 - count];
  if (count < 1 || !secret) throw new RangeError('no secret left for this roll');
  return secret;
}

/**
 * The die (1–6) for roll `index` of turn `turn`: unbiased, by rejecting the top 4 byte values.
 */
export function rollDie(
  sha256: Sha256,
  input: { reveal: Uint8Array; salt: Uint8Array; gameId: Uint8Array; turn: number; index: number },
): number {
  let hash = sha256(
    concat(ROLL, input.reveal, input.salt, input.gameId, u32(input.turn), u32(input.index)),
  );
  for (;;) {
    for (const byte of hash) if (byte < 252) return (byte % 6) + 1;
    hash = sha256(hash);
  }
}

/**
 * Who rolls first (0..count−1): from every seat's salt, all fixed before the start. The last
 * player to join could steer it; who starts is a small edge, accepted (ADR 0049).
 */
export function firstSeat(
  sha256: Sha256,
  gameId: Uint8Array,
  salts: readonly Uint8Array[],
): number {
  const hash = sha256(concat(FIRST, gameId, ...salts));
  return ((hash[0]! << 8) | hash[1]!) % salts.length;
}

/** The first 8 bytes of a game state's hash: carried by moves and skips to catch a desync. */
export function stateHash(sha256: Sha256, canonical: string): Uint8Array {
  return sha256(concat(STATE, encoder.encode(canonical))).slice(0, 8);
}
