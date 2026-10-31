/**
 * Writing and reading the encrypted body (ADR 0022), in constant memory: plaintext frames
 * (`type u8 ‖ length u32 BE ‖ payload`) are cut into 64 KiB STREAM chunks as they come, and
 * read back chunk by chunk. Type 1 is a JSON record, type 2 the next bytes of the file named
 * by the preceding `file` record.
 */
import type { CryptoProvider } from '@pingdost/crypto/core';
import { toBase64 } from '@pingdost/protocol';

import { BackupError } from './errors';
import {
  BACKUP_FORMAT_VERSION,
  CHUNK_SIZE,
  CIPHER_CHUNK_SIZE,
  decodeHeader,
  DEFAULT_KDF_PARAMS,
  encodeHeader,
  HEADER_LENGTH,
  NONCE_PREFIX_LENGTH,
  SALT_LENGTH,
  type BackupHeader,
} from './format';
import { defaultRandomBytes, type RandomBytes } from './phrase';
import { checkRecord, type BackupManifest, type BackupRecord } from './records';

const FRAME_JSON = 1;
const FRAME_FILE = 2;
const FRAME_HEADER = 5;
const MAX_JSON_FRAME = 1 << 20;
const MAX_FILE_FRAME = CHUNK_SIZE;

export interface BackupSink {
  write(bytes: Uint8Array): Promise<void>;
}

/** Random access to the file, e.g. a file handle; read twice by `restoreBackup`. */
export interface BackupSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface WriterOptions {
  crypto: CryptoProvider;
  /** The phrase's entropy (`phraseEntropy`). */
  entropy: Uint8Array;
  sink: BackupSink;
  manifest: Omit<BackupManifest, 't' | 'format' | 'headerSha256'>;
  kdf?: BackupHeader['kdf'];
  randomBytes?: RandomBytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function frameHeader(type: number, length: number): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, length);
  return out;
}

export class BackupWriter {
  readonly #sink: BackupSink;
  readonly #encryptor;
  readonly #hasher;
  #pending: Uint8Array[] = [];
  #pendingLength = 0;
  #frames = 0;
  #written = 0;
  #fileLeft = 0;
  #done = false;

  private constructor(options: WriterOptions, key: Uint8Array, noncePrefix: Uint8Array) {
    this.#sink = options.sink;
    this.#encryptor = options.crypto.createAttachmentEncryptor(key, noncePrefix);
    this.#hasher = options.crypto.createSha256();
    key.fill(0);
  }

  /** Derives the key (slow: Argon2id), writes the header and the manifest. */
  static async create(options: WriterOptions): Promise<BackupWriter> {
    const random = options.randomBytes ?? defaultRandomBytes;
    const header: BackupHeader = {
      version: BACKUP_FORMAT_VERSION,
      kdf: options.kdf ?? DEFAULT_KDF_PARAMS,
      salt: random(SALT_LENGTH),
      noncePrefix: random(NONCE_PREFIX_LENGTH),
    };
    const headerBytes = encodeHeader(header);
    const key = options.crypto.deriveBackupKey(options.entropy, header.salt, header.kdf);
    const writer = new BackupWriter(options, key, header.noncePrefix);
    await options.sink.write(headerBytes);
    writer.#written = headerBytes.length;
    await writer.record({
      t: 'manifest',
      format: BACKUP_FORMAT_VERSION,
      headerSha256: toBase64(options.crypto.sha256(headerBytes)),
      ...options.manifest,
    });
    return writer;
  }

  /** Bytes written to the sink so far. */
  get bytesWritten(): number {
    return this.#written;
  }

  async record(record: BackupRecord): Promise<void> {
    if (this.#fileLeft > 0) throw new Error('backup: the current file is not complete');
    const payload = encoder.encode(JSON.stringify(record));
    if (payload.length > MAX_JSON_FRAME) throw new Error('backup: record too large');
    await this.#frame(FRAME_JSON, payload);
    if (record.t === 'file') this.#fileLeft = record.size;
  }

  /** The next bytes of the current file (after a `file` record). */
  async fileData(data: Uint8Array): Promise<void> {
    if (data.length > this.#fileLeft) throw new Error('backup: more file data than announced');
    for (let offset = 0; offset < data.length; offset += MAX_FILE_FRAME) {
      const part = data.subarray(offset, offset + MAX_FILE_FRAME);
      this.#fileLeft -= part.length;
      await this.#frame(FRAME_FILE, part);
    }
  }

  /** Writes the `end` record and the last chunk. */
  async finish(): Promise<{ bytes: number; frames: number }> {
    const frames = this.#frames;
    await this.record({ t: 'end', frames, sha256: toBase64(this.#hasher.digest()) });
    this.#done = true;
    await this.#flush(true);
    this.dispose();
    return { bytes: this.#written, frames };
  }

  dispose(): void {
    this.#encryptor.dispose();
    this.#hasher.dispose();
    this.#pending = [];
  }

  async #frame(type: number, payload: Uint8Array): Promise<void> {
    if (this.#done) throw new Error('backup: already finished');
    const head = frameHeader(type, payload.length);
    // The `end` frame is hashed too, but after `finish` took the digest it carries.
    this.#hasher.update(head);
    this.#hasher.update(payload);
    this.#frames++;
    this.#push(head);
    this.#push(payload);
    await this.#flush(false);
  }

  #push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.#pending.push(bytes.slice());
    this.#pendingLength += bytes.length;
  }

  #take(length: number): Uint8Array {
    const out = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const head = this.#pending[0]!;
      const need = length - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        this.#pending.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.#pending[0] = head.subarray(need);
        filled = length;
      }
    }
    this.#pendingLength -= length;
    return out;
  }

  /** Encrypts every full chunk; at the end also the remainder (< 64 KiB, maybe empty) as last. */
  async #flush(final: boolean): Promise<void> {
    while (this.#pendingLength >= CHUNK_SIZE) {
      await this.#emit(this.#take(CHUNK_SIZE), false);
    }
    if (final) await this.#emit(this.#take(this.#pendingLength), true);
  }

  async #emit(plaintext: Uint8Array, last: boolean): Promise<void> {
    const { ciphertext } = this.#encryptor.encryptChunk(plaintext, last);
    plaintext.fill(0);
    await this.#sink.write(ciphertext);
    this.#written += ciphertext.length;
  }
}

export type BackupItem =
  | { type: 'record'; record: BackupRecord }
  /** The next bytes of the file named by the last `file` record. */
  | { type: 'file_data'; attachmentId: string; data: Uint8Array };

/** The layout of the encrypted body: n − 1 full chunks, then a shorter last one. */
function chunkLayout(size: number): { count: number; lastLength: number } {
  const body = size - HEADER_LENGTH;
  if (body < 16) throw new BackupError('truncated');
  const lastLength = body % CIPHER_CHUNK_SIZE;
  // A full-size last chunk never happens: the last chunk holds less than 64 KiB.
  if (lastLength < 16) throw new BackupError('truncated');
  return { count: Math.floor(body / CIPHER_CHUNK_SIZE) + 1, lastLength };
}

export class BackupReader {
  private constructor(
    private readonly crypto: CryptoProvider,
    private readonly source: BackupSource,
    private readonly key: Uint8Array,
    private readonly header: BackupHeader,
    private readonly headerSha256: string,
    readonly manifest: BackupManifest,
  ) {}

  /** Reads the header, derives the key (slow) and checks the manifest. */
  static async open(
    crypto: CryptoProvider,
    source: BackupSource,
    entropy: Uint8Array,
  ): Promise<BackupReader> {
    const headerBytes = await source.read(0, Math.min(source.size, HEADER_LENGTH));
    const header = decodeHeader(headerBytes);
    chunkLayout(source.size);
    const key = crypto.deriveBackupKey(entropy, header.salt, header.kdf);
    const headerSha256 = toBase64(crypto.sha256(headerBytes));
    const probe = new BackupReader(crypto, source, key, header, headerSha256, undefined as never);
    let manifest: BackupManifest | undefined;
    for await (const item of probe.#items(true)) {
      if (item.type === 'record' && item.record.t === 'manifest') manifest = item.record;
      break;
    }
    if (!manifest) throw new BackupError('corrupt');
    if (manifest.headerSha256 !== headerSha256) throw new BackupError('corrupt');
    return new BackupReader(crypto, source, key, header, headerSha256, manifest);
  }

  /** Every item after the manifest, ending with a verified `end`. Throws `corrupt` otherwise. */
  async *items(): AsyncGenerator<BackupItem> {
    let first = true;
    for await (const item of this.#items(false)) {
      if (first) {
        first = false;
        continue; // the manifest, checked in `open`
      }
      yield item;
    }
  }

  /**
   * The account identity key secret (the record after the manifest), without reading the
   * rest: a new phone needs it to register before it restores anything.
   */
  async identitySecret(): Promise<string> {
    for await (const item of this.items()) {
      if (item.type === 'record' && item.record.t === 'identity') return item.record.secret;
      break;
    }
    throw new BackupError('corrupt');
  }

  /** Reads the whole body once without yielding: authentication, framing and the end hash. */
  async verify(): Promise<{ records: number; files: number }> {
    let records = 0;
    let files = 0;
    for await (const item of this.items()) {
      if (item.type === 'record') {
        records++;
        if (item.record.t === 'file') files++;
      }
    }
    return { records, files };
  }

  dispose(): void {
    this.key.fill(0);
  }

  async *#items(probe: boolean): AsyncGenerator<BackupItem> {
    const { count, lastLength } = chunkLayout(this.source.size);
    const hasher = this.crypto.createSha256();
    let buffer: Uint8Array = new Uint8Array(0);
    let frames = 0;
    let ended = false;
    let file: { attachmentId: string; left: number } | null = null;
    try {
      for (let index = 0; index < count; index++) {
        const last = index === count - 1;
        const offset = HEADER_LENGTH + index * CIPHER_CHUNK_SIZE;
        const ciphertext = await this.source.read(offset, last ? lastLength : CIPHER_CHUNK_SIZE);
        let plaintext: Uint8Array;
        try {
          plaintext = this.crypto.decryptAttachmentChunk(
            this.key,
            this.header.noncePrefix,
            index,
            last,
            ciphertext,
          );
        } catch {
          throw new BackupError(index === 0 ? 'wrong_phrase' : 'corrupt');
        }
        buffer = buffer.length === 0 ? plaintext : concat(buffer, plaintext);
        let offsetInBuffer = 0;
        while (buffer.length - offsetInBuffer >= FRAME_HEADER) {
          if (ended) throw new BackupError('corrupt');
          const type = buffer[offsetInBuffer]!;
          const length = new DataView(
            buffer.buffer,
            buffer.byteOffset + offsetInBuffer + 1,
            4,
          ).getUint32(0);
          const max = type === FRAME_FILE ? MAX_FILE_FRAME : MAX_JSON_FRAME;
          if ((type !== FRAME_JSON && type !== FRAME_FILE) || length > max) {
            throw new BackupError('corrupt');
          }
          const end = offsetInBuffer + FRAME_HEADER + length;
          if (end > buffer.length) break;
          const head = buffer.subarray(offsetInBuffer, offsetInBuffer + FRAME_HEADER);
          const payload = buffer.slice(offsetInBuffer + FRAME_HEADER, end);
          offsetInBuffer = end;
          if (type === FRAME_FILE) {
            if (!file || payload.length > file.left) throw new BackupError('corrupt');
            file.left -= payload.length;
            hasher.update(head);
            hasher.update(payload);
            frames++;
            yield { type: 'file_data', attachmentId: file.attachmentId, data: payload };
            continue;
          }
          if (file && file.left > 0) throw new BackupError('corrupt');
          file = null;
          const record = parseRecord(payload);
          if (frames === 0 && record?.t !== 'manifest') throw new BackupError('corrupt');
          if (record?.t === 'end') {
            const digest = toBase64(hasher.digest());
            if (record.frames !== frames || record.sha256 !== digest) {
              throw new BackupError('corrupt');
            }
            ended = true;
            yield { type: 'record', record };
            continue;
          }
          hasher.update(head);
          hasher.update(payload);
          frames++;
          if (!record) continue;
          if (record.t === 'file') file = { attachmentId: record.attachmentId, left: record.size };
          yield { type: 'record', record };
          if (probe) return;
        }
        buffer = buffer.subarray(offsetInBuffer);
      }
      if (!ended || buffer.length > 0) throw new BackupError('corrupt');
    } finally {
      hasher.dispose();
    }
  }
}

function parseRecord(payload: Uint8Array): BackupRecord | undefined {
  try {
    return checkRecord(JSON.parse(decoder.decode(payload)));
  } catch {
    throw new BackupError('corrupt');
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** An in-memory sink and source, for tests and small exports. */
export function memorySink(): BackupSink & { bytes(): Uint8Array } {
  const parts: Uint8Array[] = [];
  return {
    write: (bytes) => {
      parts.push(bytes.slice());
      return Promise.resolve();
    },
    bytes: () => parts.reduce((all, part) => concat(all, part), new Uint8Array(0)),
  };
}

export function memorySource(bytes: Uint8Array): BackupSource {
  return {
    size: bytes.length,
    read: (offset, length) => Promise.resolve(bytes.slice(offset, offset + length)),
  };
}
