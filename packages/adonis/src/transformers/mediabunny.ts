import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  ALL_FORMATS,
  CmafOutputFormat,
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
import {
  buildDashManifest,
  type DashRepresentationInput,
  parseMasterPlaylist,
  parseMediaPlaylist,
} from '../hls/to_dash.js';
import type { MediaProbeEngine, MediaProbeSummary } from './probe.js';
import type {
  VideoPackageRequest,
  VideoPackageSummary,
  VideoPackagingEngine,
  WebCodecsProvider,
} from './video.js';

/**
 * The mediabunny-backed engines — the ONLY module in the package that imports the optional
 * `mediabunny` peer, reached lazily through `mediabunny_loader.ts` at first transform.
 *
 * Why mediabunny: pure TypeScript, no ffmpeg binary — a production container without system
 * ffmpeg (the usual case) remuxes fine. The trade-off is that *encoding* rides on WebCodecs,
 * which Node lacks, hence the remux-only default and the {@link WebCodecsProvider} injection
 * seam documented on `transformers.video()`.
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
async function summarize(input: Input): Promise<VideoPackageSummary> {
  const summary: VideoPackageSummary = {};
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

export function createVideoEngine(): VideoPackagingEngine {
  return {
    async package(request: VideoPackageRequest): Promise<VideoPackageSummary> {
      await installWebCodecs(request.webcodecs);
      const input = new Input({
        source: new FilePathSource(request.sourcePath),
        formats: ALL_FORMATS,
      });
      try {
        // THE gotcha: AAC audio with priming (an mp4 edit list) starts at a NEGATIVE timestamp.
        // Mediabunny's default trims the conversion at t=0, which would throw that audio track off
        // the packet-copy fast path — and re-encoding it needs an encoder we may not have.
        // Trimming at the source's real first timestamp keeps every track a pure stream copy; all
        // tracks shift equally (in every pass), so A/V sync is untouched.
        const firstTimestamp = await input.getFirstTimestamp();
        const summary = await summarize(input);
        if (!(await input.getPrimaryVideoTrack())) {
          throw new HlsSourceUnsupportedError(
            'the source has no video stream',
            'Video packaging needs a video track; this file is audio-only or not a video.',
          );
        }
        const hasAudio = Boolean(await input.getPrimaryAudioTrack());

        if (request.segments === 'ts') {
          if (!request.hlsEntry) {
            throw new Error('TS segments only play over HLS: the request needs an `hlsEntry`.');
          }
          // One muxed pass: TS segments carry audio and video together, as HLS players expect.
          await muxHls(request.sourcePath, join(request.outputDir, request.hlsEntry), {
            segmentFormat: new MpegTsOutputFormat(),
            targetDuration: request.targetDuration,
            firstTimestamp,
          });
          return summary;
        }

        // CMAF: one track per playlist — DASH players (dash.js) do not play muxed audio/video,
        // and HLS plays separate renditions just as well. So video and audio are muxed in two
        // passes into their own directories, and the manifests are written over both.
        const tracks: { type: 'video' | 'audio'; base: string }[] = [
          { type: 'video', base: 'video/' },
          ...(hasAudio ? [{ type: 'audio' as const, base: 'audio/' }] : []),
        ];
        const parsed: MuxedTrack[] = [];
        for (const track of tracks) {
          const master = join(request.outputDir, track.base, 'index.m3u8');
          await muxHls(request.sourcePath, master, {
            segmentFormat: new CmafOutputFormat(),
            targetDuration: request.targetDuration,
            firstTimestamp,
            only: track.type,
          });
          const variant = parseMasterPlaylist(await readFile(master, 'utf8'))[0];
          if (!variant) throw new Error(`mediabunny wrote no ${track.type} playlist`);
          const playlist = parseMediaPlaylist(
            await readFile(join(request.outputDir, track.base, variant.uri), 'utf8'),
          );
          // Each pass wrote its own master; the package gets one, written below.
          await rm(master);
          parsed.push({
            type: track.type,
            base: `${track.base}${variant.uri.slice(0, variant.uri.lastIndexOf('/') + 1)}`,
            playlist,
            codecs: variant.codecs,
            bandwidth: variant.bandwidth,
            width: variant.width,
            height: variant.height,
            playlistPath: `${track.base}${variant.uri}`,
          });
        }

        if (request.hlsEntry) {
          await writeFile(join(request.outputDir, request.hlsEntry), hlsMaster(parsed));
        }
        if (request.dashManifest) {
          await writeFile(
            join(request.outputDir, request.dashManifest),
            buildDashManifest({
              durationSeconds:
                summary.durationSeconds ??
                Math.max(
                  ...parsed.map((p) => p.playlist.segments.reduce((t, s) => t + s.duration, 0)),
                ),
              targetDuration: request.targetDuration,
              representations: parsed,
            }),
          );
        }
        if (!request.hlsEntry) {
          // DASH only: the media playlists were scaffolding.
          for (const p of parsed) {
            await rm(join(request.outputDir, p.playlistPath));
          }
        }
        return summary;
      } finally {
        input.dispose();
      }
    },
  };
}

/** One single-track CMAF playlist of the package, as the manifests need it. */
type MuxedTrack = DashRepresentationInput & {
  /** Package-relative path of its media playlist. */
  playlistPath: string;
};

/**
 * One mediabunny HLS mux of the source into `masterPath` (its directory receives every file).
 * `only` keeps a single track type, discarding the other.
 */
async function muxHls(
  sourcePath: string,
  masterPath: string,
  options: {
    segmentFormat: MpegTsOutputFormat | CmafOutputFormat;
    targetDuration: number;
    firstTimestamp: number;
    only?: 'video' | 'audio';
  },
): Promise<void> {
  // mediabunny's file targets do not create directories.
  await mkdir(dirname(masterPath), { recursive: true });
  const input = new Input({ source: new FilePathSource(sourcePath), formats: ALL_FORMATS });
  try {
    const output = new Output({
      format: new HlsOutputFormat({
        segmentFormat: options.segmentFormat,
        targetDuration: options.targetDuration,
      }),
      // The HLS output is many files; each one lands next to the master.
      target: new PathedTarget(masterPath, (target) => new FilePathTarget(target.path)),
    });
    // The package carries ONE video and ONE audio track — the source's primary ones. A second
    // audio language (or a second angle) would otherwise be muxed into files no manifest
    // describes.
    const primaryVideo = (await input.getPrimaryVideoTrack())?.id;
    const primaryAudio = (await input.getPrimaryAudioTrack())?.id;
    const conversion = await Conversion.init({
      input,
      output,
      trim: { start: options.firstTimestamp },
      video: (track) => ({ discard: options.only === 'audio' || track.id !== primaryVideo }),
      audio: (track) => ({ discard: options.only === 'video' || track.id !== primaryAudio }),
    });

    // With no video/audio options, mediabunny copies compatible tracks and re-encodes the rest —
    // but re-encoding needs an encoder, so without WebCodecs an incompatible track is DISCARDED
    // instead. Silently shipping a video without its audio (or vice versa) is not a conversion,
    // it is data loss: fail loudly, with the codec and the reason per track.
    const lost = conversion.discardedTracks.filter((d) => d.reason !== 'discarded_by_user');
    if (lost.length > 0) {
      const reasons = await Promise.all(
        lost.map(async (discarded) => {
          const codec = await discarded.track.getCodec().catch(() => null);
          return `${discarded.track.type}/${codec ?? 'unknown'}: ${discarded.reason}`;
        }),
      );
      throw new HlsSourceUnsupportedError(reasons.join('; '));
    }
    if (!conversion.isValid) {
      throw new HlsSourceUnsupportedError('the file contains no usable track');
    }
    await conversion.execute();
  } finally {
    input.dispose();
  }
}

/** The package's HLS master: the video rendition, with the audio as its `#EXT-X-MEDIA` group. */
function hlsMaster(tracks: MuxedTrack[]): string {
  const video = tracks.find((t) => t.type === 'video')!;
  const audio = tracks.find((t) => t.type === 'audio');
  const codecs = [video.codecs, audio?.codecs].filter(Boolean).join(',');
  const bandwidth = (video.bandwidth ?? 0) + (audio?.bandwidth ?? 0);
  const inf = [
    `BANDWIDTH=${Math.max(1, bandwidth)}`,
    ...(codecs ? [`CODECS="${codecs}"`] : []),
    ...(video.width && video.height ? [`RESOLUTION=${video.width}x${video.height}`] : []),
    ...(audio ? ['AUDIO="audio"'] : []),
  ].join(',');
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    ...(audio
      ? [
          `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT=YES,AUTOSELECT=YES,URI="${audio.playlistPath}"`,
        ]
      : []),
    `#EXT-X-STREAM-INF:${inf}`,
    video.playlistPath,
    '',
  ].join('\n');
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
