// Sending a file from the web (REQ §10.1, ADR 0021): a preview, a caption, and for photos the
// choice between compressed (Standard or HD, the default) and the original. Videos go as
// they are: the browser cannot compress them, so one over the limit is refused with the
// reason. The preview is a local object URL of the picked file, dropped when the dialog closes.
import { useEffect, useState } from 'react';

import { useChatClient } from '@/chat/store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog } from '@/components/ui/menu';
import { CAPTION_MAX, formatSize, IMAGE_PRESETS, type ImageQuality } from '@pingdost/attachments';
import { DEFAULT_LIMITS } from '@pingdost/config/public';

export function SendFileDialog({
  file,
  conversationId,
  replyTo,
  onClose,
}: {
  file: File | undefined;
  conversationId: string;
  replyTo: string | undefined;
  onClose: (sent: boolean) => void;
}) {
  const client = useChatClient();
  const [caption, setCaption] = useState('');
  const [original, setOriginal] = useState(false);
  const [quality, setQuality] = useState<ImageQuality>('standard');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [preview, setPreview] = useState<string>();
  const image = file?.type.startsWith('image/') ?? false;
  const video = file?.type.startsWith('video/') ?? false;
  const tooLarge = (file?.size ?? 0) > DEFAULT_LIMITS.attachmentMaxBytes;

  useEffect(() => {
    setCaption('');
    setOriginal(false);
    setError(undefined);
    if (!file || !(image || video)) {
      setPreview(undefined);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file, image, video]);

  async function send() {
    if (!client || !file) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.sendFile(conversationId, file, {
        caption,
        original,
        quality,
        ...(replyTo ? { replyTo } : {}),
      });
      onClose(true);
    } catch (e) {
      setError(
        e instanceof Error && e.name === 'SendFileError'
          ? e.message
          : 'The file could not be prepared. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={file !== undefined}
      onOpenChange={(open) => !open && !busy && onClose(false)}
      title={image ? 'Send photo' : video ? 'Send video' : 'Send file'}
      description={file ? `${file.name} · ${formatSize(file.size)}` : undefined}
    >
      {preview && image && (
        <img src={preview} alt="" className="max-h-64 w-full rounded-md object-contain" />
      )}
      {preview && video && <video src={preview} controls className="max-h-64 w-full rounded-md" />}
      {image && (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={original}
              onChange={(event) => setOriginal(event.target.checked)}
            />
            Send the original (larger, not compressed)
          </label>
          {!original && (
            <label className="flex items-center gap-3">
              <span>Quality</span>
              <select
                className="rounded-md border border-border bg-background px-2 py-1"
                value={quality}
                onChange={(event) => setQuality(event.target.value as ImageQuality)}
              >
                {(Object.keys(IMAGE_PRESETS) as ImageQuality[]).map((key) => (
                  <option key={key} value={key}>
                    {IMAGE_PRESETS[key].label} (up to {IMAGE_PRESETS[key].maxDimension} px)
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {video && (
        <p className="text-sm text-muted">
          {tooLarge
            ? `This video is over the ${formatSize(DEFAULT_LIMITS.attachmentMaxBytes)} limit. Videos can't be compressed in the browser: send it from your phone, which can.`
            : 'Videos are sent as they are: the browser does not compress them.'}
        </p>
      )}
      {!image && !video && tooLarge && (
        <p className="text-sm text-danger">
          This file is over the {formatSize(DEFAULT_LIMITS.attachmentMaxBytes)} limit and can&apos;t
          be sent.
        </p>
      )}
      <Input
        aria-label="Caption"
        placeholder="Add a caption"
        maxLength={CAPTION_MAX}
        value={caption}
        onChange={(event) => setCaption(event.target.value)}
      />
      <p className="text-sm text-muted">
        Encrypted on this computer before it leaves. The server keeps the encrypted file only until
        your contact&apos;s devices have it.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => onClose(false)}>
          Cancel
        </Button>
        <Button disabled={busy || !client || (tooLarge && !image)} onClick={() => void send()}>
          {busy ? 'Preparing…' : 'Send'}
        </Button>
      </div>
    </Dialog>
  );
}
