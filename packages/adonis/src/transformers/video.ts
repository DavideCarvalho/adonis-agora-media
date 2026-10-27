import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { streamArtifactContentType } from '../streaming.js';
import type { Transformer, TransformerContext, TransformResult } from '../transformer.js';
import { loadMediabunny } from './mediabunny_loader.js';
import { withSourceFile } from './source_file.js';

/** A streaming format a {@link VideoTransformer} can write manifests for. */
export type VideoFormat = 'hls' | 'dash';

/**
 * The container of the segments.
 *
 * - `'cmaf'` — fragmented MP4 (`.m4s`), the format HLS and DASH share: one set of segments, a
 *   manifest per format. The default.
 * - `'ts'` — MPEG-TS (`.ts`), the original HLS segment format. HLS only (dash.js cannot play it);
 *   for players that predate fMP4 HLS (iOS 9 and older, some set-top boxes and smart TVs).
 */
export type VideoSegmentFormat = 'cmaf' | 'ts';

/**
 * Lazily supplies a WebCodecs implementation (`{ VideoEncoder, VideoDecoder, AudioEncoder, … }`).
 * Node has no built-in WebCodecs, which is why the mediabunny engine is remux-only by default —
 * but NAPI-based implementations exist (e.g. `@napi-rs/webcodecs`), and injecting one unlocks the
 * re-encode fallback for sources whose codecs cannot be stream-copied:
 *
 * ```ts
 * transformers.video({ webcodecs: () => import('@napi-rs/webcodecs') })
 * ```
 *
 * The engine installs the provided classes onto `globalThis` (only the ones missing — a native
 * implementation is never overwritten), because that is where the media engine looks them up.
 */
export type WebCodecsProvider = () => Promise<Record<string, unknown>>;

/** How a runtime can satisfy the WebCodecs requirement. See {@link resolveWebCodecsSupport}. */
export type WebCodecsSupport = 'native' | 'injected' | 'absent';

/**
 * Detect how (whether) WebCodecs is available: `'native'` when the runtime already exposes
 * `VideoEncoder`, `'injected'` when a {@link WebCodecsProvider} supplies one, `'absent'` otherwise.
 */
export async function resolveWebCodecsSupport(
  provider?: WebCodecsProvider,
): Promise<WebCodecsSupport> {
  if ((globalThis as Record<string, unknown>).VideoEncoder !== undefined) return 'native';
  if (provider && (await provider()).VideoEncoder !== undefined) return 'injected';
  return 'absent';
}

/** What {@link VideoPackagingEngine.package} receives. */
export interface VideoPackageRequest {
  /** Local path of the source file. */
  sourcePath: string;
  /** Local directory the engine writes the whole package into. */
  outputDir: string;
  /** Segment container. `'ts'` only ever comes with HLS alone. */
  segments: VideoSegmentFormat;
  /** File name of the HLS master playlist to write, or `undefined` when HLS is not wanted. */
  hlsEntry?: string | undefined;
  /** File name of the DASH manifest to write, or `undefined` when DASH is not wanted. */
  dashManifest?: string | undefined;
  /** Target (max) segment duration in seconds. */
  targetDuration: number;
  /** Optional WebCodecs implementation enabling the mediabunny re-encode fallback. */
  webcodecs?: WebCodecsProvider | undefined;
}

/** What the engine learned about the source — persisted into the conversion `meta`. */
export interface VideoPackageSummary {
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string | null;
  audioCodec?: string | null;
}

/**
 * The engine seam of {@link VideoTransformer}: a local file in, a streaming package in a local
 * directory out — segments plus every manifest the request names, at the root of `outputDir`.
 * The default is mediabunny (pure JS, remux); `engines.ffmpeg()` transcodes with the system
 * ffmpeg. Tests inject a fake that writes files.
 */
export interface VideoPackagingEngine {
  package(request: VideoPackageRequest): Promise<VideoPackageSummary>;
}

export interface VideoTransformerOptions<Name extends string = 'video'> {
  /** Conversion name on the record. Default `'video'`. */
  name?: Name;
  /**
   * Which manifests to write. Default `['hls', 'dash']`: with CMAF segments both describe the
   * same files, so the second format costs a manifest, not a second copy of the video.
   */
  formats?: readonly VideoFormat[];
  /** Segment container. Default `'cmaf'`; `'ts'` requires `formats: ['hls']`. */
  segments?: VideoSegmentFormat;
  /** Target (max) segment duration in seconds. Default 4. */
  targetDuration?: number;
  /**
   * Run inside attach. Default `false`, and think twice: packaging takes real time, and an eager
   * failure rolls the attach back. Run `media.library.transform(id, 'video')` from a job.
   */
  eager?: boolean;
  /**
   * The engine. Default: mediabunny (pure JS — no ffmpeg on the host — remux only). Use
   * `engines.ffmpeg({ ladder })` to transcode an adaptive-bitrate ladder.
   */
  engine?: VideoPackagingEngine;
  /** WebCodecs for the mediabunny engine's re-encode fallback (see {@link WebCodecsProvider}). */
  webcodecs?: WebCodecsProvider;
}

/** File name of the HLS master playlist a {@link VideoTransformer} writes. */
export const VIDEO_HLS_ENTRY = 'index.m3u8';

/** File name of the DASH manifest a {@link VideoTransformer} writes. */
export const VIDEO_DASH_MANIFEST = 'manifest.mpd';

/**
 * The built-in video {@link Transformer}: packages a stored video for adaptive streaming —
 * segments plus an HLS master playlist and/or a DASH manifest — persisted as
 * `record.conversions['video']`.
 *
 * - **CMAF by default.** Fragmented-MP4 segments are the one format both HLS and DASH play, so
 *   `formats: ['hls', 'dash']` (the default) writes the video once and describes it twice.
 * - **TS when you need it.** `segments: 'ts'` writes MPEG-TS segments, HLS only, for players
 *   that predate fMP4 HLS.
 * - **No ffmpeg needed.** The default engine (mediabunny) remuxes in pure JS; `engines.ffmpeg()`
 *   transcodes, ladder included, where the host has ffmpeg.
 *
 * Serve it with `media.access.streamRoute()` and play it with `useMediaStream`.
 */
export class VideoTransformer<Name extends string = 'video'> implements Transformer {
  readonly name: Name;
  readonly eager: boolean;
  readonly formats: readonly VideoFormat[];
  readonly segments: VideoSegmentFormat;
  private readonly targetDuration: number;
  private readonly engine: VideoPackagingEngine | undefined;
  private readonly webcodecs: WebCodecsProvider | undefined;

  constructor(options: VideoTransformerOptions<Name> = {}) {
    this.name = options.name ?? ('video' as Name);
    this.eager = options.eager ?? false;
    this.formats = [...new Set<VideoFormat>(options.formats ?? ['hls', 'dash'])];
    this.segments = options.segments ?? 'cmaf';
    this.targetDuration = options.targetDuration ?? 4;
    this.engine = options.engine;
    this.webcodecs = options.webcodecs;
    // Fail at config time, not on the first upload hours later.
    if (this.formats.length === 0) {
      throw new Error(`transformers.video({ name: '${this.name}' }): \`formats\` is empty.`);
    }
    for (const format of this.formats) {
      if (format !== 'hls' && format !== 'dash') {
        throw new Error(
          `transformers.video({ name: '${this.name}' }): unknown format '${format}' — use 'hls' and/or 'dash'.`,
        );
      }
    }
    if (this.segments !== 'cmaf' && this.segments !== 'ts') {
      throw new Error(
        `transformers.video({ name: '${this.name}' }): unknown segments '${this.segments}' — use 'cmaf' or 'ts'.`,
      );
    }
    if (this.segments === 'ts' && this.formats.includes('dash')) {
      throw new Error(
        `transformers.video({ name: '${this.name}' }): DASH cannot use TS segments — players ` +
          "only play DASH over fragmented MP4. Use `formats: ['hls']` with `segments: 'ts'`, or " +
          "keep the default `segments: 'cmaf'` (which serves both formats).",
      );
    }
  }

  async transform(context: TransformerContext): Promise<TransformResult> {
    const engine = this.engine ?? (await loadMediabunny(this.name)).createVideoEngine();
    const hls = this.formats.includes('hls');
    const dash = this.formats.includes('dash');

    return withSourceFile(context, async ({ sourcePath, tempDir }) => {
      const outputDir = join(tempDir, 'video');
      await mkdir(outputDir, { recursive: true });

      const summary = await engine.package({
        sourcePath,
        outputDir,
        segments: this.segments,
        hlsEntry: hls ? VIDEO_HLS_ENTRY : undefined,
        dashManifest: dash ? VIDEO_DASH_MANIFEST : undefined,
        targetDuration: this.targetDuration,
        webcodecs: this.webcodecs,
      });

      // Upload the whole package — manifests and segments — streaming each file (a segment never
      // has to fit in memory), a few at a time. Sorted for a deterministic `conversions[name].files`.
      const files: Array<{ relative: string; local: string; size: number }> = [];
      for (const file of (await readdir(outputDir, { recursive: true })).sort()) {
        const local = join(outputDir, file);
        const info = await stat(local);
        if (info.isFile())
          files.push({ relative: file.split('\\').join('/'), local, size: info.size });
      }
      await forEachBounded(files, VIDEO_UPLOAD_CONCURRENCY, ({ relative, local, size }) => {
        const contentType = streamArtifactContentType(relative);
        return context.write(relative, createReadStream(local), {
          contentLength: size,
          ...(contentType !== undefined ? { contentType } : {}),
        });
      });
      const written = new Set(files.map((file) => file.relative));
      let segmentCount = 0;
      for (const relative of written) {
        if (/\.(m4s|ts)$/i.test(relative) && !/(^|\/)init[^/]*$/i.test(relative)) {
          segmentCount += 1;
        }
      }

      for (const [format, manifest] of [
        ['hls', hls ? VIDEO_HLS_ENTRY : undefined],
        ['dash', dash ? VIDEO_DASH_MANIFEST : undefined],
      ] as const) {
        if (manifest && !written.has(manifest)) {
          throw new Error(
            `The video engine did not write the ${format.toUpperCase()} manifest "${manifest}".`,
          );
        }
      }

      return {
        entry: hls ? VIDEO_HLS_ENTRY : VIDEO_DASH_MANIFEST,
        meta: compactMeta({
          ...summary,
          segments: this.segments,
          segmentCount,
          targetDuration: this.targetDuration,
          hlsEntry: hls ? VIDEO_HLS_ENTRY : undefined,
          dashManifest: dash ? VIDEO_DASH_MANIFEST : undefined,
        }),
      };
    });
  }
}

/** Package files uploaded at once: enough to hide per-request latency, few enough not to flood the disk. */
const VIDEO_UPLOAD_CONCURRENCY = 6;

/**
 * Run `task` over `items`, at most `limit` at a time. On the first failure no further item starts,
 * and the error is rethrown only once every task already running has settled — so a caller
 * cleaning up after the failure never races an upload still in flight.
 */
export async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try {
        await task(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure !== undefined) throw failure.error;
}

/** Drop `undefined` values so the persisted meta round-trips identically through JSON stores. */
export function compactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));
}
