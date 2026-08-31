import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { hlsArtifactContentType } from '../hls/playlist.js';
import type { Transformer, TransformerContext, TransformResult } from '../transformer.js';
import { loadMediabunny } from './mediabunny_loader.js';
import { withSourceFile } from './source_file.js';

/**
 * Lazily supplies a WebCodecs implementation (`{ VideoEncoder, VideoDecoder, AudioEncoder, … }`).
 * Node has no built-in WebCodecs, which is exactly why the HLS transformer is remux-only by
 * default — but NAPI-based implementations exist (e.g. `@napi-rs/webcodecs`), and injecting one
 * unlocks the re-encode fallback for sources whose codecs cannot be stream-copied:
 *
 * ```ts
 * transformers.hls({ webcodecs: () => import('@napi-rs/webcodecs') })
 * ```
 *
 * The engine installs the provided classes onto `globalThis` (only the ones missing — a native
 * implementation is never overwritten), because that is where the underlying media engine looks
 * the API up.
 */
export type WebCodecsProvider = () => Promise<Record<string, unknown>>;

/** How a runtime can satisfy the WebCodecs requirement. See {@link resolveWebCodecsSupport}. */
export type WebCodecsSupport = 'native' | 'injected' | 'absent';

/**
 * Detect how (whether) WebCodecs is available: `'native'` when the runtime already exposes
 * `VideoEncoder`, `'injected'` when a {@link WebCodecsProvider} supplies one, `'absent'` otherwise.
 * `'absent'` means encoding is impossible — transforms stay stream-copy only, and a transformer
 * that cannot proceed without an encoder should throw `TransformerRuntimeMissingError`.
 */
export async function resolveWebCodecsSupport(
  provider?: WebCodecsProvider,
): Promise<WebCodecsSupport> {
  if ((globalThis as Record<string, unknown>).VideoEncoder !== undefined) return 'native';
  if (provider && (await provider()).VideoEncoder !== undefined) return 'injected';
  return 'absent';
}

/** What {@link HlsRemuxEngine.remux} receives. */
export interface HlsRemuxRequest {
  /** Local path of the source file. */
  sourcePath: string;
  /** Local directory the engine writes the whole package into (entry playlist at its root). */
  outputDir: string;
  /** File name of the entry (master) playlist, e.g. `index.m3u8`. */
  entryName: string;
  /** Target (max) segment duration in seconds. */
  targetDuration: number;
  /** Optional WebCodecs implementation enabling the re-encode fallback. */
  webcodecs?: WebCodecsProvider | undefined;
}

/** What the engine learned about the source while remuxing — persisted into the conversion `meta`. */
export interface HlsRemuxSummary {
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string | null;
  audioCodec?: string | null;
}

/**
 * The engine seam of {@link HlsTransformer}: local file in, HLS package (playlists + segments) in
 * a local directory out. The default engine is mediabunny, loaded lazily on first transform; tests
 * inject a fake that writes files, so every bit of orchestration around the engine is testable
 * without the optional peer.
 */
export interface HlsRemuxEngine {
  remux(request: HlsRemuxRequest): Promise<HlsRemuxSummary>;
}

export interface HlsTransformerOptions<Name extends string = 'hls'> {
  /** Conversion name on the record. Default `'hls'`. */
  name?: Name;
  /**
   * Run inside attach. Default `false`, and think twice: a remux takes real time, and an eager
   * failure rolls the attach back. The intended flow is deferred —
   * `media.library.transform(id, 'hls')` from a job.
   */
  eager?: boolean;
  /** Target (max) segment duration in seconds. Default 4. */
  targetDuration?: number;
  /** WebCodecs implementation for the re-encode fallback (see {@link WebCodecsProvider}). */
  webcodecs?: WebCodecsProvider;
  /** Replace the mediabunny engine (mainly for tests). */
  engine?: HlsRemuxEngine;
}

/** File name of the entry (master) playlist an {@link HlsTransformer} produces. */
export const HLS_ENTRY_PLAYLIST = 'index.m3u8';

/**
 * The built-in video {@link Transformer}: converts a stored video into an HLS package — MPEG-TS
 * segments plus media playlists behind one master playlist — written under the conversion prefix
 * and persisted as `record.conversions['hls']` with duration/resolution/codec metadata.
 *
 * **Remux-only by default.** The engine (mediabunny, pure JS — no ffmpeg binary) stream-copies
 * the source's h264/aac tracks into segments without re-encoding, because encoding needs
 * WebCodecs, which Node does not provide. Two consequences, both deliberate:
 *
 * - a source whose codecs MPEG-TS cannot carry (vp9, av1…) fails with a clear, definitive
 *   `HlsSourceUnsupportedError` — unless a {@link WebCodecsProvider} is configured, which enables
 *   the engine's re-encode fallback;
 * - the package has a single variant at the original resolution. Multi-quality renditions are the
 *   documented evolution once an encoder is present (mediabunny supports fan-out video options),
 *   not something this transformer fakes today.
 *
 * The engine also carries the subtle bit the naive implementation gets wrong: AAC audio with
 * priming (an mp4 edit list) starts at a **negative** timestamp, and a conversion trimmed at t=0
 * would kick that track off the stream-copy fast path — impossible without an encoder. The
 * conversion is therefore trimmed at the source's real first timestamp, shifting all tracks
 * equally (sync is unchanged) and keeping every track copyable.
 *
 * Serving the result is the other half: playlists are stored with storage-relative references and
 * must be rewritten per request — see {@link HlsDeliveryHandler}.
 */
export class HlsTransformer<Name extends string = 'hls'> implements Transformer {
  readonly name: Name;
  readonly eager: boolean;
  private readonly targetDuration: number;
  private readonly webcodecs: WebCodecsProvider | undefined;
  private readonly engine: HlsRemuxEngine | undefined;

  constructor(options: HlsTransformerOptions<Name> = {}) {
    this.name = options.name ?? ('hls' as Name);
    this.eager = options.eager ?? false;
    this.targetDuration = options.targetDuration ?? 4;
    this.webcodecs = options.webcodecs;
    this.engine = options.engine;
  }

  async transform(context: TransformerContext): Promise<TransformResult> {
    const engine = this.engine ?? (await loadMediabunny(this.name)).createHlsEngine();

    return withSourceFile(context, async ({ sourcePath, tempDir }) => {
      const outputDir = join(tempDir, 'hls');
      await mkdir(outputDir, { recursive: true });

      const summary = await engine.remux({
        sourcePath,
        outputDir,
        entryName: HLS_ENTRY_PLAYLIST,
        targetDuration: this.targetDuration,
        webcodecs: this.webcodecs,
      });

      // Upload the whole package the engine wrote — playlists and segments alike — streaming each
      // file (a segment never has to fit in memory). Sorted for deterministic order in
      // `conversions[name].files`.
      const files = (await readdir(outputDir, { recursive: true })).sort();
      let segmentCount = 0;
      let playlistCount = 0;
      for (const file of files) {
        const relative = file.split('\\').join('/');
        const local = join(outputDir, file);
        const info = await stat(local);
        if (!info.isFile()) continue;
        if (relative.toLowerCase().endsWith('.m3u8')) playlistCount += 1;
        else segmentCount += 1;
        const contentType = hlsArtifactContentType(relative);
        await context.write(relative, createReadStream(local), {
          contentLength: info.size,
          ...(contentType !== undefined ? { contentType } : {}),
        });
      }

      return {
        entry: HLS_ENTRY_PLAYLIST,
        meta: compactMeta({
          ...summary,
          segmentCount,
          playlistCount,
          targetDuration: this.targetDuration,
        }),
      };
    });
  }
}

/** Drop `undefined` values so the persisted meta round-trips identically through JSON stores. */
export function compactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined));
}
