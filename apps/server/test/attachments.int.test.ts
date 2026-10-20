/**
 * Attachment staging (Phase 14, ADR 0017; REQ §19.3 server side) on a listening server, for
 * the `fs` store and, when the `s3` compose profile runs (SeaweedFS), the `s3` store:
 * encrypted bytes only, recipients only, resume, integrity check, signed URL expiry, delete on
 * the last ACK, quota and size limits, and the janitor (expired, orphaned, partial, leftover).
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CreateBucketCommand, ListMultipartUploadsCommand, S3Client } from '@aws-sdk/client-s3';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attachmentsApi, createApiClient, type AttachmentsApi } from '@pingdost/api-client';
import {
  decryptStream,
  encryptStream,
  uploadAttachment,
  type EncryptedAttachment,
} from '@pingdost/attachments';
import type { CryptoProvider } from '@pingdost/crypto';
import { uuidv7 } from '@pingdost/protocol';
import { containsMarker } from '@pingdost/sim-client';

import { cryptoProvider } from './devices';
import { startTestServer, type TestServer } from './helpers';
import { deviceSession, type TestDeviceSession } from './ws';
import { Metrics } from '../src/infra/metrics';
import { createAttachmentService } from '../src/modules/attachments';

const S3 = {
  endpoint: 'http://127.0.0.1:8333',
  bucket: 'pingdost-test',
  accessKey: 'pingdost-dev',
  secretKey: 'pingdost-dev-secret',
};
const s3Up = await fetch(`${S3.endpoint}/healthz`)
  .then((response) => response.ok)
  .catch(() => false);

let crypto: CryptoProvider;

beforeAll(async () => {
  crypto = await cryptoProvider();
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function encrypt(plaintext: Uint8Array) {
  const chunks: Uint8Array[] = [];
  const stream = encryptStream(
    crypto,
    (async function* () {
      await Promise.resolve();
      yield plaintext;
    })(),
  );
  for (;;) {
    const next = await stream.next();
    if (next.done) return { ciphertext: Buffer.concat(chunks), encrypted: next.value };
    chunks.push(next.value);
  }
}

async function decrypt(encrypted: EncryptedAttachment, ciphertext: Uint8Array): Promise<Buffer> {
  const out: Uint8Array[] = [];
  for await (const chunk of decryptStream(
    crypto,
    encrypted,
    (async function* () {
      await Promise.resolve();
      yield ciphertext;
    })(),
  )) {
    out.push(chunk);
  }
  return Buffer.concat(out);
}

function stagingSuite(kind: 'fs' | 's3') {
  describe(`attachment staging (${kind})`, () => {
    let server: TestServer;
    let root = '';
    let base = '';
    let alice: TestDeviceSession;
    let bob: TestDeviceSession;
    let eve: TestDeviceSession;
    const api = (session: TestDeviceSession): AttachmentsApi =>
      attachmentsApi(
        createApiClient({ baseUrl: base, getAccessToken: () => session.accessToken, retries: 0 }),
      );
    const janitor = () =>
      createAttachmentService(server.config, {
        db: server.mongo.db,
        clock: server.clock,
        metrics: new Metrics({
          redisCommands: () => 0,
          mongoMailbox: () => Promise.resolve({ count: 0, oldestAgeSeconds: 0 }),
        }),
        log: pino({ level: 'silent' }),
      }).service.janitor();

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), 'pingdost-attachments-'));
      const port = await freePort();
      base = `http://127.0.0.1:${port}`;
      if (kind === 's3') {
        const client = new S3Client({
          endpoint: S3.endpoint,
          region: 'us-east-1',
          credentials: { accessKeyId: S3.accessKey, secretAccessKey: S3.secretKey },
          forcePathStyle: true,
        });
        await client.send(new CreateBucketCommand({ Bucket: S3.bucket })).catch(() => undefined);
      }
      server = await startTestServer({
        env: {
          PUBLIC_API_URL: base,
          ATTACHMENT_FS_ROOT: root,
          ATTACHMENT_ORPHAN_SECONDS: '600',
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
        // Small quotas: the whole file stages about 32 MiB in all.
        attachments: {
          settings: { userQuotaBytes: 32 * 1_048_576, totalQuotaBytes: 48 * 1_048_576 },
        },
      });
      await server.app.listen({ host: '127.0.0.1', port });
      alice = await deviceSession(server, crypto);
      bob = await deviceSession(server, crypto);
      eve = await deviceSession(server, crypto);
    }, 60_000);

    afterAll(async () => {
      await server.close();
      await rm(root, { recursive: true, force: true });
    });

    async function staged(plaintext: Uint8Array, expiresAt?: number) {
      const { ciphertext, encrypted } = await encrypt(plaintext);
      const attachmentId = uuidv7();
      const sent: number[] = [];
      const status = await uploadAttachment({
        api: api(alice),
        attachmentId,
        ciphertextSize: ciphertext.length,
        ciphertextSha256: encrypted.ciphertextSha256,
        recipientDeviceIds: [bob.deviceId],
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        readRange: (start, end) => Promise.resolve(ciphertext.subarray(start, end)),
        sendPart: async (url, body) => {
          sent.push(Number(new URL(url).pathname.split('/').pop()) || 0);
          return (
            await fetch(url, {
              method: 'PUT',
              body: body as Uint8Array<ArrayBuffer>,
              headers: { 'content-type': 'application/octet-stream' },
            })
          ).status;
        },
      });
      return { attachmentId, ciphertext, encrypted, status, sent };
    }

    it('stages ciphertext only, serves it to recipients only, and deletes it on the last ACK', async () => {
      const marker = `PLAINTEXT-MARKER-${randomUUID()}`;
      const plaintext = Buffer.concat([Buffer.from(marker), Buffer.alloc(3 * 1_048_576 + 777, 7)]);
      const { attachmentId, ciphertext, encrypted, status } = await staged(plaintext);
      expect(status.status).toBe('ready');

      if (kind === 'fs') {
        // REQ §19.3: the staged bytes hold no plaintext.
        const shard = join(root, attachmentId.slice(-2));
        const stored = await readFile(join(shard, attachmentId));
        expect(stored.equals(ciphertext)).toBe(true);
        expect(containsMarker(stored, marker)).toBe(false);
      }

      await expect(api(eve).downloadUrl(attachmentId)).rejects.toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
      });
      const { url, ciphertextBytes } = await api(bob).downloadUrl(attachmentId);
      expect(ciphertextBytes).toBe(ciphertext.length);
      const downloaded = Buffer.from(await (await fetch(url)).arrayBuffer());
      expect(downloaded.equals(ciphertext)).toBe(true);
      expect((await decrypt(encrypted, downloaded)).equals(plaintext)).toBe(true);
      const ranged = await fetch(url, { headers: { range: 'bytes=10-19' } });
      expect(ranged.status).toBe(206);
      expect(Buffer.from(await ranged.arrayBuffer()).equals(ciphertext.subarray(10, 20))).toBe(
        true,
      );

      await api(bob).ack(attachmentId);
      await expect(api(bob).downloadUrl(attachmentId)).rejects.toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
      });
      expect((await fetch(url)).ok).toBe(false);
      if (kind === 'fs') {
        await expect(stat(join(root, attachmentId.slice(-2), attachmentId))).rejects.toThrow();
      }
    });

    it('resumes an interrupted upload, sending only the missing parts', async () => {
      const plaintext = Buffer.alloc(kind === 's3' ? 6 * 1_048_576 : 3 * 1_048_576, 3);
      const { ciphertext, encrypted } = await encrypt(plaintext);
      const attachmentId = uuidv7();
      const input = {
        api: api(alice),
        attachmentId,
        ciphertextSize: ciphertext.length,
        ciphertextSha256: encrypted.ciphertextSha256,
        recipientDeviceIds: [bob.deviceId],
        readRange: (start: number, end: number) => Promise.resolve(ciphertext.subarray(start, end)),
        attempts: 1,
      };
      const sent: number[] = [];
      let failAt: number | undefined = 1;
      const sendPart = async (url: string, body: Uint8Array) => {
        // fs: …/parts/<index>; S3: a presigned UploadPart URL with a 1-based partNumber.
        const parsed = new URL(url);
        const part =
          kind === 'fs'
            ? Number(parsed.pathname.split('/').pop())
            : Number(parsed.searchParams.get('partNumber')) - 1;
        sent.push(part);
        if (part === failAt) return 503;
        return (
          await fetch(url, {
            method: 'PUT',
            body: body as Uint8Array<ArrayBuffer>,
            headers: { 'content-type': 'application/octet-stream' },
          })
        ).status;
      };
      await expect(uploadAttachment({ ...input, sendPart })).rejects.toThrow();
      failAt = undefined;
      sent.length = 0;
      const done = await uploadAttachment({ ...input, sendPart });
      expect(done.status).toBe('ready');
      // Part 0 arrived the first time and is not sent again.
      expect(sent[0]).not.toBe(0);
      const { url } = await api(bob).downloadUrl(attachmentId);
      expect(Buffer.from(await (await fetch(url)).arrayBuffer()).equals(ciphertext)).toBe(true);
    }, 60_000);

    it('refuses a ciphertext that differs from its announced SHA-256', async () => {
      const { ciphertext } = await encrypt(Buffer.alloc(100_000, 1));
      const attachmentId = uuidv7();
      await expect(
        uploadAttachment({
          api: api(alice),
          attachmentId,
          ciphertextSize: ciphertext.length,
          ciphertextSha256: new Uint8Array(32).fill(9),
          recipientDeviceIds: [bob.deviceId],
          readRange: (start, end) => Promise.resolve(ciphertext.subarray(start, end)),
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
      await expect(api(bob).downloadUrl(attachmentId)).rejects.toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
      });
    });

    it('enforces the size limit, the quota and real recipients', async () => {
      // Its own uploader, so the quota left in use here does not touch the other tests.
      const carol = await deviceSession(server, crypto);
      const create = (bytes: number, recipients = [bob.deviceId]) =>
        api(carol).create({
          attachmentId: uuidv7(),
          ciphertextBytes: bytes,
          ciphertextSha256: 'A'.repeat(43),
          recipientDeviceIds: recipients,
        });
      await expect(create(105 * 1_048_576)).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' });
      await expect(create(1_000, [uuidv7()])).rejects.toMatchObject({ code: 'RECIPIENT_UNKNOWN' });
      await create(20 * 1_048_576);
      await expect(create(20 * 1_048_576)).rejects.toMatchObject({
        code: 'ATTACHMENT_QUOTA_EXCEEDED',
      });
      // All users' staging together is capped too (the VPS disk): within dave's own quota,
      // but over the total.
      const dave = await deviceSession(server, crypto);
      await expect(
        api(dave).create({
          attachmentId: uuidv7(),
          ciphertextBytes: 30 * 1_048_576,
          ciphertextSha256: 'A'.repeat(43),
          recipientDeviceIds: [bob.deviceId],
        }),
      ).rejects.toMatchObject({ code: 'ATTACHMENT_STAGING_FULL' });
    });

    if (kind === 'fs') {
      it('lets signed URLs expire', async () => {
        const { attachmentId } = await staged(Buffer.alloc(10_000, 5));
        const { url } = await api(bob).downloadUrl(attachmentId);
        server.clock.advance(server.config.ATTACHMENT_PRESIGNED_URL_TTL_SECONDS * 1_000 + 1_000);
        try {
          expect((await fetch(url)).status).toBe(403);
        } finally {
          server.clock.advance(
            -(server.config.ATTACHMENT_PRESIGNED_URL_TTL_SECONDS * 1_000 + 1_000),
          );
        }
      });
    }

    it('janitor: deletes expired objects, orphaned and partial uploads, and leftovers', async () => {
      const expiring = await staged(Buffer.alloc(5_000, 1), server.clock.now() + 60_000);
      // A partial upload: one part of several, never completed.
      const partial = await encrypt(Buffer.alloc(kind === 's3' ? 6 * 1_048_576 : 2 * 1_048_576, 2));
      const partialId = uuidv7();
      const created = await api(alice).create({
        attachmentId: partialId,
        ciphertextBytes: partial.ciphertext.length,
        ciphertextSha256: Buffer.from(partial.encrypted.ciphertextSha256)
          .toString('base64')
          .replace(/=+$/, ''),
        recipientDeviceIds: [bob.deviceId],
      });
      const first = created.uploadUrls[0]!;
      const firstPart = partial.ciphertext.subarray(0, created.partSize);
      expect(
        (
          await fetch(first.url, {
            method: 'PUT',
            body: firstPart,
            headers: { 'content-type': 'application/octet-stream' },
          })
        ).ok,
      ).toBe(true);
      if (kind === 'fs') {
        // A leftover no record claims (e.g. a crash between a write and its record).
        const strayDir = join(root, 'zz');
        await mkdir(strayDir, { recursive: true });
        await writeFile(join(strayDir, `${uuidv7()}.stray.tmp`), 'x');
        const old = new Date(Date.now() - 3_600_000);
        await utimes(join(strayDir, (await readdir(strayDir))[0]!), old, old);
      }

      server.clock.advance(11 * 60_000); // past the expiry and the orphan window
      try {
        const counts = await janitor();
        expect(counts.expired).toBeGreaterThanOrEqual(1);
        expect(counts.orphaned).toBeGreaterThanOrEqual(1);
        if (kind === 'fs') expect(counts.leftover).toBeGreaterThanOrEqual(1);
      } finally {
        server.clock.advance(-11 * 60_000);
      }
      await expect(api(bob).downloadUrl(expiring.attachmentId)).rejects.toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
      });
      await expect(api(alice).status(partialId)).rejects.toMatchObject({
        code: 'ATTACHMENT_NOT_FOUND',
      });
      if (kind === 'fs') {
        await expect(stat(join(root, partialId.slice(-2), `${partialId}.parts`))).rejects.toThrow();
      } else {
        const client = new S3Client({
          endpoint: S3.endpoint,
          region: 'us-east-1',
          credentials: { accessKeyId: S3.accessKey, secretAccessKey: S3.secretKey },
          forcePathStyle: true,
        });
        const uploads = await client.send(new ListMultipartUploadsCommand({ Bucket: S3.bucket }));
        expect((uploads.Uploads ?? []).some((u) => u.Key?.endsWith(partialId))).toBe(false);
      }
    }, 60_000);
  });
}

stagingSuite('fs');
if (s3Up) stagingSuite('s3');
else
  describe.skip('attachment staging (s3): start it with `docker compose --profile s3 up -d --wait`', () =>
    undefined);
