// Sending a file (REQ §10.1–10.2, ADR 0018): a picked file becomes a draft (its type from its
// bytes, its size rules and compression plan); sending it compresses when chosen, makes the
// preview, encrypts both into the vault, stores the message held, and queues the upload. The
// plaintext copies the app made (picker copies, compression output) are deleted afterwards.
import { File } from 'expo-file-system';

import { meshRecipients, sendMeshRows } from '@/nearby/files';
import { useNearby } from '@/nearby/service';
import {
  asRecordedAudio,
  buildManifest,
  canSend,
  formatSize,
  IMAGE_PRESETS,
  SNIFF_BYTES,
  sniffMime,
  THUMBNAIL_MAX_BYTES,
  type ImageQuality,
  type MediaDetails,
  type SniffedType,
} from '@pingdost/attachments';
import { DEFAULT_LIMITS } from '@pingdost/config/public';
import type { MessageRecord } from '@pingdost/message-engine';

import { attachmentContext } from './context';
import { readHead, removeFile } from './files';
import {
  compressImage,
  compressVideo,
  imageThumbnail,
  videoInfo,
  videoThumbnail,
  videoToolsAvailable,
  type ImageOutput,
} from './media';
import { encryptToVault, type VaultEntry } from './pipeline';
import type { AttachmentRow } from './repo';
import { planDraft, type DraftPlan } from './rules';
import { kick } from './transfers';

export interface Draft {
  uri: string;
  /** Shown for documents and sent as their file name; never for photos, videos or voice. */
  name: string | undefined;
  size: number;
  sniffed: SniffedType;
  width: number | undefined;
  height: number | undefined;
  durationMs: number | undefined;
  /** A voice note recorded in the app. */
  voice: { waveform: Uint8Array } | undefined;
  /** The app made this copy (picker cache, recorder): delete it when done. */
  temporary: boolean;
  plan: DraftPlan;
}

export class SendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendError';
  }
}

/** Reads a picked file's type from its bytes and works out how it may be sent. */
export async function makeDraft(input: {
  uri: string;
  name?: string | null;
  width?: number;
  height?: number;
  durationMs?: number | null;
  voice?: { waveform: Uint8Array; durationMs: number };
  temporary: boolean;
}): Promise<Draft> {
  const file = new File(input.uri);
  if (!file.exists) throw new SendError('The file could not be read.');
  const size = file.size;
  let sniffed = sniffMime(await readHead(file, SNIFF_BYTES));
  if (input.voice) sniffed = asRecordedAudio(sniffed);
  let { width, height } = input;
  let durationMs = input.voice?.durationMs ?? input.durationMs ?? undefined;
  if (sniffed.category === 'video') {
    const info = await videoInfo(input.uri).catch(() => undefined);
    if (info) {
      width = info.width || width;
      height = info.height || height;
      durationMs = info.durationMs || durationMs;
    }
  }
  const plan = planDraft(
    {
      category: sniffed.category,
      mimeType: sniffed.mimeType,
      size,
      ...(durationMs ? { durationMs } : {}),
      ...(width ? { width } : {}),
      ...(height ? { height } : {}),
    },
    undefined,
    { videoCompression: videoToolsAvailable },
  );
  return {
    uri: input.uri,
    name: input.name ?? undefined,
    size,
    sniffed,
    width,
    height,
    durationMs,
    voice: input.voice ? { waveform: input.voice.waveform } : undefined,
    temporary: input.temporary,
    plan,
  };
}

/** Deletes the app's own plaintext copy of a draft that is not sent. */
export function discardDraft(draft: Draft): void {
  if (draft.temporary) removeFile(draft.uri);
}

export interface SendChoice {
  compress: boolean;
  imageQuality: ImageQuality;
  caption: string;
  replyTo?: string;
}

export type SendStage =
  { stage: 'compressing'; percent: number | undefined } | { stage: 'encrypting' };

export interface SendJob {
  result: Promise<MessageRecord>;
  /** Stops a compression in progress. */
  cancel: () => void;
}

export function sendDraft(
  conversationId: string,
  draft: Draft,
  choice: SendChoice,
  onStage: (stage: SendStage) => void,
): SendJob {
  let cancelled = false;
  let cancelVideo: (() => void) | undefined;
  const result = (async () => {
    const { engine, provider, repo } = attachmentContext();
    const made: File[] = [];
    const vault: VaultEntry[] = [];
    try {
      const category = draft.sniffed.category;
      let final = new File(draft.uri);
      let mimeType = draft.sniffed.mimeType;
      let media: Partial<MediaDetails> = {
        ...(draft.width ? { width: draft.width } : {}),
        ...(draft.height ? { height: draft.height } : {}),
        ...(draft.durationMs ? { durationMs: draft.durationMs } : {}),
        ...(draft.voice ? { waveform: draft.voice.waveform } : {}),
      };

      if (choice.compress && category === 'image') {
        onStage({ stage: 'compressing', percent: undefined });
        const out = await compressImage(draft.uri, IMAGE_PRESETS[choice.imageQuality]);
        made.push(out.file);
        final = out.file;
        mimeType = 'image/jpeg';
        media = { width: out.width, height: out.height };
      } else if (choice.compress && category === 'video' && draft.plan.video) {
        onStage({ stage: 'compressing', percent: 0 });
        const job = compressVideo(draft.uri, draft.plan.video, (percent) =>
          onStage({ stage: 'compressing', percent }),
        );
        cancelVideo = job.cancel;
        final = await job.result;
        made.push(final);
        mimeType = 'video/mp4';
        const info = await videoInfo(final.uri).catch(() => undefined);
        media = {
          ...(info?.width ? { width: info.width } : {}),
          ...(info?.height ? { height: info.height } : {}),
          ...(info?.durationMs || draft.durationMs
            ? { durationMs: info?.durationMs || draft.durationMs }
            : {}),
        };
      }
      if (cancelled) throw new SendError('Cancelled.');

      const check = canSend({ size: final.size, category: 'document' });
      if (check.result !== 'ok') {
        throw new SendError(
          `Even compressed, this is ${formatSize(final.size)}, over the ${formatSize(DEFAULT_LIMITS.attachmentMaxBytes)} limit. It can't be sent.`,
        );
      }

      // The preview, made here before encryption (REQ §10.2); a failed one is just left out.
      let preview: ImageOutput | undefined;
      try {
        if (category === 'image') preview = await imageThumbnail(final.uri);
        else if (category === 'video') preview = await videoThumbnail(final.uri);
      } catch {
        preview = undefined;
      }
      if (preview) {
        made.push(preview.file);
        if (preview.file.size > THUMBNAIL_MAX_BYTES) preview = undefined;
      }
      if (cancelled) throw new SendError('Cancelled.');

      onStage({ stage: 'encrypting' });
      const thumb = preview ? await encryptToVault(provider, preview.file) : undefined;
      if (thumb) vault.push(thumb);
      const main = await encryptToVault(provider, final);
      vault.push(main);
      const isDocument = category === 'document' || (category === 'audio' && !draft.voice);
      // No Internet and the contact reachable over nearby: the file goes over the mesh, with no
      // staged upload (ADR 0027).
      const meshDevices = await meshRecipients(
        conversationId,
        main.encrypted.ciphertextSize,
        useNearby.getState().fileMaxMb * 1_048_576,
      ).catch(() => null);
      const mesh = meshDevices !== null;
      const manifest = buildManifest({
        mesh,
        attachmentId: main.attachmentId,
        encrypted: main.encrypted,
        mimeType,
        ...(isDocument && draft.name ? { fileName: draft.name } : {}),
        ...(thumb && preview
          ? {
              thumbnail: buildManifest({
                attachmentId: thumb.attachmentId,
                encrypted: thumb.encrypted,
                mimeType: 'image/jpeg',
                media: { width: preview.width, height: preview.height },
                mesh,
              }),
            }
          : {}),
        ...(choice.caption.trim() ? { caption: choice.caption.trim() } : {}),
        media,
      });
      if (cancelled) throw new SendError('Cancelled.');

      const message = await engine.sendAttachment(conversationId, manifest, {
        // Staged uploads hold the message until the file is on the server; the mesh does not.
        held: !mesh,
        ...(choice.replyTo ? { replyTo: choice.replyTo } : {}),
      });
      const now = Date.now();
      const row = (entry: VaultEntry, role: AttachmentRow['role']): AttachmentRow => ({
        attachmentId: entry.attachmentId,
        messageId: message.messageId,
        conversationId,
        role,
        direction: 'up',
        state: 'transferring',
        ciphertextSize: entry.encrypted.ciphertextSize,
        transferred: 0,
        localPath: entry.attachmentId,
        error: null,
        recipients: meshDevices,
        createdAt: now,
        updatedAt: now,
        via: mesh ? 'mesh' : null,
      });
      const rows = [row(main, 'file'), ...(thumb ? [row(thumb, 'thumbnail')] : [])];
      await repo.insert(rows);
      if (mesh) await sendMeshRows(rows);
      vault.length = 0; // kept: the rows point at them now
      discardDraft(draft);
      void kick();
      return message;
    } finally {
      for (const file of made) removeFile(file);
      for (const entry of vault) removeFile(entry.file);
    }
  })();
  return {
    result,
    cancel: () => {
      cancelled = true;
      cancelVideo?.();
    },
  };
}
