// Incoming mesh chunks on SQLite (migration 009) under the real receiver (ADR 0027): chunks in
// any order, a restart in the middle, the whole-file check, then the chunks are gone.
import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import { migratedDatabase } from '@/db/testing';
import {
  buildManifest,
  encryptStream,
  MeshFileReceiver,
  readManifest,
} from '@pingdost/attachments';
import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';

import { SqliteChunkStorage } from './chunk-store';

let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

/** One piece, as an async stream (what `encryptStream` reads). */
async function* once(bytes: Uint8Array) {
  await Promise.resolve();
  yield bytes;
}

async function encrypt(size: number) {
  const chunks: Uint8Array[] = [];
  const plaintext = new Uint8Array(randomBytes(size));
  const stream = encryptStream(provider, once(plaintext));
  let next = await stream.next();
  while (!next.done) {
    chunks.push(next.value);
    next = await stream.next();
  }
  return { chunks, encrypted: next.value };
}

describe('SqliteChunkStorage', () => {
  it('keeps chunks across a restart, verifies the file, then drops them', async () => {
    const db = await migratedDatabase();
    const { chunks, encrypted } = await encrypt(200_000);
    const id = '01890a5d-ac96-774b-bcce-b302099a8057';
    const manifest = readManifest(
      buildManifest({ attachmentId: id, encrypted, mimeType: 'application/pdf', mesh: true }),
    );
    const verified: Uint8Array[][] = [];
    const make = () =>
      new MeshFileReceiver(provider, new SqliteChunkStorage(db), {
        verified: async (_, read) => {
          const parts: Uint8Array[] = [];
          for await (const part of read()) parts.push(part);
          verified.push(parts);
        },
      });
    const ack = () => undefined;
    const first = make();
    await first.load();
    first.expect(id, manifest);
    first.chunk({ transferId: id, index: 2, count: chunks.length, data: chunks[2]! }, ack);
    first.chunk({ transferId: id, index: 0, count: chunks.length, data: chunks[0]! }, ack);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(first.progress()[0]?.have).toEqual(Uint8Array.of(0b101));

    // The app restarts: the chunks are still there.
    const second = make();
    await second.load();
    expect(second.status(id)).toMatchObject({ held: 2, count: chunks.length });
    second.expect(id, manifest);
    for (const index of [1, 3]) {
      second.chunk({ transferId: id, index, count: chunks.length, data: chunks[index]! }, ack);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(verified).toHaveLength(1);
    expect(verified[0]).toEqual(chunks);
    expect(second.progress()).toEqual([
      { transferId: id, have: new Uint8Array(0), complete: true },
    ]);
    expect(await db.getAllAsync('SELECT * FROM mesh_incoming_chunks', [])).toEqual([]);
    expect(await db.getAllAsync('SELECT * FROM mesh_incoming', [])).toEqual([]);
  });
});
