// An attachment inside a web chat bubble (REQ §10, §13.2; ADR 0021). Previews load by
// themselves (they are small); the file itself only when asked for, from the staged copy or
// else from the phone. Images and videos open in a viewer, audio plays in the bubble, other
// files are saved. Everything is decrypted in this tab only; the cache keeps ciphertext.
import {
  Download,
  FileText,
  Image as ImageIcon,
  Music,
  Play,
  RotateCw,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useState } from 'react';

import { fileCache, phoneFileLimitMb } from '@/attachments/cache';
import type { TransferError, TransferStatus } from '@/attachments/transfers';
import { objectUrl, saveFile, shownInline } from '@/attachments/view';
import { useChatClient } from '@/chat/store';
import { Button } from '@/components/ui/button';
import { useSession } from '@/session/session';
import { formatSize } from '@pingdost/attachments';
import { attachmentType } from '@pingdost/chat-core';
import type { AttachmentInfo, MessageRecord } from '@pingdost/message-engine';

const ERRORS: Record<TransferError, (info: AttachmentInfo) => string> = {
  too_large: (info) =>
    `Too large to fetch from your phone (${formatSize(info.ciphertextSize)}; the limit is ${phoneFileLimitMb()} MB, see Settings → Storage). Open it on your phone.`,
  missing: () => "Your phone doesn't have this file (any more).",
  phone_offline: () => "Your phone is offline. Try again when it's online.",
  offline: () => "You're offline. Try again when you're back.",
  no_phone: () => 'No phone found for this account.',
  integrity: () => "The file didn't arrive intact. Try again.",
  network: () => 'The download failed. Try again.',
  failed: () => 'The download failed. Try again.',
};

/** The latest download of one file (by attachment ID) or upload of one message (message ID). */
const KIND_ICONS: Record<ReturnType<typeof attachmentType>['kind'], LucideIcon> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  file: FileText,
};

function useTransfer(
  direction: 'down' | 'up',
  key: string | undefined,
): TransferStatus | undefined {
  const client = useChatClient();
  const [status, setStatus] = useState<TransferStatus>();
  useEffect(() => {
    if (!client || !key) return;
    const mine = (s: TransferStatus) =>
      s.direction === direction && (direction === 'down' ? s.attachmentId : s.messageId) === key;
    let live = true;
    void client.transfers().then(
      (all) => {
        const found = all.find(mine);
        if (live && found) setStatus(found);
      },
      () => undefined,
    );
    const unsubscribe = client.onTransfer((next) => {
      if (mine(next)) setStatus(next);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [client, direction, key]);
  return status;
}

/** An object URL once the file is in the cache (checked again when a transfer finishes). */
function useCachedUrl(
  info: AttachmentInfo | null | undefined,
  finished: boolean,
): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!info) return;
    let live = true;
    void fileCache()
      .isComplete(info.attachmentId)
      .then((complete) => (complete ? objectUrl(info) : undefined))
      .then(
        (made) => live && made && setUrl(made),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [info, finished]);
  return url;
}

function Progress({ status }: { status: TransferStatus }) {
  const percent = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
  const from = status.source === 'phone' ? ' from your phone' : '';
  return (
    <span className="block text-xs opacity-80" role="status">
      {status.direction === 'up' ? `Uploading ${percent}%` : `Downloading${from} ${percent}%`}
    </span>
  );
}

function Viewer({
  open,
  onOpenChange,
  info,
  url,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  info: AttachmentInfo;
  url: string;
  title: string;
}) {
  const video = info.mimeType.startsWith('video/');
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/80" />
        <DialogPrimitive.Content className="fixed top-1/2 left-1/2 z-50 flex max-h-[96vh] w-[min(96vw,72rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-2 text-white">
          <div className="flex items-center gap-2">
            <DialogPrimitive.Title className="flex-1 truncate font-semibold">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            <button
              type="button"
              className="rounded p-2 hover:bg-white/10"
              aria-label="Save to this computer"
              onClick={() => void saveFile(info, video ? 'video' : 'photo')}
            >
              <Download size={20} />
            </button>
            <DialogPrimitive.Close className="rounded p-2 hover:bg-white/10" aria-label="Close">
              <X size={20} />
            </DialogPrimitive.Close>
          </div>
          {video ? (
            <video src={url} controls autoPlay className="max-h-[86vh] w-full rounded bg-black" />
          ) : (
            <img src={url} alt={title} className="max-h-[86vh] w-full rounded object-contain" />
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function AttachmentView({ message }: { message: MessageRecord }) {
  const client = useChatClient();
  const deviceId = useSession((state) => state.device?.deviceId);
  const info = message.attachment;
  const thumbnail = info?.thumbnail ?? null;
  const fileStatus = useTransfer('down', info?.attachmentId);
  const thumbStatus = useTransfer('down', thumbnail?.attachmentId);
  const upload = useTransfer('up', message.messageId);
  const fileUrl = useCachedUrl(info, fileStatus?.phase === 'done');
  const thumbUrl = useCachedUrl(thumbnail, thumbStatus?.phase === 'done');
  const [viewing, setViewing] = useState(false);
  const [wanted, setWanted] = useState<'view' | 'save' | undefined>();
  const { kind, name } = attachmentType(message);
  const KindIcon = KIND_ICONS[kind];

  // Previews come by themselves.
  useEffect(() => {
    if (client && thumbnail && !thumbUrl) {
      void client.downloadAttachment(message.messageId, 'thumbnail').catch(() => undefined);
    }
  }, [client, message.messageId, thumbnail, thumbUrl]);

  // What the user asked for happens once the file is here.
  useEffect(() => {
    if (!fileUrl || !wanted || !info) return;
    if (wanted === 'view') setViewing(true);
    else void saveFile(info, name);
    setWanted(undefined);
  }, [fileUrl, wanted, info, name]);

  if (!info) return null;
  const mime = info.mimeType;
  const visual = mime.startsWith('image/') || mime.startsWith('video/');
  const inline = shownInline(mime);
  const size = formatSize(info.plaintextSize);
  const downloading = fileStatus?.phase === 'running';
  const failed = fileStatus?.phase === 'failed' && fileStatus.error ? fileStatus.error : undefined;
  const ownUpload = message.senderDeviceId === deviceId && message.state === 'local_queued';

  const fetchFile = (intent: 'view' | 'save') => {
    setWanted(intent);
    if (!fileUrl) void client?.downloadAttachment(message.messageId).catch(() => undefined);
  };

  const status = (
    <>
      {ownUpload && upload?.phase === 'running' && <Progress status={upload} />}
      {ownUpload && upload?.phase === 'failed' && (
        <span className="flex items-center gap-2 text-xs">
          Not sent yet: the upload stopped.
          <button
            type="button"
            className="inline-flex items-center gap-1 underline"
            onClick={() => void client?.retryUpload(message.messageId)}
          >
            <RotateCw size={12} /> Retry
          </button>
        </span>
      )}
      {downloading && <Progress status={fileStatus} />}
      {failed && (
        <span className="block text-xs" role="alert">
          {ERRORS[failed](info)}
        </span>
      )}
    </>
  );

  if (visual && inline) {
    const preview = fileUrl && mime.startsWith('image/') ? fileUrl : thumbUrl;
    const ratio = info.width && info.height ? `${info.width} / ${info.height}` : '4 / 3';
    return (
      <span className="block">
        <button
          type="button"
          className="relative block w-64 max-w-full overflow-hidden rounded-md bg-black/20"
          // The aspect ratio is data, set through the CSSOM (no inline styles in the CSP).
          ref={(element) => {
            if (element) element.style.aspectRatio = ratio;
          }}
          aria-label={`Open ${name.toLowerCase()} (${size})`}
          onClick={() => (fileUrl ? setViewing(true) : fetchFile('view'))}
        >
          {preview ? (
            <img src={preview} alt="" className="h-full w-full object-cover" />
          ) : (
            <span className="flex h-full items-center justify-center">
              <KindIcon aria-hidden size={36} />
            </span>
          )}
          {mime.startsWith('video/') && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="rounded-full bg-black/60 p-3 text-white">
                <Play size={22} />
              </span>
            </span>
          )}
          {!fileUrl && !downloading && (
            <span className="absolute right-1 bottom-1 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
              {size}
            </span>
          )}
        </button>
        {status}
        {fileUrl && (
          <Viewer open={viewing} onOpenChange={setViewing} info={info} url={fileUrl} title={name} />
        )}
      </span>
    );
  }

  if (mime.startsWith('audio/') && inline) {
    return (
      <span className="block">
        {fileUrl ? (
          <audio src={fileUrl} controls className="w-64 max-w-full" />
        ) : (
          <Button
            variant="secondary"
            className="min-h-9 px-3 text-sm"
            disabled={downloading}
            onClick={() => fetchFile('view')}
          >
            <Play size={16} /> {name} · {size}
          </Button>
        )}
        {status}
      </span>
    );
  }

  return (
    <span className="block">
      <span className="flex items-center gap-3 rounded-lg bg-black/10 p-2">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-md bg-black/10">
          <KindIcon aria-hidden size={22} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{name}</span>
          <span className="block text-xs opacity-80">{size}</span>
        </span>
        <button
          type="button"
          className="pd-press cursor-pointer rounded-full p-2 hover:bg-black/10 disabled:opacity-50"
          aria-label={`Save ${name}`}
          disabled={downloading}
          onClick={() => (fileUrl ? void saveFile(info, name) : fetchFile('save'))}
        >
          <Download size={18} />
        </button>
      </span>
      {status}
    </span>
  );
}
