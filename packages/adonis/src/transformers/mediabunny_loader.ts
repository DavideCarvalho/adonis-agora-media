import { TransformerRuntimeMissingError } from '../errors.js';
import type { FfmpegRendition } from './ffmpeg.js';
import type { MediaProbeEngine } from './probe.js';
import type { VideoPackagingEngine } from './video.js';

/**
 * What `@mediabunny/server` exports that the engine calls: registering it gives mediabunny the
 * decoders and encoders (h264, hevc, vp9, av1, aac, opus…) Node lacks, through NodeAV — FFmpeg's
 * C libraries as a native module. Its prebuilt binary needs glibc: Debian/Ubuntu images, not
 * Alpine.
 */
export interface MediabunnyServerModule {
  registerMediabunnyServer(options?: Record<string, unknown>): void;
}

export interface MediabunnyVideoEngineOptions {
  /**
   * Renditions to encode, the same shape as `engines.ffmpeg({ ladder })`. Omit to **remux** (the
   * default engine's contract). With a ladder, every rung is encoded to h264 from one decode of
   * the video (the audio to aac, in its own pass) and listed in both manifests. Rungs taller than the
   * source are dropped (never upscale). Encoding needs `@mediabunny/server`. CMAF segments only.
   */
  ladder?: FfmpegRendition[];
  /** AAC bitrate of the shared audio track. Default: the ladder's highest, else `'128k'`. */
  audioBitrate?: string;
  /**
   * Supplies `@mediabunny/server` (registered once per process). Default: import it by name — an
   * optional peer; a missing one throws `TransformerRuntimeMissingError` at the first transform.
   */
  server?: () => Promise<MediabunnyServerModule>;
  /** Encoder preference passed to mediabunny. Default `'no-preference'` (hardware when present). */
  hardwareAcceleration?: 'no-preference' | 'prefer-hardware' | 'prefer-software';
}

/** The engine factories `./mediabunny.js` exports (the only module that imports the peer). */
export interface MediabunnyEngineModule {
  createVideoEngine(options?: MediabunnyVideoEngineOptions): VideoPackagingEngine;
  createProbeEngine(): MediaProbeEngine;
}

/**
 * Load the mediabunny-backed engine module, translating a missing optional peer into the typed
 * {@link TransformerRuntimeMissingError} instead of a raw `ERR_MODULE_NOT_FOUND` five imports deep.
 * Import happens here — at first transform — never at boot: configuring a transformer must not
 * load its engine (the same laziness `processors.sharp()` and `disks.s3()` follow).
 */
export async function loadMediabunny(transformerName: string): Promise<MediabunnyEngineModule> {
  try {
    return await import('./mediabunny.js');
  } catch (error) {
    if (
      (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' &&
      error instanceof Error &&
      error.message.includes('mediabunny')
    ) {
      throw new TransformerRuntimeMissingError(
        transformerName,
        "the optional peer dependency 'mediabunny'",
        'Install it (`pnpm add mediabunny`) or inject a custom `engine`.',
      );
    }
    throw error;
  }
}
