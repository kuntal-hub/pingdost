// Files this phone sends a linked browser that asks for them (ADR 0021): the vault copy, which is
// the attachment's own ciphertext exactly as staged (ADR 0018), read in the range asked for. Only
// a complete copy is offered; the browser checks it against the manifest before using it.
import { readRange, vaultFile } from '@/attachments/files';
import type { AttachmentRepo } from '@/attachments/repo';
import type { SyncFiles } from '@pingdost/message-engine';

export function vaultSyncFiles(repo: AttachmentRepo): SyncFiles {
  return {
    async read(attachmentId, offset, length) {
      const row = await repo.get(attachmentId);
      if (!row?.localPath || row.state === 'removed' || row.state === 'gone') return undefined;
      const file = vaultFile(row.localPath);
      if (!file.exists || file.size !== row.ciphertextSize || offset > file.size) return undefined;
      const end = Math.min(offset + length, file.size);
      return { data: await readRange(file, offset, end), totalSize: file.size };
    },
  };
}
