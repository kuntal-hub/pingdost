// Forwarding a file (Phase 39, ADR 0043): from this phone's encrypted copy, decrypted into the
// work folder and sent again as a new attachment (new key, new upload) to each chat, since the
// server's copy may be gone (ADR 0017). The plaintext copy is deleted afterwards.
import type { MessageRecord } from '@pingdost/message-engine';
import { fromBase64 } from '@pingdost/protocol';

import { attachmentContext } from './context';
import { removeFile, vaultFile, workFile } from './files';
import { decryptToFile } from './pipeline';
import { makeDraft, sendDraft } from './send';

/** Whether this phone has the whole encrypted file: sent from here, or downloaded. */
export async function hasLocalCopy(message: MessageRecord): Promise<boolean> {
  if (!message.attachment) return false;
  const rows = await attachmentContext().repo.forMessage(message.messageId);
  const row = rows.find((r) => r.role === 'file');
  if (!row?.localPath) return false;
  const complete = row.direction === 'up' ? row.state !== 'removed' : row.state === 'done';
  return complete && vaultFile(row.localPath).exists;
}

/** Sends the file (and its caption) to each chat as a new attachment; one per chat. */
export async function forwardFile(
  message: MessageRecord,
  conversationIds: readonly string[],
  forwarded: boolean,
): Promise<MessageRecord[]> {
  const info = message.attachment;
  if (!info) throw new Error('not a file');
  const plain = workFile(`forward-${info.attachmentId}`);
  await decryptToFile(attachmentContext().provider, info, plain);
  try {
    const draft = await makeDraft({
      uri: plain.uri,
      name: info.fileName,
      ...(info.width ? { width: info.width } : {}),
      ...(info.height ? { height: info.height } : {}),
      durationMs: info.durationMs ?? null,
      ...(info.waveform
        ? { voice: { waveform: fromBase64(info.waveform), durationMs: info.durationMs ?? 0 } }
        : {}),
      // Kept until every chat has its copy; removed below.
      temporary: false,
    });
    const sent: MessageRecord[] = [];
    for (const conversationId of conversationIds) {
      const job = sendDraft(
        conversationId,
        draft,
        { compress: false, imageQuality: 'standard', caption: message.body, forwarded },
        () => undefined,
      );
      sent.push(await job.result);
    }
    return sent;
  } finally {
    removeFile(plain);
  }
}
