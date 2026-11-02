// The decisions behind sending and fetching attachments (REQ §10.1, §14.3; ADR 0018), kept
// free of native modules so they are unit-tested: what may be sent and how, when a file is
// fetched on its own, how errors read, and a voice note's waveform.
import {
  canSend,
  compressByDefault,
  formatSize,
  planVideo,
  videoWorthCompressing,
  WAVEFORM_MAX,
  type AttachmentCategory,
  type VideoPlan,
} from '@pingdost/attachments';
import { DEFAULT_LIMITS } from '@pingdost/config/public';

import type { TransferError, TransferRole } from './repo';

/** Settings → Storage: when full files download without a tap. Previews always do. */
export type AutoDownload = 'wifi' | 'always' | 'never';
export const DEFAULT_AUTO_DOWNLOAD: AutoDownload = 'wifi';

export type NetworkKind = 'wifi' | 'cellular' | 'other' | 'offline';

export function autoFetch(role: TransferRole, policy: AutoDownload, network: NetworkKind): boolean {
  if (network === 'offline') return false;
  if (role === 'thumbnail') return true;
  if (policy === 'always') return true;
  return policy === 'wifi' && network === 'wifi';
}

/** What is known about a picked file before anything is encoded. */
export interface DraftFacts {
  category: AttachmentCategory;
  mimeType: string;
  size: number;
  durationMs?: number;
  width?: number;
  height?: number;
}

export interface DraftPlan {
  /** Images and videos only. */
  compressible: boolean;
  /** The toggle's starting position. */
  compressByDefault: boolean;
  /** "Send original" is offered only when the original fits the limit. */
  originalAllowed: boolean;
  /** Videos: the encoder settings and the estimate shown. */
  video?: VideoPlan;
  /** Why it cannot be sent at all; shown instead of the Send button. */
  rejected?: string;
}

/**
 * The send options for a picked file (REQ §10.1). `videoCompression` is false where the
 * platform has no video encoder yet (iOS until Phase 28 adds one): videos are then sent as
 * they are, if they fit.
 */
export function planDraft(
  facts: DraftFacts,
  maxBytes: number = DEFAULT_LIMITS.attachmentMaxBytes,
  options: { videoCompression?: boolean } = {},
): DraftPlan {
  const limit = formatSize(maxBytes);
  const check = canSend(facts, { maxBytes });
  if (check.result === 'rejected') {
    return {
      compressible: false,
      compressByDefault: false,
      originalAllowed: false,
      rejected:
        check.reason === 'empty'
          ? 'This file is empty.'
          : `This file is ${formatSize(facts.size)}. Files over ${limit} can't be sent, and only photos and videos can be made smaller.`,
    };
  }
  const fits = check.result === 'ok';
  if (facts.category === 'image') {
    return {
      compressible: true,
      compressByDefault: !fits || compressByDefault(facts.mimeType),
      originalAllowed: fits,
    };
  }
  if (facts.category === 'video' && options.videoCompression === false) {
    return {
      compressible: false,
      compressByDefault: false,
      originalAllowed: fits,
      ...(fits
        ? {}
        : {
            rejected: `This video is ${formatSize(facts.size)}. Videos over ${limit} can't be made smaller on this device yet.`,
          }),
    };
  }
  if (facts.category === 'video') {
    const video = planVideo(
      {
        size: facts.size,
        durationMs: facts.durationMs ?? 0,
        width: facts.width ?? 0,
        height: facts.height ?? 0,
      },
      maxBytes,
    );
    if (!video) {
      return {
        compressible: false,
        compressByDefault: false,
        originalAllowed: fits,
        ...(fits
          ? {}
          : {
              rejected: `This video is ${formatSize(facts.size)} and too long to fit in ${limit}, even compressed. Trim it and send a shorter part.`,
            }),
      };
    }
    const worth = videoWorthCompressing(
      { size: facts.size, durationMs: facts.durationMs ?? 0, width: 0, height: 0 },
      video,
    );
    return {
      compressible: worth || !fits,
      compressByDefault: !fits || worth,
      originalAllowed: fits,
      video,
    };
  }
  return { compressible: false, compressByDefault: false, originalAllowed: true };
}

/** The status line for a failed or waiting transfer. */
export function transferErrorText(error: TransferError | null, direction: 'up' | 'down'): string {
  switch (error) {
    case 'network':
      return 'Waiting for a connection';
    case 'too_large':
      return 'Too large to send (over 100 MB)';
    case 'quota':
      return 'You have 1 GB waiting to be delivered. Space frees up as files are downloaded or expire.';
    case 'staging_full':
      return 'The server has no room right now. Try again later.';
    case 'integrity':
      return direction === 'down'
        ? "The file didn't arrive intact. Tap to try again."
        : 'Upload failed. Tap to try again.';
    case 'not_allowed':
      return 'Not available on this device';
    case 'ack':
      return '';
    case 'error':
    case null:
      return direction === 'down'
        ? 'Download failed. Tap to try again.'
        : 'Upload failed. Tap to try again.';
  }
}

/** Server error codes as transfer errors. */
export function transferErrorFor(code: string | undefined): TransferError {
  switch (code) {
    case 'ATTACHMENT_TOO_LARGE':
      return 'too_large';
    case 'ATTACHMENT_QUOTA_EXCEEDED':
      return 'quota';
    case 'ATTACHMENT_STAGING_FULL':
      return 'staging_full';
    case 'FORBIDDEN':
    case 'NOT_A_MEMBER':
      return 'not_allowed';
    case 'UNAVAILABLE':
    case 'network':
      return 'network';
    case 'integrity':
    case 'invalid':
      return 'integrity';
    default:
      return 'error';
  }
}

/** Metering levels (dBFS, about −60…0) as up to 64 loudness samples, 0–255. */
export function waveformFrom(
  levels: readonly number[],
  buckets: number = WAVEFORM_MAX,
): Uint8Array {
  if (levels.length === 0) return new Uint8Array(0);
  const count = Math.min(buckets, levels.length);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * levels.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / count));
    let peak = -Infinity;
    for (let j = from; j < to; j++) peak = Math.max(peak, levels[j] ?? -160);
    const scaled = ((Math.max(-50, Math.min(0, peak)) + 50) / 50) * 255;
    out[i] = Math.round(scaled);
  }
  return out;
}

/** "0:42", "12:05". */
export function durationLabel(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1_000));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}
