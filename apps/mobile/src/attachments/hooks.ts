// Attachment state for the chat UI: a message's transfer rows (made on first sight, which
// queues its automatic downloads) with live progress, and its thumbnail decrypted into memory
// only (a data URI), never to disk.
import { useEffect, useState } from 'react';

import type { MessageRecord } from '@pingdost/message-engine';
import { toBase64 } from '@pingdost/protocol';

import { maybeAttachmentContext } from './context';
import { vaultFile } from './files';
import { decryptToBytes } from './pipeline';
import type { AttachmentRow } from './repo';
import { ensureRows, useTransferStore } from './transfers';

export interface AttachmentRows {
  file: AttachmentRow | undefined;
  thumbnail: AttachmentRow | undefined;
  /** Bytes moved so far of the file's current transfer. */
  fileProgress: number | undefined;
  loaded: boolean;
}

export function useAttachmentRows(message: MessageRecord): AttachmentRows {
  const revision = useTransferStore((state) => state.revisions[message.messageId] ?? 0);
  const [rows, setRows] = useState<AttachmentRow[]>();
  const fileId = message.attachment?.attachmentId;
  const fileProgress = useTransferStore((state) => (fileId ? state.progress[fileId] : undefined));

  useEffect(() => {
    let alive = true;
    void ensureRows(message)
      .then((next) => alive && setRows(next))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // The message object changes with every reaction; its ID and content do not.
  }, [message.messageId, message.kind, revision]);

  return {
    file: rows?.find((r) => r.role === 'file'),
    thumbnail: rows?.find((r) => r.role === 'thumbnail'),
    fileProgress,
    loaded: rows !== undefined,
  };
}

/** Decrypted thumbnails, newest last; small (≤ 256 KiB each) and few. */
const THUMBNAILS_KEPT = 60;
const thumbnails = new Map<string, string>();

function remember(id: string, uri: string): void {
  thumbnails.delete(id);
  thumbnails.set(id, uri);
  while (thumbnails.size > THUMBNAILS_KEPT) thumbnails.delete(thumbnails.keys().next().value!);
}

/** Forgets decrypted thumbnails (Clear cache). */
export function forgetThumbnails(): void {
  thumbnails.clear();
}

/** The thumbnail as a data URI once its vault copy is there. */
export function useThumbnail(
  message: MessageRecord,
  row: AttachmentRow | undefined,
): string | undefined {
  const info = message.attachment?.thumbnail ?? null;
  const ready = row !== undefined && (row.state === 'done' || row.direction === 'up');
  const [uri, setUri] = useState(() => (info ? thumbnails.get(info.attachmentId) : undefined));

  useEffect(() => {
    if (!info || !ready) return;
    const cached = thumbnails.get(info.attachmentId);
    if (cached) {
      setUri(cached);
      return;
    }
    const context = maybeAttachmentContext();
    if (!context || !vaultFile(info.attachmentId).exists) return;
    let alive = true;
    void decryptToBytes(context.provider, info)
      .then((bytes) => {
        const mime = info.mimeType.startsWith('image/') ? info.mimeType : 'image/jpeg';
        const next = `data:${mime};base64,${toBase64(bytes)}`;
        remember(info.attachmentId, next);
        if (alive) setUri(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // `info` is a new object with every message update; its ID says whether it changed.
  }, [info?.attachmentId, ready]);

  return ready ? uri : undefined;
}
