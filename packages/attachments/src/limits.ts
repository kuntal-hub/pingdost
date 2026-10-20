/**
 * The REQ §10.1 size rules, before anything is encrypted:
 * - at most `ATTACHMENT_MAX_BYTES` (100 MB) after optional compression;
 * - only images and videos may be compressed (on by default; the user may opt out when the
 *   original fits); documents are never silently compressed;
 * - an image or video over the limit is sendable only if compression brings it under;
 * - anything else over the limit is refused with a clear reason.
 */
import { DEFAULT_LIMITS } from '@pingdost/config/public';

import type { AttachmentCategory } from './mime';

export type SendCheck =
  /** It fits; `compressible` says whether to offer (default-on) compression. */
  | { result: 'ok'; compressible: boolean }
  /** Over the limit, but compression may bring it under: compress, then check again. */
  | { result: 'needs_compression'; maxBytes: number }
  | {
      result: 'rejected';
      reason: 'too_large' | 'too_large_after_compression' | 'empty';
      maxBytes: number;
    };

export function isCompressible(category: AttachmentCategory): boolean {
  return category === 'image' || category === 'video';
}

export function canSend(
  file: { size: number; category: AttachmentCategory },
  options: { compressedEstimate?: number; maxBytes?: number } = {},
): SendCheck {
  const maxBytes = options.maxBytes ?? DEFAULT_LIMITS.attachmentMaxBytes;
  const compressible = isCompressible(file.category);
  if (file.size <= 0) return { result: 'rejected', reason: 'empty', maxBytes };
  if (file.size <= maxBytes) return { result: 'ok', compressible };
  if (!compressible) return { result: 'rejected', reason: 'too_large', maxBytes };
  if (options.compressedEstimate !== undefined && options.compressedEstimate > maxBytes) {
    return { result: 'rejected', reason: 'too_large_after_compression', maxBytes };
  }
  return { result: 'needs_compression', maxBytes };
}

/** A size as the UI shows it: binary units labelled "MB" (ARCHITECTURE A8). */
export function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
