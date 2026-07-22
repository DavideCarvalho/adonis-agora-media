import { join } from 'node:path';
import {
  ALL_FORMATS,
  Conversion,
  FilePathSource,
  FilePathTarget,
  HlsOutputFormat,
  Input,
  MpegTsOutputFormat,
  Output,
  PathedTarget,
} from 'mediabunny';
import { HlsSourceUnsupportedError } from '../errors.js';
import type { HlsRemuxEngine, HlsRemuxRequest, HlsRemuxSummary, WebCodecsProvider } from './hls.js';
import type { MediaProbeEngine, MediaProbeSummary } from './probe.js';

/**
 * The mediabunny-backed engines — the ONLY module in the package that imports the optional
 * `mediabunny` peer, reached lazily through `mediabunny_loader.ts` at first transform.
 *
 * Why mediabunny: pure TypeScript, no ffmpeg binary — a production container without system
 * ffmpeg (the usual case) remuxes fine. The trade-off is that *encoding* rides on WebCodecs,
 * which Node lacks, hence the remux-only default and the {@link WebCodecsProvider} injection
 * seam documented on `HlsTransformer`.
 */

/** The WebCodecs API surface mediabunny reads from `globalThis`. */
const WEBCODECS_GLOBALS = [
  'VideoEncoder',
  'VideoDecoder',
  'AudioEncoder',
  'AudioDecoder',
  'VideoFrame',
  'AudioData',
  'EncodedVideoChunk',
  'EncodedAudioChunk',
] as const;

/**
 * Install an injected WebCodecs implementation onto `globalThis` — only the classes that are
 * missing; a native implementation is never overwritten. Global mutation is deliberate and
 * additive: `globalThis` is where the WebCodecs spec (and therefore mediabunny) looks the API up,
 * so "injecting an implementation" and "installing it globally" are the same thing. Installing
 * per-conversion and uninstalling after would race concurrent transforms for zero benefit.
 */
async function installWebCodecs(provider: WebCodecsProvider | undefined): Promise<void> {
  if (!provider) return;
  const implementation = await provider();
  const globals = globalThis as Record<string, unknown>;
  for (const name of WEBCODECS_GLOBALS) {
    if (globals[name] === undefined && implementation[name] !== undefined) {
      globals[name] = implementation[name];
    }
  }
}

/** Best-effort technical summary of an input — never fails the transform over metadata. */
async function summarize(input: Input): Promise<HlsRemuxSummary> {
  const summary: HlsRemuxSummary = {};
  try {
    summary.durationSeconds = await input.computeDuration();
    const video = await input.getPrimaryVideoTrack();
    if (video) {
      summary.width = await video.getDisplayWidth();
      summary.height = await video.getDisplayHeight();
      summary.videoCodec = await video.getCodec();
    }
    const audio = await input.getPrimaryAudioTrack();
    if (audio) {
      summary.audioCodec = await audio.getCodec();
    }
  } catch {
    // metadata is a bonus; the artifacts are the product
  }
  return summary;
}

export function createHlsEngine(): HlsRemuxEngine {
  return {
    async remux(request: HlsRemuxRequest): Promise<HlsRemuxSummary> {
      await installWebCodecs(request.webcodecs);

      const input = new Input({
        source: new FilePathSource(request.sourcePath),
        formats: ALL_FORMATS,
      });

      try {
        const output = new Output({
          format: new HlsOutputFormat({
            segmentFormat: new MpegTsOutputFormat(),
            targetDuration: request.targetDuration,
          }),
          // The HLS output is many files; each one lands in the local output directory.
          target: new PathedTarget(
            join(request.outputDir, request.entryName),
            (target) => new FilePathTarget(target.path),
          ),
        });

        // THE gotcha: AAC audio with priming (an mp4 edit list) starts at a NEGATIVE timestamp.
        // Mediabunny's default trims the conversion at t=0, which would throw that audio track off
        // the packet-copy fast path — and re-encoding it needs an encoder we may not have.
        // Trimming at the source's real first timestamp keeps every track a pure stream copy; all
        // tracks shift equally, so A/V sync is untouched.
        const firstTimestamp = await input.getFirstTimestamp();

        const conversion = await Conversion.init({
          input,
          output,
          trim: { start: firstTimestamp },
        });

        // With no video/audio options, mediabunny copies compatible tracks and re-encodes the
        // rest — but re-encoding needs an encoder, so without WebCodecs an incompatible track is
        // DISCARDED instead. Silently shipping a video without its audio (or vice versa) is not a
        // conversion, it is data loss: fail loudly, with the codec and the reason per track.
        if (conversion.discardedTracks.length > 0) {
          const reasons = await Promise.all(
            conversion.discardedTracks.map(async (discarded) => {
              const codec = await discarded.track.getCodec().catch(() => null);
              return `${discarded.track.type}/${codec ?? 'unknown'}: ${discarded.reason}`;
            }),
          );
          throw new HlsSourceUnsupportedError(reasons.join('; '));
        }

        if (!conversion.isValid) {
          throw new HlsSourceUnsupportedError('the file contains no usable track');
        }

        const summary = await summarize(input);
        await conversion.execute();
        return summary;
      } finally {
        input.dispose();
      }
    },
  };
}

export function createProbeEngine(): MediaProbeEngine {
  return {
    async probe(sourcePath: string): Promise<MediaProbeSummary> {
      const input = new Input({ source: new FilePathSource(sourcePath), formats: ALL_FORMATS });
      try {
        const format = await input.getFormat();
        const summary: MediaProbeSummary = {
          format: format.name,
          mimeType: await input.getMimeType(),
          durationSeconds: await input.computeDuration(),
          hasVideo: false,
          hasAudio: false,
        };
        const video = await input.getPrimaryVideoTrack();
        if (video) {
          summary.hasVideo = true;
          summary.width = await video.getDisplayWidth();
          summary.height = await video.getDisplayHeight();
          summary.videoCodec = await video.getCodec();
        }
        const audio = await input.getPrimaryAudioTrack();
        if (audio) {
          summary.hasAudio = true;
          summary.audioCodec = await audio.getCodec();
          summary.audioSampleRate = await audio.getSampleRate();
          summary.audioChannels = await audio.getNumberOfChannels();
        }
        return summary;
      } finally {
        input.dispose();
      }
    },
  };
}
