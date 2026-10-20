import { randomBytes } from 'node:crypto';

import { beforeAll, describe, expect, it } from 'vitest';

import type { AttachmentsApi } from '@pingdost/api-client';
import { createWasmCryptoProvider, type CryptoProvider } from '@pingdost/crypto';

import {
  AttachmentError,
  downloadCiphertext,
  encryptStream,
  IMAGE_PRESETS,
  planVideo,
  scaledSize,
  verifyStream,
  videoWorthCompressing,
} from './index';

let provider: CryptoProvider;

beforeAll(async () => {
  provider = await createWasmCryptoProvider();
});

/** A response whose body arrives in small reads, optionally cut off after `cutAt` bytes. */
function streamed(body: Uint8Array, status: number, cutAt?: number): Response {
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cutAt !== undefined && offset >= cutAt) {
        controller.error(new TypeError('connection reset'));
        return;
      }
      if (offset >= body.length) {
        controller.close();
        return;
      }
      const end = Math.min(body.length, offset + 10_000, cutAt ?? Infinity);
      controller.enqueue(body.slice(offset, end));
      offset = end;
    },
  });
  return new Response(stream, { status });
}

function fakeServer(file: Uint8Array) {
  const requests: { url: string; range: string | null }[] = [];
  let urlVersion = 0;
  let expireNext = false;
  let cutAt: number | undefined;
  let ignoreRange = false;
  let gone = false;
  const api: AttachmentsApi = {
    create: () => Promise.reject(new Error('unused')),
    status: () => Promise.reject(new Error('unused')),
    complete: () => Promise.reject(new Error('unused')),
    downloadUrl: () =>
      gone
        ? Promise.reject(Object.assign(new Error('gone'), { code: 'ATTACHMENT_NOT_FOUND' }))
        : Promise.resolve({
            url: `https://staging.test/blob/${++urlVersion}`,
            expiresAt: 0,
            ciphertextBytes: file.length,
          }),
    ack: () => Promise.resolve(),
  };
  const fetchImpl = ((url: string, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('range');
    requests.push({ url, range });
    if (expireNext) {
      expireNext = false;
      return Promise.resolve(new Response(null, { status: 403 }));
    }
    const start = range && !ignoreRange ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0;
    const response = streamed(file.subarray(start), start > 0 ? 206 : 200, cutAt);
    cutAt = undefined;
    return Promise.resolve(response);
  }) as typeof fetch;
  return {
    api,
    fetchImpl,
    requests,
    expire: () => (expireNext = true),
    cut: (bytes: number) => (cutAt = bytes),
    ignoreRange: () => (ignoreRange = true),
    remove: () => (gone = true),
  };
}

function sink() {
  let saved = new Uint8Array(0);
  return {
    get bytes() {
      return saved;
    },
    write: (chunk: Uint8Array) => {
      const next = new Uint8Array(saved.length + chunk.length);
      next.set(saved);
      next.set(chunk, saved.length);
      saved = next;
      return Promise.resolve();
    },
    reset: () => {
      saved = new Uint8Array(0);
      return Promise.resolve();
    },
  };
}

describe('downloadCiphertext', () => {
  const file = new Uint8Array(randomBytes(700_000));

  it('resumes a cut-off download with a Range request and renews an expired link', async () => {
    const server = fakeServer(file);
    const out = sink();
    const base = {
      api: server.api,
      attachmentId: 'a',
      ciphertextSize: file.length,
      fetch: server.fetchImpl,
      write: out.write,
      reset: out.reset,
    };
    server.cut(300_000);
    await expect(downloadCiphertext({ ...base, savedBytes: 0, attempts: 1 })).rejects.toMatchObject(
      { code: 'network' },
    );
    // What arrived before the cut is kept.
    expect(out.bytes.length).toBeGreaterThan(0);
    server.expire();
    await downloadCiphertext({ ...base, savedBytes: out.bytes.length });
    expect(Buffer.from(out.bytes).equals(Buffer.from(file))).toBe(true);
    expect(server.requests.at(-1)?.range).toMatch(/^bytes=\d+-$/);
    // The first attempt's link, the resumed attempt's (expired), and its renewal.
    expect(new Set(server.requests.map((r) => r.url)).size).toBe(3);
  });

  it('starts over when the server sends the whole file instead of the range', async () => {
    const server = fakeServer(file);
    server.ignoreRange();
    const out = sink();
    await out.write(file.subarray(0, 1_000));
    await downloadCiphertext({
      api: server.api,
      attachmentId: 'a',
      ciphertextSize: file.length,
      savedBytes: 1_000,
      fetch: server.fetchImpl,
      write: out.write,
      reset: out.reset,
    });
    expect(Buffer.from(out.bytes).equals(Buffer.from(file))).toBe(true);
  });

  it('reports a file the server no longer has as gone, and stops when paused', async () => {
    const server = fakeServer(file);
    const out = sink();
    const base = {
      api: server.api,
      attachmentId: 'a',
      ciphertextSize: file.length,
      savedBytes: 0,
      fetch: server.fetchImpl,
      write: out.write,
      reset: out.reset,
    };
    const pause = new AbortController();
    pause.abort();
    await expect(downloadCiphertext({ ...base, signal: pause.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    server.remove();
    await expect(downloadCiphertext(base)).rejects.toMatchObject({ code: 'gone' });
    await expect(
      downloadCiphertext({ ...base, ciphertextSize: file.length + 1 }),
    ).rejects.toBeInstanceOf(AttachmentError);
  });
});

/** One read of `data`, as a file stream would give it. */
async function* from(data: Uint8Array): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield data;
}

describe('verifyStream', () => {
  it('passes the intact ciphertext and rejects one altered byte', async () => {
    const chunks: Uint8Array[] = [];
    const stream = encryptStream(provider, from(new Uint8Array(randomBytes(200_000))));
    let next = await stream.next();
    while (!next.done) {
      chunks.push(next.value);
      next = await stream.next();
    }
    const result = next.value;
    const ciphertext = Buffer.concat(chunks);
    await verifyStream(provider, result, from(ciphertext));
    const altered = Uint8Array.from(ciphertext);
    altered[150_000]! ^= 1;
    await expect(verifyStream(provider, result, from(altered))).rejects.toMatchObject({
      code: 'integrity',
    });
  });
});

describe('compression plans (REQ §10.1)', () => {
  const max = 100 * 1_048_576;

  it('scales images down to the preset, never up', () => {
    expect(scaledSize(4_000, 3_000, IMAGE_PRESETS.standard.maxDimension)).toEqual({
      width: 1_600,
      height: 1_200,
    });
    expect(scaledSize(800, 600, 1_600)).toEqual({ width: 800, height: 600 });
  });

  it('plans 720p for a short video and fits a long one under the limit', () => {
    const short = { size: 300 * 1_048_576, durationMs: 120_000, width: 1_920, height: 1_080 };
    const plan = planVideo(short, max)!;
    expect(plan).toMatchObject({ height: 720, label: '720p' });
    expect(plan.estimatedBytes).toBeLessThan(max);
    expect(videoWorthCompressing(short, plan)).toBe(true);

    // 20 minutes: 720p and 480p do not fit; 360p at a lower bitrate does.
    const long = { size: 2_000 * 1_048_576, durationMs: 20 * 60_000, width: 1_920, height: 1_080 };
    const fitted = planVideo(long, max)!;
    expect(fitted.height).toBe(360);
    expect(fitted.estimatedBytes).toBeLessThanOrEqual(max);

    // Three hours cannot be watchable under 100 MB.
    expect(planVideo({ ...long, durationMs: 3 * 3_600_000 }, max)).toBeUndefined();
    expect(planVideo({ ...long, durationMs: 0 }, max)).toBeUndefined();
  });

  it('does not upscale a small video, and says when compressing would not help', () => {
    const small = { size: 2 * 1_048_576, durationMs: 60_000, width: 640, height: 360 };
    const plan = planVideo(small, max)!;
    expect(plan.height).toBe(360);
    expect(videoWorthCompressing(small, plan)).toBe(false);
  });
});
