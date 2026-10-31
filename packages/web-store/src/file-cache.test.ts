import { describe, expect, it } from 'vitest';

import { PingdostDb } from './db';
import { FileCache } from './file-cache';

/** Small pieces: fake-indexeddb clones large arrays slowly. */
const PIECE = 4_096;

let counter = 0;
const freshDb = () => new PingdostDb(`pingdost-files-${++counter}`);

function bytes(length: number, seed = 1): Uint8Array {
  return new Uint8Array(length).map((_, i) => (i * 31 + seed) % 251);
}

async function readAll(cache: FileCache, id: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const part of cache.read(id)) parts.push(part);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('the attachment cache (ADR 0021)', () => {
  it('stores a file in pieces and reads it back, whole or by range', async () => {
    const cache = new FileCache(freshDb(), Date.now, PIECE);
    const file = bytes(2 * PIECE + 12_345);
    const writer = await cache.writer('a', file.length);
    // Written in odd-sized chunks, as a download delivers them.
    for (let offset = 0; offset < file.length; offset += 3_001) {
      await writer.append(file.subarray(offset, offset + 3_001));
    }
    expect(await cache.isComplete('a')).toBe(false);
    await writer.complete();
    expect(await cache.isComplete('a')).toBe(true);
    expect(await readAll(cache, 'a')).toEqual(file);
    const start = PIECE - 10;
    expect(await cache.readRange('a', start, start + 1_000)).toEqual(
      file.subarray(start, start + 1_000),
    );
    expect(await cache.usage()).toEqual({ files: 1, bytes: file.length });
  });

  it('resumes after the pieces that were stored, and can start over', async () => {
    const db = freshDb();
    const file = bytes(PIECE + 500);
    const first = await new FileCache(db, Date.now, PIECE).writer('b', file.length);
    await first.append(file.subarray(0, PIECE + 100));
    // The tab dies: the buffered 100 bytes are lost, the full piece is not.
    const cache = new FileCache(db, Date.now, PIECE);
    const resumed = await cache.writer('b', file.length);
    expect(resumed.stored).toBe(PIECE);
    await resumed.append(file.subarray(PIECE));
    await resumed.complete();
    expect(await readAll(cache, 'b')).toEqual(file);

    const again = await cache.writer('b', file.length, false);
    expect(again.stored).toBe(0);
    expect(await cache.isComplete('b')).toBe(false);
  });

  it('evicts the least recently used files over the limit, keeping the ones in use', async () => {
    let clock = 1_000;
    const cache = new FileCache(freshDb(), () => clock, PIECE);
    for (const id of ['old', 'mid', 'new']) {
      clock += 10;
      const writer = await cache.writer(id, 1_000);
      await writer.append(bytes(1_000));
      await writer.complete();
    }
    clock += 10;
    for await (const _ of cache.read('old')) void _; // used again: now the newest
    expect(await cache.evict(2_000, new Set(['mid']))).toBe(1_000);
    expect(await cache.isComplete('new')).toBe(false);
    expect(await cache.isComplete('mid')).toBe(true);
    expect(await cache.isComplete('old')).toBe(true);
    expect(await cache.clear()).toBe(2_000);
    expect(await cache.usage()).toEqual({ files: 0, bytes: 0 });
  });
});
