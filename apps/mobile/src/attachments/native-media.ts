// The local `PingdostMedia` Expo module (modules/pingdost-media, Kotlin; ADR 0018): video
// metadata, a preview frame and Media3 compression, all on the device before encryption.
import { NativeModule, requireOptionalNativeModule } from 'expo';

export interface VideoInfo {
  durationMs: number;
  /** As shown (rotation applied). */
  width: number;
  height: number;
  /** Bits per second; 0 when unknown. */
  bitrate: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export interface CompressOptions {
  shortSide: number;
  videoBitrate: number;
  audioBitrate: number;
}

type Events = {
  onCompressProgress: (event: { id: string; progress: number }) => void;
};

declare class PingdostMediaModule extends NativeModule<Events> {
  videoInfo(uri: string): Promise<VideoInfo>;
  videoFrame(
    uri: string,
    outputUri: string,
    options: { maxSize: number; quality: number },
  ): Promise<{ width: number; height: number }>;
  compressVideo(
    id: string,
    inputUri: string,
    outputUri: string,
    options: CompressOptions,
  ): Promise<{ size: number }>;
  cancelCompression(id: string): Promise<void>;
}

/** Null where the module is not built: iOS until Phase 28 adds an AVFoundation version. */
export const PingdostMedia = requireOptionalNativeModule<PingdostMediaModule>('PingdostMedia');
