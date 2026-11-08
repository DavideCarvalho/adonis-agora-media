import {
  ffmpegVideoEngine,
  ffprobeEngine,
  ladders,
  parseBitrate,
  validateLadder,
} from './ffmpeg.js';
import { loadMediabunny, type MediabunnyVideoEngineOptions } from './mediabunny_loader.js';
import { PlaceholderTransformer, type PlaceholderTransformerOptions } from './placeholder.js';
import { MetadataProbeTransformer, type MetadataProbeTransformerOptions } from './probe.js';
import {
  type VideoPackagingEngine,
  VideoTransformer,
  type VideoTransformerOptions,
} from './video.js';

/**
 * The transformer factory namespace used in `config/media.ts` — the {@link Transformer}
 * counterpart of `processors`/`disks`/`stores`:
 *
 * ```ts
 * import { defineConfig, transformers } from '@adonis-agora/media'
 *
 * export default defineConfig({
 *   collections: [
 *     {
 *       name: 'videos',
 *       acceptsMimeTypes: ['video/mp4'],
 *       transformers: [transformers.video(), transformers.probe()],
 *     },
 *   ],
 * })
 * ```
 *
 * Constructing a transformer here never loads its engine — the optional `mediabunny` / `sharp`
 * peers are imported inside the first `transform()` call, so config stays side-effect-free.
 */
export const transformers = {
  /**
   * Video → streaming package: CMAF segments described by an HLS master and a DASH manifest
   * (`formats`), or HLS over TS segments (`segments: 'ts'`). mediabunny by default (pure JS,
   * remux); `engines.ffmpeg()` to transcode. Default name `'video'`.
   */
  video<Name extends string = 'video'>(options: VideoTransformerOptions<Name> = {}) {
    return new VideoTransformer(options);
  },
  /** Metadata-only probe (duration/resolution/codecs) via mediabunny. Default name `'probe'`. */
  probe<Name extends string = 'probe'>(options: MetadataProbeTransformerOptions<Name> = {}) {
    return new MetadataProbeTransformer(options);
  },
  /**
   * Image → inline blurred-preview metadata (tiny WebP `dataUrl`, dimensions, dominant colour) via
   * sharp. Eager by default. Default name `'placeholder'`.
   */
  placeholder<Name extends string = 'placeholder'>(
    options: PlaceholderTransformerOptions<Name> = {},
  ) {
    return new PlaceholderTransformer(options);
  },
};

/**
 * Video packaging via mediabunny: remux by default (the default engine), or — with
 * `@mediabunny/server` — encode `ladder` into renditions without spawning a binary. Validated at
 * config time; mediabunny itself loads at the first transform.
 */
function mediabunnyVideoEngine(options: MediabunnyVideoEngineOptions = {}): VideoPackagingEngine {
  validateLadder(options.ladder);
  if (options.audioBitrate !== undefined) parseBitrate(options.audioBitrate);
  const acceleration = options.hardwareAcceleration;
  if (
    acceleration !== undefined &&
    !['no-preference', 'prefer-hardware', 'prefer-software'].includes(acceleration)
  ) {
    throw new Error(
      `engines.mediabunny(): unknown hardwareAcceleration '${String(acceleration)}' — use ` +
        "'no-preference', 'prefer-hardware' or 'prefer-software'.",
    );
  }
  let engine: VideoPackagingEngine | undefined;
  return {
    async package(request) {
      engine ??= (await loadMediabunny('video')).createVideoEngine(options);
      return engine.package(request);
    },
  };
}

/**
 * Alternative engines for the built-in transformers, plugged in through their `engine` option.
 * The ffmpeg ones spawn the system `ffmpeg` / `ffprobe` binaries (nothing bundled, nothing to
 * install from npm) and can **transcode** — an adaptive-bitrate ladder instead of a single stream
 * copy. `engines.mediabunny({ ladder })` transcodes too, without a binary, through the optional
 * peer `@mediabunny/server`:
 *
 * ```ts
 * transformers.video({ engine: engines.ffmpeg({ ladder: engines.ladders.standard }) })
 * transformers.probe({ engine: engines.ffprobe() })
 * ```
 */
export const engines = {
  /** Video packaging via system ffmpeg: remux by default, or encode `ladder` into renditions. */
  ffmpeg: ffmpegVideoEngine,
  /** Video packaging via mediabunny: remux, or a `ladder` with `@mediabunny/server`. */
  mediabunny: mediabunnyVideoEngine,
  /** Metadata probe via system ffprobe. */
  ffprobe: ffprobeEngine,
  /** Ready-made ladders for {@link ffmpegVideoEngine}: `standard` (360/720/1080p), `compact` (360/720p). */
  ladders,
};
