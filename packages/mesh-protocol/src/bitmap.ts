/**
 * Which chunks of a transfer a device holds (ADR 0027): bit i (byte i / 8, bit i % 8, least
 * significant first) is chunk i, as in `MeshTransferState.have`.
 */
export class ChunkBitmap {
  readonly #bits: Uint8Array;
  #held = 0;

  constructor(
    readonly count: number,
    bytes?: Uint8Array,
  ) {
    if (!Number.isInteger(count) || count < 1) throw new RangeError('count must be positive');
    this.#bits = new Uint8Array(Math.ceil(count / 8));
    if (bytes) {
      for (let i = 0; i < count; i++) {
        if (((bytes[i >> 3] ?? 0) >> (i & 7)) & 1) this.set(i);
      }
    }
  }

  get held(): number {
    return this.#held;
  }

  get complete(): boolean {
    return this.#held === this.count;
  }

  has(index: number): boolean {
    if (index < 0 || index >= this.count) return false;
    return ((this.#bits[index >> 3]! >> (index & 7)) & 1) === 1;
  }

  /** Marks a chunk held; false if it already was (or is out of range). */
  set(index: number): boolean {
    if (index < 0 || index >= this.count || this.has(index)) return false;
    this.#bits[index >> 3]! |= 1 << (index & 7);
    this.#held++;
    return true;
  }

  /** Missing chunk indices, in order, at most `limit`. */
  missing(limit = Infinity): number[] {
    const out: number[] = [];
    for (let i = 0; i < this.count && out.length < limit; i++) if (!this.has(i)) out.push(i);
    return out;
  }

  toBytes(): Uint8Array {
    return this.#bits.slice();
  }
}
