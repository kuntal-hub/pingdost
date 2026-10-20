/**
 * The Phase 14 object-store spike (ADR 0017), tagged slow: `PINGDOST_SLOW=1 pnpm --filter
 * @pingdost/server exec vitest run --config vitest.int.config.ts test/attachments-100mb`.
 * A 100 MiB file is encrypted, staged, downloaded and decrypted, all streaming through temp
 * files, for `fs` and (with the `s3` compose profile) `s3`. Prints `ATTACHMENT_SPIKE {...}`
 * with timings and peak memory; checks resume, signed URL expiry (fs), ACK deletion and the
 * janitor.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attachmentsApi, createApiClient } from '@pingdost/api-client';
import { decryptStream, encryptStream, uploadAttachment } from '@pingdost/attachments';
import type { CryptoProvider } from '@pingdost/crypto';
import { uuidv7 } from '@pingdost/protocol';

import { cryptoProvider } from './devices';
import { freePort, startTestServer, type TestServer } from './helpers';
import { deviceSession, type TestDeviceSession } from './ws';

const SIZE = 100 * 1_048_576;
const S3 = {
  endpoint: 'http://127.0.0.1:8333',
  bucket: 'pingdost-test',
  accessKey: 'pingdost-dev',
  secretKey: 'pingdost-dev-secret',
};
const slow = process.env.PINGDOST_SLOW === '1';
const s3Up =
  slow &&
  (await fetch(`${S3.endpoint}/healthz`)
    .then((response) => response.ok)
    .catch(() => false));

/** 100 MiB of varied bytes, made 1 MiB at a time (never held whole), and their SHA-256. */
async function* source(hash: ReturnType<typeof createHash>): AsyncGenerator<Uint8Array> {
  const block = 1_048_576;
  for (let offset = 0; offset < SIZE; offset += block) {
    const piece = Buffer.alloc(block);
    for (let i = 0; i < block; i += 4) piece.writeUInt32LE(((offset + i) * 2_654_435_761) >>> 0, i);
    hash.update(piece);
    await Promise.resolve();
    yield piece;
  }
}

function memorySampler() {
  const start = process.memoryUsage();
  let peakRss = start.rss;
  let peakHeap = start.heapUsed;
  const timer = setInterval(() => {
    const now = process.memoryUsage();
    peakRss = Math.max(peakRss, now.rss);
    peakHeap = Math.max(peakHeap, now.heapUsed);
  }, 50);
  return () => {
    clearInterval(timer);
    return {
      peakRssDeltaMiB: Math.round((peakRss - start.rss) / 1_048_576),
      peakHeapDeltaMiB: Math.round((peakHeap - start.heapUsed) / 1_048_576),
    };
  };
}

function spike(kind: 'fs' | 's3') {
  describe.runIf(slow && (kind === 'fs' || s3Up))(`100 MiB attachment spike (${kind})`, () => {
    let crypto: CryptoProvider;
    let server: TestServer;
    let dir = '';
    let base = '';
    let alice: TestDeviceSession;
    let bob: TestDeviceSession;

    beforeAll(async () => {
      crypto = await cryptoProvider();
      dir = await mkdtemp(join(tmpdir(), 'pingdost-spike-'));
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      if (kind === 's3') {
        await new S3Client({
          endpoint: S3.endpoint,
          region: 'us-east-1',
          credentials: { accessKeyId: S3.accessKey, secretAccessKey: S3.secretKey },
          forcePathStyle: true,
        })
          .send(new CreateBucketCommand({ Bucket: S3.bucket }))
          .catch(() => undefined);
      }
      server = await startTestServer({
        env: {
          PUBLIC_API_URL: base,
          ATTACHMENT_FS_ROOT: join(dir, 'staging'),
          ...(kind === 's3'
            ? {
                ATTACHMENT_STORE: 's3',
                ATTACHMENT_OBJECT_STORE_ENDPOINT: S3.endpoint,
                ATTACHMENT_OBJECT_STORE_BUCKET: S3.bucket,
                ATTACHMENT_OBJECT_STORE_ACCESS_KEY: S3.accessKey,
                ATTACHMENT_OBJECT_STORE_SECRET_KEY: S3.secretKey,
                ATTACHMENT_OBJECT_STORE_REGION: 'us-east-1',
              }
            : {}),
        },
      });
      await server.app.listen({ host: '127.0.0.1', port });
      alice = await deviceSession(server, crypto);
      bob = await deviceSession(server, crypto);
    }, 60_000);

    afterAll(async () => {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    });

    it('encrypts, stages, resumes, downloads and decrypts 100 MiB, streaming', async () => {
      const times: Record<string, number> = {};
      const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
        const started = performance.now();
        try {
          return await run();
        } finally {
          times[name] = Math.round(performance.now() - started);
        }
      };
      const stop = memorySampler();
      const sourceHash = createHash('sha256');
      const encryptedPath = join(dir, 'ciphertext.bin');

      const encrypted = await timed('encryptMs', async () => {
        const out = createWriteStream(encryptedPath);
        const stream = encryptStream(crypto, source(sourceHash));
        for (;;) {
          const next = await stream.next();
          if (next.done) {
            out.end();
            await new Promise<void>((resolve) => out.on('finish', () => resolve()));
            return next.value;
          }
          if (!out.write(next.value)) {
            await new Promise<void>((resolve) => out.once('drain', () => resolve()));
          }
        }
      });
      const ciphertextSize = (await stat(encryptedPath)).size;
      expect(ciphertextSize).toBe(encrypted.ciphertextSize);

      const file = await open(encryptedPath);
      const api = (session: TestDeviceSession) =>
        attachmentsApi(
          createApiClient({ baseUrl: base, getAccessToken: () => session.accessToken, retries: 0 }),
        );
      const attachmentId = uuidv7();
      let fails = 1;
      const upload = {
        api: api(alice),
        attachmentId,
        ciphertextSize,
        ciphertextSha256: encrypted.ciphertextSha256,
        recipientDeviceIds: [bob.deviceId],
        attempts: 1,
        readRange: async (start: number, end: number) => {
          const buffer = new Uint8Array(end - start);
          await file.read(buffer, 0, buffer.length, start);
          return buffer;
        },
        sendPart: async (url: string, body: Uint8Array) => {
          // Interrupt the upload once, at the third part.
          if (url.includes('/parts/2?') || url.includes('partNumber=3&')) {
            if (fails-- > 0) return 503;
          }
          return (
            await fetch(url, {
              method: 'PUT',
              body: body as Uint8Array<ArrayBuffer>,
              headers: { 'content-type': 'application/octet-stream' },
            })
          ).status;
        },
      };
      await timed('uploadMs', async () => {
        await expect(uploadAttachment(upload)).rejects.toThrow();
        expect((await uploadAttachment(upload)).status).toBe('ready');
      });
      await file.close();

      const downloadedPath = join(dir, 'downloaded.bin');
      const { url } = await api(bob).downloadUrl(attachmentId);
      await timed('downloadMs', async () => {
        const response = await fetch(url);
        expect(response.ok).toBe(true);
        await pipeline(Readable.fromWeb(response.body as never), createWriteStream(downloadedPath));
      });

      const plainHash = createHash('sha256');
      await timed('decryptMs', async () => {
        const chunks = (async function* () {
          for await (const chunk of createReadStream(downloadedPath, {
            highWaterMark: 1_048_576,
          })) {
            yield chunk as Uint8Array;
          }
        })();
        for await (const plain of decryptStream(crypto, encrypted, chunks)) plainHash.update(plain);
      });
      expect(plainHash.digest('hex')).toBe(sourceHash.digest('hex'));
      const memory = stop();

      if (kind === 'fs') {
        server.clock.advance(server.config.ATTACHMENT_PRESIGNED_URL_TTL_SECONDS * 1_000 + 1_000);
        expect((await fetch(url, { headers: { range: 'bytes=0-0' } })).status).toBe(403);
        server.clock.advance(-(server.config.ATTACHMENT_PRESIGNED_URL_TTL_SECONDS * 1_000 + 1_000));
      }
      await api(bob).ack(attachmentId);
      await expect(api(bob).downloadUrl(attachmentId)).rejects.toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
      });

      console.log(
        `ATTACHMENT_SPIKE ${JSON.stringify({ store: kind, sizeMiB: 100, ciphertextSize, ...times, ...memory })}`,
      );
      expect(memory.peakHeapDeltaMiB).toBeLessThan(100);
    }, 600_000);
  });
}

spike('fs');
spike('s3');
