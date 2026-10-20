// Making media smaller on the phone, before encryption (REQ §10.1–10.2, ADR 0018): images with
// expo-image-manipulator (decoded downsampled, saved as JPEG, which also drops EXIF data such as
// location), videos with the Media3 module, and previews of both. Outputs go to the work folder.
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import {
  scaledSize,
  THUMBNAIL_PRESET,
  type ImagePreset,
  type VideoPlan,
} from '@pingdost/attachments';
import { uuidv7 } from '@pingdost/protocol';

import { workFile } from './files';
import { PingdostMedia, type VideoInfo } from './native-media';

export interface ImageOutput {
  file: File;
  width: number;
  height: number;
}

/** Re-encodes an image to fit a preset (never scaled up). */
export async function compressImage(uri: string, preset: ImagePreset): Promise<ImageOutput> {
  const loaded = await ImageManipulator.manipulate(uri, {
    maxWidth: preset.maxDimension,
    maxHeight: preset.maxDimension,
  }).renderAsync();
  const target = scaledSize(loaded.width, loaded.height, preset.maxDimension);
  const image =
    target.width < loaded.width
      ? await ImageManipulator.manipulate(loaded).resize({ width: target.width }).renderAsync()
      : loaded;
  const saved = await image.saveAsync({ compress: preset.quality, format: SaveFormat.JPEG });
  const file = workFile(`${uuidv7()}.jpg`);
  await new File(saved.uri).move(file);
  return { file, width: saved.width, height: saved.height };
}

/** A small JPEG preview of an image. */
export function imageThumbnail(uri: string): Promise<ImageOutput> {
  return compressImage(uri, THUMBNAIL_PRESET);
}

export function videoInfo(uri: string): Promise<VideoInfo> {
  return PingdostMedia.videoInfo(uri);
}

/** A JPEG of the video's first frame, preview-sized. */
export async function videoThumbnail(uri: string): Promise<ImageOutput> {
  const file = workFile(`${uuidv7()}.jpg`);
  const { width, height } = await PingdostMedia.videoFrame(uri, file.uri, {
    maxSize: THUMBNAIL_PRESET.maxDimension,
    quality: Math.round(THUMBNAIL_PRESET.quality * 100),
  });
  return { file, width, height };
}

export interface VideoJob {
  result: Promise<File>;
  cancel: () => void;
}

/** Re-encodes a video to the plan (H.264/AAC MP4); `onProgress` gets 0–100. */
export function compressVideo(
  uri: string,
  plan: VideoPlan,
  onProgress: (percent: number) => void,
): VideoJob {
  const id = uuidv7();
  const file = workFile(`${id}.mp4`);
  const subscription = PingdostMedia.addListener('onCompressProgress', (event) => {
    if (event.id === id) onProgress(event.progress);
  });
  const result = PingdostMedia.compressVideo(id, uri, file.uri, {
    shortSide: plan.height,
    videoBitrate: plan.videoBitrate,
    audioBitrate: plan.audioBitrate,
  })
    .then(() => file)
    .finally(() => subscription.remove());
  return { result, cancel: () => void PingdostMedia.cancelCompression(id).catch(() => undefined) };
}
