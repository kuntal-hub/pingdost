/**
 * Compression choices before sending (REQ §10.1, ADR 0018): only images and videos are
 * compressed, on by default; the sender sees the original size and an estimate before
 * anything is encoded. The encoders are per platform (Android: expo-image-manipulator and the
 * Media3 module; web: canvas); these plans and estimates are shared.
 */
import { DEFAULT_LIMITS } from '@pingdost/config/public';

export type ImageQuality = 'standard' | 'hd';

export interface ImagePreset {
  /** Longest side, in pixels. */
  maxDimension: number;
  /** JPEG quality, 0–1. */
  quality: number;
  label: string;
}

export const IMAGE_PRESETS: Record<ImageQuality, ImagePreset> = {
  standard: { maxDimension: 1600, quality: 0.75, label: 'Standard' },
  hd: { maxDimension: 2560, quality: 0.85, label: 'HD' },
};

/** Previews shown before a download: small enough to stage as a thumbnail. */
export const THUMBNAIL_PRESET: ImagePreset = { maxDimension: 480, quality: 0.6, label: 'Preview' };

/** The size an image is scaled to so its longest side fits; never scaled up. */
export function scaledSize(
  width: number,
  height: number,
  maxDimension: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDimension || longest <= 0) return { width, height };
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Compressing an animated GIF would keep only its first frame. */
export function compressByDefault(mimeType: string): boolean {
  return mimeType !== 'image/gif';
}

export interface VideoSource {
  size: number;
  durationMs: number;
  width: number;
  height: number;
}

export interface VideoPlan {
  /** The shorter side of the output (480 = "480p"); the source is never scaled up. */
  height: number;
  videoBitrate: number;
  audioBitrate: number;
  estimatedBytes: number;
  label: string;
}

/** Bitrates (bits/s) by output height, from the best that fits down to the smallest we send. */
const VIDEO_STEPS = [
  { height: 720, videoBitrate: 2_000_000, audioBitrate: 128_000 },
  { height: 480, videoBitrate: 1_000_000, audioBitrate: 96_000 },
  { height: 360, videoBitrate: 500_000, audioBitrate: 64_000 },
] as const;
/** Below this the picture is not worth sending: the video is too long for the limit. */
const MIN_VIDEO_BITRATE = 250_000;
/** MP4 container overhead and encoder overshoot. */
const OVERHEAD = 1.05;

function estimate(durationMs: number, videoBitrate: number, audioBitrate: number): number {
  return Math.ceil((((videoBitrate + audioBitrate) * durationMs) / 8_000) * OVERHEAD);
}

/**
 * The compression for a video: the best step whose estimate fits the limit, else a bitrate cut
 * to fit at the smallest step. Undefined when even that would be unwatchable (the video is too
 * long to send under the limit) or the duration is unknown.
 */
export function planVideo(
  source: VideoSource,
  maxBytes: number = DEFAULT_LIMITS.attachmentMaxBytes,
): VideoPlan | undefined {
  if (source.durationMs <= 0) return undefined;
  const shorter = Math.min(source.width, source.height) || 720;
  for (const step of VIDEO_STEPS) {
    const estimatedBytes = estimate(source.durationMs, step.videoBitrate, step.audioBitrate);
    if (estimatedBytes <= maxBytes * 0.95) {
      const height = Math.min(step.height, shorter);
      return { ...step, height, estimatedBytes, label: `${height}p` };
    }
  }
  const last = VIDEO_STEPS[VIDEO_STEPS.length - 1]!;
  const budget = (maxBytes * 0.95 * 8_000) / (source.durationMs * OVERHEAD);
  const videoBitrate = Math.floor(budget - last.audioBitrate);
  if (videoBitrate < MIN_VIDEO_BITRATE) return undefined;
  const height = Math.min(last.height, shorter);
  return {
    height,
    videoBitrate,
    audioBitrate: last.audioBitrate,
    estimatedBytes: estimate(source.durationMs, videoBitrate, last.audioBitrate),
    label: `${height}p, low quality`,
  };
}

/**
 * Whether compressing would make the video meaningfully smaller: a source already at or below
 * the plan's bitrate and size would only lose quality.
 */
export function videoWorthCompressing(source: VideoSource, plan: VideoPlan): boolean {
  return plan.estimatedBytes < source.size * 0.9;
}
