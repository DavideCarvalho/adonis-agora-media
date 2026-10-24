import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { streamArtifactContentType } from '../streaming.js';
import type { Transformer, TransformerContext, TransformResult } from '../transformer.js';
import { ffmpegDashEngine } from './ffmpeg.js';
import type { HlsRemuxSummary } from './hls.js';
import { compactMeta } from './hls.js';
import { withSourceFile } from './source_file.js';

/** What {@link DashPackageEngine.package} receives. */
export interface DashPackageRequest {
  /** Local path of the source file. */
  sourcePath: string;
  /** Local directory the engine writes the whole package into. */
  outputDir: string;
  /** File name of the DASH manifest, e.g. `manifest.mpd`. */
  manifestName: string;
  /**
   * File name of an HLS master playlist to write over the **same** segments, or `undefined` for a
   * DASH-only package.
   */
  hlsEntryName?: string | undefined;
  /** Target segment duration in seconds. */
  targetDuration: number;
}

/**
 * The engine seam of {@link DashTransformer}: local file in, a CMAF package (fragmented-MP4
 * segments, an MPD, optionally an HLS master over the same segments) in a local directory out.
 * The default is {@link ffmpegDashEngine}; tests inject a fake that writes files.
 */
export interface DashPackageEngine {
  package(request: DashPackageRequest): Promise<HlsRemuxSummary>;
}

export interface DashTransformerOptions<Name extends string = 'dash'> {
  /** Conversion name on the record. Default `'dash'`. */
  name?: Name;
  /** Run inside attach. Default `false`: packaging a video takes real time — run it from a job. */
  eager?: boolean;
  /** Target segment duration in seconds. Default 4. */
  targetDuration?: number;
  /**
   * Also write an HLS master playlist over the same segments. Default `true`: the segments are
   * CMAF (fragmented MP4), which both formats play, so HLS costs a few playlists and no extra
   * storage — and Safari/iOS, which play HLS natively but not DASH, are covered by one package.
   */
  hls?: boolean;
  /** Replace the engine. Default `engines.ffmpegDash()` (remux; pass a `ladder` to transcode). */
  engine?: DashPackageEngine;
}

/** File name of the manifest a {@link DashTransformer} produces. */
export const DASH_MANIFEST = 'manifest.mpd';

/** File name of the HLS master playlist a {@link DashTransformer} writes alongside (`hls: true`). */
export const DASH_HLS_ENTRY = 'index.m3u8';

/**
 * Video → a **CMAF** package: fragmented-MP4 segments described by a DASH manifest
 * (`manifest.mpd`, the conversion entry) and, by default, by an HLS master playlist too
 * (`index.m3u8`, recorded as `meta.hlsEntry`) — one encode, one copy of the segments, both
 * formats. Persisted as `record.conversions['dash']`.
 *
 * The default engine is the system ffmpeg (`engines.ffmpegDash()`), remuxing the source as is;
 * `engines.ffmpegDash({ ladder: engines.ladders.standard })` transcodes an adaptive-bitrate ladder.
 * mediabunny has no DASH muxer, so unlike {@link HlsTransformer} there is no pure-JS default.
 *
 * Serve it with `media.access.streamRoute()`, and play it with `useMediaStream` from
 * `@adonis-agora/media-react` — which picks HLS where it plays natively and dash.js/hls.js
 * elsewhere.
 */
export class DashTransformer<Name extends string = 'dash'> implements Transformer {
  readonly name: Name;
  readonly eager: boolean;
  private readonly targetDuration: number;
  private readonly hls: boolean;
  private readonly engine: DashPackageEngine | undefined;

  constructor(options: DashTransformerOptions<Name> = {}) {
    this.name = options.name ?? ('dash' as Name);
    this.eager = options.eager ?? false;
    this.targetDuration = options.targetDuration ?? 4;
    this.hls = options.hls ?? true;
    this.engine = options.engine;
  }

  async transform(context: TransformerContext): Promise<TransformResult> {
    const engine = this.engine ?? ffmpegDashEngine();

    return withSourceFile(context, async ({ sourcePath, tempDir }) => {
      const outputDir = join(tempDir, 'dash');
      await mkdir(outputDir, { recursive: true });

      const summary = await engine.package({
        sourcePath,
        outputDir,
        manifestName: DASH_MANIFEST,
        hlsEntryName: this.hls ? DASH_HLS_ENTRY : undefined,
        targetDuration: this.targetDuration,
      });

      const files = (await readdir(outputDir, { recursive: true })).sort();
      let segmentCount = 0;
      for (const file of files) {
        const relative = file.split('\\').join('/');
        const local = join(outputDir, file);
        const info = await stat(local);
        if (!info.isFile()) continue;
        if (!/\.(mpd|m3u8)$/i.test(relative)) segmentCount += 1;
        const contentType = streamArtifactContentType(relative);
        await context.write(relative, createReadStream(local), {
          contentLength: info.size,
          ...(contentType !== undefined ? { contentType } : {}),
        });
      }

      const relativeFiles = files.map((f) => f.split('\\').join('/'));
      return {
        entry: DASH_MANIFEST,
        meta: compactMeta({
          ...summary,
          segmentCount,
          targetDuration: this.targetDuration,
          hlsEntry: this.hls && relativeFiles.includes(DASH_HLS_ENTRY) ? DASH_HLS_ENTRY : undefined,
        }),
      };
    });
  }
}
