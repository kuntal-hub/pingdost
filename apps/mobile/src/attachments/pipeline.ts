// Streaming a file through the native crypto provider (ADR 0004, 0018): into the vault as its
// STREAM ciphertext, out of it to show, and a full check of a downloaded copy. Every step reads
// and writes about 1 MiB at a time, so a 100 MB file never sits in memory.
import type { File } from 'expo-file-system';
import { FileMode } from 'expo-file-system';

import {
  decryptStream,
  encryptStream,
  verifyStream,
  type EncryptedAttachment,
} from '@pingdost/attachments';
import type { CryptoProvider } from '@pingdost/crypto/core';
import { attachmentDecryptInput, type AttachmentInfo } from '@pingdost/message-engine';
import { uuidv7 } from '@pingdost/protocol';

import { readChunks, READ_BYTES, removeFile, vaultFile, writeChunks } from './files';

export interface VaultEntry {
  attachmentId: string;
  encrypted: EncryptedAttachment;
  file: File;
}

/** Encrypts `source` into a new vault file under a fresh attachment ID. */
export async function encryptToVault(provider: CryptoProvider, source: File): Promise<VaultEntry> {
  const attachmentId = uuidv7();
  const file = vaultFile(attachmentId);
  removeFile(file);
  file.create({ intermediates: true });
  const handle = file.open(FileMode.Truncate);
  let complete = false;
  try {
    const stream = encryptStream(provider, readChunks(source));
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = async () => {
      if (pendingBytes === 0) return;
      const piece = new Uint8Array(pendingBytes);
      let offset = 0;
      for (const part of pending) {
        piece.set(part, offset);
        offset += part.length;
      }
      pending = [];
      pendingBytes = 0;
      await handle.writeBytes(piece);
    };
    for (;;) {
      const next = await stream.next();
      if (next.done) {
        await flush();
        complete = true;
        return { attachmentId, encrypted: next.value, file };
      }
      pending.push(next.value);
      pendingBytes += next.value.length;
      if (pendingBytes >= READ_BYTES) await flush();
    }
  } finally {
    handle.close();
    if (!complete) removeFile(file);
  }
}

/** Checks a vault copy completely (each chunk's tag and the whole-file hash). */
export function verifyVaultFile(provider: CryptoProvider, info: AttachmentInfo): Promise<void> {
  return verifyStream(
    provider,
    attachmentDecryptInput(info),
    readChunks(vaultFile(info.attachmentId)),
  );
}

/** Decrypts a vault copy into `target` (a view file); a failed check leaves no file. */
export async function decryptToFile(
  provider: CryptoProvider,
  info: AttachmentInfo,
  target: File,
): Promise<void> {
  try {
    await writeChunks(
      target,
      decryptStream(
        provider,
        attachmentDecryptInput(info),
        readChunks(vaultFile(info.attachmentId)),
      ),
    );
  } catch (error) {
    removeFile(target);
    throw error;
  }
}

/** Decrypts a small vault copy (a thumbnail) into memory. */
export async function decryptToBytes(
  provider: CryptoProvider,
  info: AttachmentInfo,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of decryptStream(
    provider,
    attachmentDecryptInput(info),
    readChunks(vaultFile(info.attachmentId)),
  )) {
    parts.push(part);
    size += part.length;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
