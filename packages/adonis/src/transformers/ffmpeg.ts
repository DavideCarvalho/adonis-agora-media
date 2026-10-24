import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FfmpegFailedError,
  HlsSourceUnsupportedError,
  TransformerRuntimeMissingError,
} from '../errors.js';
import type { MediaProbeEngine, MediaProbeSummary } from './probe.js';
import type { VideoPackageRequest, VideoPackageSummary, VideoPackagingEngine } from './video.js';

/**
 * Engines backed by the system `ffmpeg` / `ffprobe` binaries — the alternative to the default
 * mediabunny engines for hosts that have ffmpeg installed. What ffmpeg buys over mediabunny is
 * **encoding**: mediabunny can only stream-copy in Node (no WebCodecs), while ffmpeg can transcode
 * any source it decodes into an adaptive-bitrate ladder.
 *
 * Plug them into the existing transformers through their `engine` seam:
 *
 * ```ts
 * import { engines, transformers } from '@adonis-agora/media'
 *
 * transformers: [
 *   transformers.video({ engine: engines.ffmpeg({ ladder: engines.ladders.standard }) }),
 *   transformers.probe({ engine: engines.ffprobe() }),
 * ]
 * ```
 *
 * No npm dependency: the binaries are spawned, never bundled. A missing binary surfaces as
 * {@link TransformerRuntimeMissingError}; a failing run as {@link FfmpegFailedError} carrying the
 * tail of ffmpeg's stderr.
 */

/** One rung of an adaptive-bitrate ladder. */
export interface FfmpegRendition {
  /** Output height in px; the width follows the source aspect ratio (rounded to even). */
  height: number;
  /** Target video bitrate, ffmpeg syntax (`'2800k'`, `'5M'`). Caps peak rate at 1.5× this. */
  videoBitrate: string;
  /** Audio bitrate, ffmpeg syntax. Default `'128k'`. */
  audioBitrate?: string;
}

export interface FfmpegBinaryOptions {
  /** Path or name of the `ffmpeg` binary. Default `'ffmpeg'` (resolved on `PATH`). */
  ffmpegPath?: string;
  /** Path or name of the `ffprobe` binary. Default `'ffprobe'` (resolved on `PATH`). */
  ffprobePath?: string;
}

export interface FfmpegVideoEngineOptions extends FfmpegBinaryOptions {
  /**
   * Renditions to encode. Omit to **remux** (stream copy, no re-encode — fast; TS segments need an
   * h264/aac source, CMAF carries h264, hevc, vp9 or av1 alike). With a ladder, every rung is
   * transcoded to h264/aac and listed in the manifests. Rungs taller than the source are dropped
   * (never upscale); if every rung is taller, the smallest one is kept at the source height.
   */
  ladder?: FfmpegRendition[];
  /**
   * AAC bitrate of the shared audio track of a CMAF ladder (TS renditions each carry their rung's
   * `audioBitrate`). Default: the ladder's highest, else `'128k'`.
   */
  audioBitrate?: string;
  /** x264 preset when transcoding. Default `'veryfast'`. */
  preset?: string;
  /** Extra ffmpeg arguments, inserted right before the muxer options. */
  extraArgs?: string[];
}

/** The rendition name ffmpeg's `%v` expands to; playlist `playlist-0.m3u8`, segments `segment-0-3.ts`. */
const PLAYLIST_PATTERN = 'playlist-%v.m3u8';
const SEGMENT_PATTERN = 'segment-%v-%d.ts';

/** Ready-made ladders. */
export const ladders = {
  /** 360p / 720p / 1080p — a sane default for course videos. */
  standard: [
    { height: 360, videoBitrate: '800k', audioBitrate: '96k' },
    { height: 720, videoBitrate: '2800k' },
    { height: 1080, videoBitrate: '5000k' },
  ],
  /** 360p / 720p — lighter on storage and encode time. */
  compact: [
    { height: 360, videoBitrate: '800k', audioBitrate: '96k' },
    { height: 720, videoBitrate: '2800k' },
  ],
} satisfies Record<string, FfmpegRendition[]>;

/** Run a binary to completion, collecting stdout and the tail of stderr. */
function run(
  binary: string,
  args: string[],
  transformerName: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      // ffmpeg is chatty on stderr; only the end explains a failure.
      err = (err + chunk.toString()).slice(-4000);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        reject(
          new TransformerRuntimeMissingError(
            transformerName,
            `the '${binary}' binary`,
            'Install ffmpeg on the host (e.g. `apt-get install ffmpeg`, `apk add ffmpeg`) or point `ffmpegPath`/`ffprobePath` at it.',
          ),
        );
      } else {
        reject(error);
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(out).toString(), stderr: err });
      else reject(new FfmpegFailedError(binary, code, err));
    });
  });
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  sample_rate?: string;
  channels?: number;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

interface FfprobeOutput {
  format?: { format_name?: string; duration?: string };
  streams?: FfprobeStream[];
}

async function probeSource(
  ffprobePath: string,
  sourcePath: string,
  transformerName: string,
): Promise<MediaProbeSummary> {
  const { stdout } = await run(
    ffprobePath,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', sourcePath],
    transformerName,
  );
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch {
    throw new FfmpegFailedError(
      ffprobePath,
      0,
      `unparseable ffprobe output: ${stdout.slice(0, 200)}`,
    );
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  const summary: MediaProbeSummary = { hasVideo: Boolean(video), hasAudio: Boolean(audio) };
  if (parsed.format?.format_name) summary.format = parsed.format.format_name;
  const duration = Number(parsed.format?.duration);
  if (Number.isFinite(duration)) summary.durationSeconds = duration;
  if (video) {
    // Phone videos store landscape frames plus a rotation; report the size as displayed.
    const rotation = Math.abs(
      Number(
        video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ??
          video.tags?.rotate ??
          0,
      ),
    );
    const swap = rotation === 90 || rotation === 270;
    if (video.width !== undefined && video.height !== undefined) {
      summary.width = swap ? video.height : video.width;
      summary.height = swap ? video.width : video.height;
    }
    summary.videoCodec = video.codec_name ?? null;
  }
  if (audio) {
    summary.audioCodec = audio.codec_name ?? null;
    const sampleRate = Number(audio.sample_rate);
    if (Number.isFinite(sampleRate)) summary.audioSampleRate = sampleRate;
    if (audio.channels !== undefined) summary.audioChannels = audio.channels;
  }
  return summary;
}

/** The rungs actually encoded for a source of `sourceHeight` px: never upscale, never empty. */
export function effectiveLadder(
  ladder: FfmpegRendition[],
  sourceHeight: number | undefined,
): FfmpegRendition[] {
  const sorted = [...ladder].sort((a, b) => a.height - b.height);
  if (!sourceHeight) return sorted;
  const fitting = sorted.filter((r) => r.height <= sourceHeight);
  if (fitting.length > 0) return fitting;
  const smallest = sorted[0];
  return smallest ? [{ ...smallest, height: sourceHeight - (sourceHeight % 2) }] : [];
}

/**
 * Build the ffmpeg argument list for one HLS run with TS segments. Exported for tests and for anyone wrapping the
 * engine; `renditions` empty means remux.
 */
export function buildHlsArgs(input: {
  sourcePath: string;
  outputDir: string;
  entryName: string;
  targetDuration: number;
  hasAudio: boolean;
  renditions: FfmpegRendition[];
  preset: string;
  extraArgs: string[];
}): string[] {
  const { sourcePath, outputDir, entryName, targetDuration, hasAudio, renditions, preset } = input;
  const args = ['-hide_banner', '-y', '-i', sourcePath];
  const streamMap: string[] = [];

  if (renditions.length === 0) {
    args.push('-map', '0:v:0');
    if (hasAudio) args.push('-map', '0:a:0');
    args.push('-c', 'copy');
    streamMap.push(hasAudio ? 'v:0,a:0' : 'v:0');
  } else {
    const n = renditions.length;
    const splits = renditions.map((_, i) => `[v${i}]`).join('');
    const scales = renditions.map((r, i) => `[v${i}]scale=-2:${r.height}[v${i}o]`).join(';');
    args.push('-filter_complex', `[0:v:0]split=${n}${splits};${scales}`);
    renditions.forEach((r, i) => {
      const peak = `${Math.round(parseBitrate(r.videoBitrate) * 1.5)}`;
      args.push(
        '-map',
        `[v${i}o]`,
        `-c:v:${i}`,
        'libx264',
        `-b:v:${i}`,
        r.videoBitrate,
        `-maxrate:v:${i}`,
        peak,
        `-bufsize:v:${i}`,
        `${Number(peak) * 2}`,
      );
      if (hasAudio) {
        args.push('-map', '0:a:0', `-c:a:${i}`, 'aac', `-b:a:${i}`, r.audioBitrate ?? '128k');
      }
      streamMap.push(hasAudio ? `v:${i},a:${i}` : `v:${i}`);
    });
    // Segment boundaries must land on keyframes for every rendition to switch cleanly.
    args.push(
      '-preset',
      preset,
      '-pix_fmt',
      'yuv420p',
      '-sc_threshold',
      '0',
      '-force_key_frames',
      `expr:gte(t,n_forced*${targetDuration})`,
    );
  }

  args.push(
    ...input.extraArgs,
    '-f',
    'hls',
    '-hls_time',
    String(targetDuration),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_filename',
    join(outputDir, SEGMENT_PATTERN),
    '-master_pl_name',
    entryName,
    '-var_stream_map',
    streamMap.join(' '),
    join(outputDir, PLAYLIST_PATTERN),
  );
  return args;
}

/**
 * Validate a ladder while the config is in hand — a bad rung would otherwise fail deep inside
 * libx264 with a cryptic error on the first transcode.
 */
function validateLadder(ladder: FfmpegRendition[] | undefined): void {
  for (const r of ladder ?? []) {
    if (!Number.isInteger(r.height) || r.height <= 0 || r.height % 2 !== 0) {
      throw new Error(
        `Invalid rendition height ${r.height} (expected a positive even integer — h264 needs even dimensions)`,
      );
    }
    parseBitrate(r.videoBitrate);
    if (r.audioBitrate !== undefined) parseBitrate(r.audioBitrate);
  }
}

/** `'2800k'` → 2_800_000. Plain numbers pass through. */
function parseBitrate(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid bitrate "${value}" (expected e.g. '800k', '5M', '128000')`);
  const n = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  return unit === 'k' ? n * 1_000 : unit === 'm' ? n * 1_000_000 : n;
}

/** Segment names of a CMAF package; `$…$` are DASH template identifiers ffmpeg fills in. */
const DASH_INIT_PATTERN = 'init-$RepresentationID$.m4s';
const DASH_SEGMENT_PATTERN = 'chunk-$RepresentationID$-$Number%05d$.m4s';

/**
 * Build the ffmpeg argument list for one DASH (CMAF) run — one manifest, fragmented-MP4 segments
 * and, with `hlsEntryName`, an HLS master playlist over the same segments. Exported for tests and
 * for anyone wrapping the engine; `renditions` empty means remux.
 */
export function buildDashArgs(input: {
  sourcePath: string;
  outputDir: string;
  manifestName: string;
  hlsEntryName?: string | undefined;
  targetDuration: number;
  hasAudio: boolean;
  renditions: FfmpegRendition[];
  audioBitrate: string;
  preset: string;
  extraArgs: string[];
}): string[] {
  const { sourcePath, outputDir, targetDuration, hasAudio, renditions } = input;
  const args = ['-hide_banner', '-y', '-i', sourcePath];

  if (renditions.length === 0) {
    args.push('-map', '0:v:0');
    if (hasAudio) args.push('-map', '0:a:0');
    args.push('-c', 'copy');
  } else {
    const n = renditions.length;
    const splits = renditions.map((_, i) => `[v${i}]`).join('');
    const scales = renditions.map((r, i) => `[v${i}]scale=-2:${r.height}[v${i}o]`).join(';');
    args.push('-filter_complex', `[0:v:0]split=${n}${splits};${scales}`);
    renditions.forEach((r, i) => {
      const peak = `${Math.round(parseBitrate(r.videoBitrate) * 1.5)}`;
      args.push(
        '-map',
        `[v${i}o]`,
        `-c:v:${i}`,
        'libx264',
        `-b:v:${i}`,
        r.videoBitrate,
        `-maxrate:v:${i}`,
        peak,
        `-bufsize:v:${i}`,
        `${Number(peak) * 2}`,
      );
    });
    // DASH shares one audio track across the video rungs (its own adaptation set).
    if (hasAudio) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', input.audioBitrate);
    args.push(
      '-preset',
      input.preset,
      '-pix_fmt',
      'yuv420p',
      '-sc_threshold',
      '0',
      '-force_key_frames',
      `expr:gte(t,n_forced*${targetDuration})`,
    );
  }

  args.push(
    ...input.extraArgs,
    '-f',
    'dash',
    '-seg_duration',
    String(targetDuration),
    '-use_template',
    '1',
    '-use_timeline',
    '1',
    '-adaptation_sets',
    hasAudio ? 'id=0,streams=v id=1,streams=a' : 'id=0,streams=v',
    '-init_seg_name',
    DASH_INIT_PATTERN,
    '-media_seg_name',
    DASH_SEGMENT_PATTERN,
  );
  if (input.hlsEntryName) {
    args.push('-hls_playlist', '1', '-hls_master_name', input.hlsEntryName);
  }
  args.push(join(outputDir, input.manifestName));
  return args;
}

/**
 * {@link VideoPackagingEngine} backed by the system ffmpeg: remux by default, or an
 * adaptive-bitrate ladder when `ladder` is set.
 *
 * - CMAF segments go through ffmpeg's DASH muxer, which writes the MPD and (for HLS) a master
 *   playlist over the same fragmented-MP4 segments — one audio track shared by every rung.
 * - TS segments go through the HLS muxer, every rendition carrying its own audio.
 *
 * Needs ffmpeg ≥ 4.3 (`-hls_master_name`).
 */
export function ffmpegVideoEngine(options: FfmpegVideoEngineOptions = {}): VideoPackagingEngine {
  const ffmpegPath = options.ffmpegPath ?? 'ffmpeg';
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  validateLadder(options.ladder);
  if (options.audioBitrate !== undefined) parseBitrate(options.audioBitrate);
  const audioBitrate =
    options.audioBitrate ??
    [...(options.ladder ?? [])]
      .map((r) => r.audioBitrate)
      .filter((b): b is string => b !== undefined)
      .sort((a, b) => parseBitrate(b) - parseBitrate(a))[0] ??
    '128k';

  return {
    async package(request: VideoPackageRequest): Promise<VideoPackageSummary> {
      const summary = await probeSource(ffprobePath, request.sourcePath, 'video');
      // Same definitive signal the mediabunny engine gives for an unusable source, so callers
      // branch on one error regardless of engine (and don't retry an audio-only file forever).
      if (!summary.hasVideo) {
        throw new HlsSourceUnsupportedError(
          'the source has no video stream',
          'Video packaging needs a video track; this file is audio-only or not a video.',
        );
      }

      const renditions = options.ladder ? effectiveLadder(options.ladder, summary.height) : [];
      const common = {
        sourcePath: request.sourcePath,
        outputDir: request.outputDir,
        targetDuration: request.targetDuration,
        hasAudio: summary.hasAudio,
        renditions,
        preset: options.preset ?? 'veryfast',
        extraArgs: options.extraArgs ?? [],
      };

      if (request.segments === 'ts') {
        await run(ffmpegPath, buildHlsArgs({ ...common, entryName: request.hlsEntry! }), 'video');
      } else {
        // The DASH muxer always writes an MPD; an HLS-only package drops it afterwards.
        const manifestName = request.dashManifest ?? 'manifest.mpd';
        await run(
          ffmpegPath,
          buildDashArgs({ ...common, manifestName, hlsEntryName: request.hlsEntry, audioBitrate }),
          'video',
        );
        if (!request.dashManifest) await rm(join(request.outputDir, manifestName));
      }

      const result: VideoPackageSummary = {};
      if (summary.durationSeconds !== undefined) result.durationSeconds = summary.durationSeconds;
      if (summary.width !== undefined) result.width = summary.width;
      if (summary.height !== undefined) result.height = summary.height;
      result.videoCodec = renditions.length > 0 ? 'h264' : (summary.videoCodec ?? null);
      if (summary.hasAudio)
        result.audioCodec = renditions.length > 0 ? 'aac' : (summary.audioCodec ?? null);
      return result;
    },
  };
}

/**
 * {@link MediaProbeEngine} backed by the system ffprobe. Differences from the mediabunny probe:
 * `format` is ffprobe's `format_name` (e.g. `'mov,mp4,m4a,3gp,3g2,mj2'`), and `mimeType` is not
 * reported — ffprobe has no MIME/codecs-string notion; the record's own `mimeType` still applies.
 */
export function ffprobeEngine(
  options: Pick<FfmpegBinaryOptions, 'ffprobePath'> = {},
): MediaProbeEngine {
  const ffprobePath = options.ffprobePath ?? 'ffprobe';
  return {
    async probe(sourcePath: string): Promise<MediaProbeSummary> {
      return probeSource(ffprobePath, sourcePath, 'probe');
    },
  };
}
