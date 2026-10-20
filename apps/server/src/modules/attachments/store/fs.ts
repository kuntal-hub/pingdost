/**
 * The `fs` attachment store (ADR 0017): files on the VPS disk under
 * `ATTACHMENT_FS_ROOT/<2-char shard>/`, served by the API itself through HMAC-signed URLs
 * (`../signer.ts`, `../routes.ts`). Parts land as `<id>.parts/<n>` (written to a temporary
 * name, then renamed); `complete` streams them into `<id>.<random>.tmp` while hashing and
 * renames that to `<id>`, so a half-joined file is never served.
 */
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

import type { AttachmentStore, StagedPart } from './types';
import type { UrlSigner } from '../signer';

export class FsAttachmentStore implements AttachmentStore {
  readonly kind = 'fs';

  constructor(
    private readonly root: string,
    private readonly signer: UrlSigner,
  ) {}

  #dir(id: string): string {
    return join(this.root, id.slice(-2));
  }

  #object(id: string): string {
    return join(this.#dir(id), id);
  }

  #parts(id: string): string {
    return join(this.#dir(id), `${id}.parts`);
  }

  async begin(id: string): Promise<undefined> {
    await mkdir(this.#parts(id), { recursive: true });
    return undefined;
  }

  uploadUrl(id: string, _uploadId: string | undefined, index: number, expiresAt: number) {
    return Promise.resolve(this.signer.uploadUrl(id, index, expiresAt));
  }

  /** Stores one part (the signed `PUT`); replacing an earlier copy of it is fine. */
  async writePart(id: string, index: number, body: Uint8Array): Promise<void> {
    const dir = this.#parts(id);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${index}.${randomUUID()}.tmp`);
    await writeFile(tmp, body);
    await rename(tmp, join(dir, String(index)));
  }

  async listParts(id: string): Promise<StagedPart[]> {
    let names: string[];
    try {
      names = await readdir(this.#parts(id));
    } catch {
      return [];
    }
    const parts: StagedPart[] = [];
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const { size } = await stat(join(this.#parts(id), name));
      parts.push({ index: Number(name), size });
    }
    return parts.sort((a, b) => a.index - b.index);
  }

  async complete(id: string, _uploadId: string | undefined, partCount: number) {
    const tmp = join(this.#dir(id), `${id}.${randomUUID()}.tmp`);
    const hash = createHash('sha256');
    let size = 0;
    const out = createWriteStream(tmp);
    try {
      for (let index = 0; index < partCount; index++) {
        for await (const chunk of createReadStream(join(this.#parts(id), String(index)))) {
          const bytes = chunk as Buffer;
          hash.update(bytes);
          size += bytes.length;
          if (!out.write(bytes)) await once(out, 'drain');
        }
      }
      out.end();
      await finished(out);
    } catch (error) {
      out.destroy();
      await rm(tmp, { force: true });
      throw error;
    }
    await rename(tmp, this.#object(id));
    await rm(this.#parts(id), { recursive: true, force: true });
    return { size, sha256: hash.digest() };
  }

  downloadUrl(id: string, deviceId: string, expiresAt: number) {
    return Promise.resolve(this.signer.downloadUrl(id, deviceId, expiresAt));
  }

  /** The joined object's size, or undefined if it is not there. */
  async size(id: string): Promise<number | undefined> {
    try {
      return (await stat(this.#object(id))).size;
    } catch {
      return undefined;
    }
  }

  /** Bytes `start` to `end` (inclusive) of the joined object. */
  stream(id: string, start: number, end: number): ReadStream {
    return createReadStream(this.#object(id), { start, end });
  }

  async delete(id: string): Promise<void> {
    await rm(this.#object(id), { force: true });
    await rm(this.#parts(id), { recursive: true, force: true });
  }

  async sweep(before: number, known: (id: string) => Promise<boolean>): Promise<number> {
    let shards: string[];
    try {
      shards = await readdir(this.root);
    } catch {
      return 0;
    }
    let deleted = 0;
    for (const shard of shards) {
      const dir = join(this.root, shard);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const path = join(dir, name);
        const { mtimeMs } = await stat(path).catch(() => ({ mtimeMs: Infinity }));
        if (mtimeMs >= before) continue;
        const id = name.split('.')[0] ?? '';
        if (await known(id)) continue;
        await rm(path, { recursive: true, force: true });
        deleted++;
      }
    }
    return deleted;
  }
}
