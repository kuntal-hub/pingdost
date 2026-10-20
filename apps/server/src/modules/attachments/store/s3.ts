/**
 * The `s3` attachment store (ADR 0017): an S3-compatible bucket (Cloudflare R2; SeaweedFS
 * locally) through AWS SDK v3. Uploads are multipart with presigned `UploadPart` URLs (S3 needs
 * parts of at least 5 MiB except the last, hence `S3_PART_CHUNKS`); downloads are presigned
 * `GetObject` URLs. After `CompleteMultipartUpload` the object is read back once to check its
 * SHA-256 (R2 egress is free). Checksums are added only when an API requires them: the SDK's
 * default flexible checksums would put headers into presigned URLs that clients do not send.
 */
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
  type Part,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { AttachmentStore, StagedPart } from './types';
import type { Clock } from '../../../infra/clock';

const PREFIX = 'attachments/';

export interface S3StoreOptions {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
}

export class S3AttachmentStore implements AttachmentStore {
  readonly kind = 's3';
  readonly client: S3Client;
  readonly #bucket: string;

  constructor(
    options: S3StoreOptions,
    private readonly clock: Clock,
  ) {
    this.#bucket = options.bucket;
    this.client = new S3Client({
      endpoint: options.endpoint,
      region: options.region,
      credentials: { accessKeyId: options.accessKey, secretAccessKey: options.secretKey },
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  #key(id: string): string {
    return `${PREFIX}${id}`;
  }

  #expiresIn(expiresAt: number): number {
    return Math.max(1, Math.round((expiresAt - this.clock.now()) / 1_000));
  }

  async begin(id: string): Promise<string> {
    const created = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: this.#key(id),
        ContentType: 'application/octet-stream',
      }),
    );
    if (!created.UploadId) throw new Error('the object store returned no upload ID');
    return created.UploadId;
  }

  uploadUrl(id: string, uploadId: string | undefined, index: number, expiresAt: number) {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.#bucket,
        Key: this.#key(id),
        UploadId: uploadId,
        PartNumber: index + 1,
      }),
      { expiresIn: this.#expiresIn(expiresAt) },
    );
  }

  async #parts(id: string, uploadId: string | undefined): Promise<Part[]> {
    if (!uploadId) return [];
    const parts: Part[] = [];
    let marker: string | undefined;
    for (;;) {
      const page = await this.client.send(
        new ListPartsCommand({
          Bucket: this.#bucket,
          Key: this.#key(id),
          UploadId: uploadId,
          ...(marker ? { PartNumberMarker: marker } : {}),
        }),
      );
      parts.push(...(page.Parts ?? []));
      if (!page.IsTruncated || !page.NextPartNumberMarker) return parts;
      marker = page.NextPartNumberMarker;
    }
  }

  async listParts(id: string, uploadId: string | undefined): Promise<StagedPart[]> {
    return (await this.#parts(id, uploadId))
      .map((part) => ({ index: (part.PartNumber ?? 0) - 1, size: part.Size ?? 0 }))
      .sort((a, b) => a.index - b.index);
  }

  async complete(id: string, uploadId: string | undefined, partCount: number) {
    const parts = (await this.#parts(id, uploadId))
      .filter((part) => (part.PartNumber ?? 0) <= partCount)
      .sort((a, b) => (a.PartNumber ?? 0) - (b.PartNumber ?? 0));
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.#bucket,
        Key: this.#key(id),
        UploadId: uploadId,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })) },
      }),
    );
    const object = await this.client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: this.#key(id) }),
    );
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of object.Body as Readable) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      size += bytes.length;
    }
    return { size, sha256: hash.digest() };
  }

  downloadUrl(id: string, _deviceId: string, expiresAt: number) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.#bucket, Key: this.#key(id) }),
      {
        expiresIn: this.#expiresIn(expiresAt),
      },
    );
  }

  async delete(id: string, uploadId: string | undefined): Promise<void> {
    if (uploadId) {
      try {
        await this.client.send(
          new AbortMultipartUploadCommand({
            Bucket: this.#bucket,
            Key: this.#key(id),
            UploadId: uploadId,
          }),
        );
      } catch (error) {
        // Completed or already aborted.
        if ((error as { name?: string }).name !== 'NoSuchUpload') throw error;
      }
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: this.#key(id) }));
  }

  async sweep(before: number, known: (id: string) => Promise<boolean>): Promise<number> {
    let deleted = 0;
    let keyMarker: string | undefined;
    let uploadMarker: string | undefined;
    for (;;) {
      const page = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.#bucket,
          Prefix: PREFIX,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(uploadMarker ? { UploadIdMarker: uploadMarker } : {}),
        }),
      );
      for (const upload of page.Uploads ?? []) {
        const id = (upload.Key ?? '').slice(PREFIX.length);
        if ((upload.Initiated?.getTime() ?? Infinity) >= before || (await known(id))) continue;
        await this.delete(id, upload.UploadId);
        deleted++;
      }
      if (!page.IsTruncated) break;
      keyMarker = page.NextKeyMarker;
      uploadMarker = page.NextUploadIdMarker;
    }
    let token: string | undefined;
    for (;;) {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: PREFIX,
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const object of page.Contents ?? []) {
        const id = (object.Key ?? '').slice(PREFIX.length);
        if ((object.LastModified?.getTime() ?? Infinity) >= before || (await known(id))) continue;
        await this.delete(id, undefined);
        deleted++;
      }
      if (!page.IsTruncated || !page.NextContinuationToken) break;
      token = page.NextContinuationToken;
    }
    return deleted;
  }
}
