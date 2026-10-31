/**
 * The leader tab's downloads (ADR 0021), with real attachment encryption (WASM) and the cache
 * on fake-indexeddb: a file never staged for this browser comes from the phone in parts, is
 * checked completely, and stays cached; one over the phone limit is refused before anything
 * is fetched; a corrupted part fails the check and leaves nothing behind.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { decryptStream, encryptStream } from '@pingdost/attachments';
import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';
import {
  attachmentDecryptInput,
  type AttachmentInfo,
  type MessageEngine,
  type MessageRecord,
} from '@pingdost/message-engine';
import { toBase64, uuidv7 } from '@pingdost/protocol';

import { fileCache } from './cache';
import { Transfers, type TransferStatus } from './transfers';

vi.mock('@/session/session', () => ({
  api: {
    attachments: {
      // Not staged for this browser: the server answers as if there were no such file.
      downloadUrl: () =>
        Promise.reject(Object.assign(new Error('not found'), { code: 'ATTACHMENT_NOT_FOUND' })),
      ack: () => Promise.resolve(),
    },
  },
}));

let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

async function* chunksOf(data: Uint8Array, size = 10_000): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) {
    await Promise.resolve();
    yield data.subarray(i, i + size);
  }
}

async function encrypted(size: number) {
  const plaintext = new Uint8Array(size).map((_, i) => (i * 13) % 256);
  const stream = encryptStream(provider, chunksOf(plaintext));
  const parts: Uint8Array[] = [];
  for (;;) {
    const step = await stream.next();
    if (step.done) {
      const ciphertext = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const part of parts) {
        ciphertext.set(part, offset);
        offset += part.length;
      }
      const e = step.value;
      const info: AttachmentInfo = {
        attachmentId: uuidv7(),
        key: toBase64(e.key),
        noncePrefix: toBase64(e.noncePrefix),
        plaintextSize: e.plaintextSize,
        chunkCount: e.chunkCount,
        ciphertextSize: e.ciphertextSize,
        mimeType: 'application/pdf',
        fileName: 'report.pdf',
        ciphertextSha256: toBase64(e.ciphertextSha256),
        chunkHashListSha256: toBase64(e.chunkHashListSha256),
        thumbnail: null,
      };
      return { plaintext, ciphertext, info };
    }
    parts.push(step.value);
  }
}

function setup(info: AttachmentInfo, phoneCopy: (offset: number, length: number) => Uint8Array) {
  const message = { messageId: uuidv7(), attachment: info } as MessageRecord;
  const asked: number[] = [];
  const engine = {
    getMessage: (id: string) => Promise.resolve(id === message.messageId ? message : undefined),
    fetchFromPhone: (_id: string, offset: number, length = 48_000) => {
      asked.push(offset);
      return Promise.resolve({ data: phoneCopy(offset, length), totalSize: info.ciphertextSize });
    },
  } as unknown as MessageEngine;
  const statuses: TransferStatus[] = [];
  const transfers = new Transfers(engine, provider, (status) => statuses.push(status));
  return { message, transfers, statuses, asked };
}

async function plaintextOf(info: AttachmentInfo): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of decryptStream(
    provider,
    attachmentDecryptInput(info),
    fileCache().read(info.attachmentId),
  )) {
    parts.push(chunk.slice());
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('web attachment downloads', () => {
  it('fetches a file the browser was never staged for from the phone, in parts', async () => {
    const { plaintext, ciphertext, info } = await encrypted(200_000);
    const { message, transfers, statuses, asked } = setup(info, (offset, length) =>
      ciphertext.slice(offset, offset + length),
    );
    await transfers.download(message.messageId);
    expect(statuses.at(-1)).toMatchObject({
      phase: 'done',
      source: 'phone',
      done: info.ciphertextSize,
    });
    expect(asked.length).toBeGreaterThan(4); // several 48 KB parts
    expect(await fileCache().isComplete(info.attachmentId)).toBe(true);
    expect(await plaintextOf(info)).toEqual(plaintext);
    // Asked again: it is already here.
    await transfers.download(message.messageId);
    expect(asked.length).toBe(Math.ceil(info.ciphertextSize / 48_000));
  });

  it('refuses a file over the phone limit before fetching anything', async () => {
    const { info } = await encrypted(10);
    const big = { ...info, ciphertextSize: 30 * 1_048_576 };
    const { message, transfers, statuses, asked } = setup(big, () => new Uint8Array(0));
    await transfers.download(message.messageId);
    expect(statuses.at(-1)).toMatchObject({ phase: 'failed', error: 'too_large' });
    expect(asked).toEqual([]);
  });

  it('drops a copy that fails its integrity check', async () => {
    const { ciphertext, info } = await encrypted(100_000);
    const damaged = ciphertext.slice();
    damaged[70_000] = (damaged[70_000] ?? 0) ^ 0xff;
    const { message, transfers, statuses } = setup(info, (offset, length) =>
      damaged.slice(offset, offset + length),
    );
    await transfers.download(message.messageId);
    expect(statuses.at(-1)).toMatchObject({ phase: 'failed', error: 'integrity' });
    expect(await fileCache().isComplete(info.attachmentId)).toBe(false);
  });
});
