// Media work in the browser before encryption (REQ §10.1–10.2, ADR 0021): images are scaled and
// re-encoded as JPEG on a canvas; previews (480 px JPEG) come from an image or a video frame;
// sizes and durations are read from the file. There is no video compression on the web in v1.
import {
  scaledSize,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_PRESET,
  type ImagePreset,
} from '@pingdost/attachments';

export interface EncodedImage {
  blob: Blob;
  width: number;
  height: number;
}

function canvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const element = document.createElement('canvas');
  element.width = width;
  element.height = height;
  return element;
}

async function toJpeg(target: OffscreenCanvas | HTMLCanvasElement, quality: number): Promise<Blob> {
  if ('convertToBlob' in target) return target.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise((resolve, reject) =>
    target.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('the image could not be encoded'))),
      'image/jpeg',
      quality,
    ),
  );
}

/** Draws `source` scaled to fit `preset`, on white (JPEG has no transparency). */
async function encode(
  source: CanvasImageSource,
  width: number,
  height: number,
  preset: ImagePreset,
): Promise<EncodedImage> {
  const size = scaledSize(width, height, preset.maxDimension);
  const target = canvas(size.width, size.height);
  const context = target.getContext('2d') as
    CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!context) throw new Error('no canvas in this browser');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(source, 0, 0, size.width, size.height);
  return { blob: await toJpeg(target, preset.quality), ...size };
}

/** The image's size, honouring its EXIF orientation. */
export async function imageSize(file: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}

export async function compressImage(file: Blob, preset: ImagePreset): Promise<EncodedImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    return await encode(bitmap, bitmap.width, bitmap.height, preset);
  } finally {
    bitmap.close();
  }
}

/** A small preview, or undefined when it cannot be made or is too large to stage. */
export async function imageThumbnail(file: Blob): Promise<EncodedImage | undefined> {
  try {
    const preview = await compressImage(file, THUMBNAIL_PRESET);
    return preview.blob.size <= THUMBNAIL_MAX_BYTES ? preview : undefined;
  } catch {
    return undefined;
  }
}

export interface MediaInfo {
  width: number;
  height: number;
  durationMs: number;
  /** Videos: a preview from an early frame. */
  thumbnail: EncodedImage | undefined;
}

/** Reads a video's or an audio file's size and length (and a video frame), best effort. */
export async function mediaInfo(file: Blob, kind: 'video' | 'audio'): Promise<MediaInfo> {
  const url = URL.createObjectURL(file);
  const element = document.createElement(kind);
  element.preload = 'metadata';
  element.muted = true;
  const none: MediaInfo = { width: 0, height: 0, durationMs: 0, thumbnail: undefined };
  try {
    await new Promise<void>((resolve, reject) => {
      element.onloadedmetadata = () => resolve();
      element.onerror = () => reject(new Error('unreadable media'));
      element.src = url;
    });
    const durationMs = Number.isFinite(element.duration) ? Math.round(element.duration * 1_000) : 0;
    if (!(element instanceof HTMLVideoElement)) return { ...none, durationMs };
    const width = element.videoWidth;
    const height = element.videoHeight;
    let thumbnail: EncodedImage | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        element.onseeked = () => resolve();
        element.onerror = () => reject(new Error('unreadable frame'));
        element.currentTime = Math.min(0.1, element.duration || 0);
      });
      const preview = await encode(element, width, height, THUMBNAIL_PRESET);
      if (preview.blob.size <= THUMBNAIL_MAX_BYTES) thumbnail = preview;
    } catch {
      thumbnail = undefined;
    }
    return { width, height, durationMs, thumbnail };
  } catch {
    return none;
  } finally {
    element.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
}
