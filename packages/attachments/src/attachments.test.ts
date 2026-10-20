import { createHash, randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { AttachmentsApi } from '@pingdost/api-client';
import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import type { AttachmentStatusResponse } from '@pingdost/shared-types';

import {
  AttachmentError,
  buildManifest,
  canSend,
  CHUNK_SIZE,
  ciphertextSizeFor,
  decryptStream,
  encryptStream,
  PART_BYTES,
  readManifest,
  safeFileName,
  sniffMime,
  uploadAttachment,
  type EncryptedAttachment,
} from './index';

let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

/** Yields `data` in uneven pieces, as file reads do. */
async function* pieces(data: Uint8Array, sizes = [777, 65_536, 100_003, 1, 4_096]) {
  let offset = 0;
  for (let i = 0; offset < data.length; i++) {
    const size = sizes[i % sizes.length]!;
    await Promise.resolve(); // an asynchronous read
    yield data.subarray(offset, offset + size);
    offset += size;
  }
}

async function encryptAll(data: Uint8Array) {
  const chunks: Uint8Array[] = [];
  const stream = encryptStream(provider, pieces(data));
  for (;;) {
    const next = await stream.next();
    if (next.done) return { chunks, result: next.value };
    chunks.push(next.value);
  }
}

async function decryptAll(result: EncryptedAttachment, ciphertext: Uint8Array) {
  const out: Uint8Array[] = [];
  for await (const chunk of decryptStream(provider, result, pieces(ciphertext, [12_345, 70_000]))) {
    out.push(chunk);
  }
  return Buffer.concat(out);
}

const sha256 = (data: Uint8Array) => new Uint8Array(createHash('sha256').update(data).digest());

describe('encryptStream / decryptStream', () => {
  it('round-trips a large stream fed in uneven pieces, with matching hashes', async () => {
    const data = new Uint8Array(randomBytes(20 * 1_048_576 + 12_345));
    const { chunks, result } = await encryptAll(data);
    const ciphertext = Buffer.concat(chunks);
    expect(result.plaintextSize).toBe(data.length);
    expect(result.chunkCount).toBe(Math.floor(data.length / CHUNK_SIZE) + 1);
    expect(ciphertext.length).toBe(ciphertextSizeFor(data.length));
    expect(result.ciphertextSize).toBe(ciphertext.length);
    expect(result.ciphertextSha256).toEqual(sha256(ciphertext));
    expect(result.chunkHashes).toEqual(chunks.map(sha256));
    expect(result.chunkHashListSha256).toEqual(sha256(Buffer.concat(result.chunkHashes)));
    expect((await decryptAll(result, ciphertext)).equals(Buffer.from(data))).toBe(true);
  }, 60_000); // 20 MiB through WASM: a few seconds alone, more next to other test runs

  it('handles an empty file and an exact multiple of the chunk size', async () => {
    const empty = await encryptAll(new Uint8Array(0));
    expect(empty.result.chunkCount).toBe(1);
    expect((await decryptAll(empty.result, Buffer.concat(empty.chunks))).length).toBe(0);
    const exact = new Uint8Array(randomBytes(CHUNK_SIZE * 3));
    const { chunks, result } = await encryptAll(exact);
    expect(result.chunkCount).toBe(4);
    expect(chunks.at(-1)!.length).toBe(16);
    expect((await decryptAll(result, Buffer.concat(chunks))).equals(Buffer.from(exact))).toBe(true);
  });

  it('rejects truncated, altered or mismatched ciphertext', async () => {
    const data = new Uint8Array(randomBytes(CHUNK_SIZE * 2 + 10));
    const { chunks, result } = await encryptAll(data);
    const full = Buffer.concat(chunks);
    const fails = async (ciphertext: Uint8Array, input: EncryptedAttachment = result) => {
      await expect(decryptAll(input, ciphertext)).rejects.toBeInstanceOf(AttachmentError);
    };
    await fails(full.subarray(0, full.length - chunks.at(-1)!.length)); // last chunk dropped
    const altered = Buffer.from(full);
    altered[100] = (altered[100] ?? 0) ^ 1;
    await fails(altered);
    await fails(full, { ...result, ciphertextSha256: new Uint8Array(32) });
  });
});

describe('manifests', () => {
  it('builds and reads back, with checks', async () => {
    const { result } = await encryptAll(new Uint8Array(randomBytes(1_000)));
    const manifest = buildManifest({
      attachmentId: '0192f1a0-0000-7000-8000-000000000001',
      encrypted: result,
      mimeType: 'image/jpeg',
      fileName: '../../etc/photo.jpg',
    });
    const read = readManifest(manifest);
    expect(read).toMatchObject({
      attachmentId: '0192f1a0-0000-7000-8000-000000000001',
      plaintextSize: 1_000,
      chunkCount: 1,
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
    });
    expect(() => readManifest({ ...manifest, scheme: 'other/1' })).toThrow(AttachmentError);
    expect(() => readManifest({ ...manifest, chunkCount: 2 })).toThrow(AttachmentError);
    expect(() => readManifest({ ...manifest, key: new Uint8Array(16) })).toThrow(AttachmentError);
    expect(() => readManifest({ ...manifest, mimeType: 'text/html; x' })).toThrow(AttachmentError);
    expect(() => readManifest(manifest, 999)).toThrow(AttachmentError);
    expect(safeFileName('a\u0000b.txt')).toBe('ab.txt');
    expect(safeFileName('..')).toBeUndefined();
  });
});

describe('sniffMime', () => {
  const head = (...parts: (number[] | string)[]) =>
    Uint8Array.from(
      parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : p)),
    );

  it('trusts magic bytes, not names', () => {
    const cases: [Uint8Array, string, string][] = [
      [head([0xff, 0xd8, 0xff, 0xe0]), 'image/jpeg', 'image'],
      [head([0x89], 'PNG\r\n', [0x1a, 0x0a]), 'image/png', 'image'],
      [head('GIF89a'), 'image/gif', 'image'],
      [head('RIFF', [0, 0, 0, 0], 'WEBP'), 'image/webp', 'image'],
      [head([0, 0, 0, 24], 'ftypheic'), 'image/heic', 'image'],
      [head([0, 0, 0, 24], 'ftypisom'), 'video/mp4', 'video'],
      [head([0, 0, 0, 20], 'ftypqt  '), 'video/quicktime', 'video'],
      [head([0, 0, 0, 20], 'ftypM4A '), 'audio/mp4', 'audio'],
      [head([0x1a, 0x45, 0xdf, 0xa3], 'xxxxwebm'), 'video/webm', 'video'],
      [head('ID3', [3, 0]), 'audio/mpeg', 'audio'],
      [head('OggS'), 'audio/ogg', 'audio'],
      [head('RIFF', [0, 0, 0, 0], 'WAVE'), 'audio/wav', 'audio'],
      [head('%PDF-1.7'), 'application/pdf', 'document'],
      [
        head('PK', [3, 4], '....[Content_Types].xml....word/document.xml'),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'document',
      ],
      [head('PK', [3, 4], 'random'), 'application/zip', 'document'],
      [head('hello, नमस्ते\n'), 'text/plain', 'document'],
      [head([0, 1, 2, 3, 4]), 'application/octet-stream', 'document'],
    ];
    for (const [data, mimeType, category] of cases) {
      expect(sniffMime(data), mimeType).toEqual({ mimeType, category });
    }
  });
});

describe('canSend (REQ §10.1)', () => {
  const max = 100 * 1_048_576;
  it('applies the 100 MB limit, compressing only images and videos', () => {
    expect(canSend({ size: 5, category: 'document' })).toEqual({
      result: 'ok',
      compressible: false,
    });
    expect(canSend({ size: 5, category: 'image' })).toEqual({ result: 'ok', compressible: true });
    expect(canSend({ size: max + 1, category: 'document' })).toMatchObject({
      result: 'rejected',
      reason: 'too_large',
    });
    expect(canSend({ size: max + 1, category: 'video' })).toMatchObject({
      result: 'needs_compression',
    });
    expect(
      canSend({ size: max * 2, category: 'video' }, { compressedEstimate: max + 1 }),
    ).toMatchObject({ result: 'rejected', reason: 'too_large_after_compression' });
    expect(canSend({ size: 0, category: 'image' })).toMatchObject({ reason: 'empty' });
  });
});

describe('uploadAttachment', () => {
  function fakeApi(size: number) {
    const parts = Math.ceil(size / PART_BYTES);
    const received = new Set<number>();
    const urls = () =>
      Array.from({ length: parts }, (_, index) => index)
        .filter((index) => !received.has(index))
        .map((index) => ({ index, url: `https://staging.test/part/${index}` }));
    const status = (): AttachmentStatusResponse => ({
      attachmentId: 'a',
      status: received.size === parts ? 'ready' : 'uploading',
      partSize: PART_BYTES,
      partCount: parts,
      receivedParts: [...received],
      uploadUrls: urls(),
      urlsExpireAt: 0,
      expiresAt: 0,
    });
    let created = false;
    const api: AttachmentsApi = {
      create: () => {
        if (created)
          return Promise.reject(Object.assign(new Error('exists'), { code: 'CONFLICT' }));
        created = true;
        return Promise.resolve({
          attachmentId: 'a',
          partSize: PART_BYTES,
          partCount: parts,
          uploadUrls: urls(),
          urlsExpireAt: 0,
          expiresAt: 0,
        });
      },
      status: () => Promise.resolve(status()),
      complete: () => Promise.resolve(status()),
      downloadUrl: () => Promise.reject(new Error('unused')),
      ack: () => Promise.resolve(),
    };
    return { api, received };
  }

  it('resumes after a failure, sending only the missing parts', async () => {
    const size = PART_BYTES * 2 + 100;
    const { api, received } = fakeApi(size);
    const sends: number[] = [];
    let failAt: number | undefined = 1;
    const input = {
      api,
      attachmentId: 'a',
      ciphertextSize: size,
      ciphertextSha256: new Uint8Array(32),
      recipientDeviceIds: ['d'],
      readRange: (start: number, end: number) => Promise.resolve(new Uint8Array(end - start)),
      attempts: 1,
      sendPart: (url: string, body: Uint8Array) => {
        const index = Number(url.split('/').pop());
        sends.push(index);
        if (index === failAt) return Promise.resolve(503);
        expect(body.length).toBe(index === 2 ? 100 : PART_BYTES);
        received.add(index);
        return Promise.resolve(200);
      },
    };
    await expect(uploadAttachment(input)).rejects.toBeInstanceOf(AttachmentError);
    failAt = undefined;
    expect(await uploadAttachment(input)).toMatchObject({ status: 'ready' });
    expect(sends).toEqual([0, 1, 1, 2]);
  });
});
