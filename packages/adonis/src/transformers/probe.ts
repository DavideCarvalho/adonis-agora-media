import type { Transformer, TransformerContext, TransformResult } from '../transformer.js';
import { compactMeta } from './hls.js';
import { loadMediabunny } from './mediabunny_loader.js';
import { withSourceFile } from './source_file.js';

/** What probing a media file yields — persisted verbatim as the conversion's `meta`. */
export interface MediaProbeSummary {
  /** Container format name (e.g. `MP4`), when the engine can tell. */
  format?: string;
  /** Full MIME type including codecs parameter, when the engine can tell. */
  mimeType?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  videoCodec?: string | null;
  audioCodec?: string | null;
  audioSampleRate?: number;
  audioChannels?: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

/**
 * The engine seam of {@link MetadataProbeTransformer}: local file in, metadata out. Default engine
 * is mediabunny (lazy); tests inject a fake.
 */
export interface MediaProbeEngine {
  probe(sourcePath: string): Promise<MediaProbeSummary>;
}

export interface MetadataProbeTransformerOptions<Name extends string = 'probe'> {
  /** Conversion name on the record. Default `'probe'`. */
  name?: Name;
  /**
   * Run inside attach. Default `false`: probing is CPU-cheap but reads the original, and on a
   * remote disk that read is a download. Opt in for collections of small files.
   */
  eager?: boolean;
  /** Replace the mediabunny engine (mainly for tests). */
  engine?: MediaProbeEngine;
}

/**
 * The built-in **metadata-only** {@link Transformer}: reads a media file's technical metadata —
 * duration, resolution, codecs, channel layout — and persists it as
 * `record.conversions['probe'].meta`, writing **no artifact at all**. The reference implementation
 * of the "derive metadata, not files" transformer shape; the model for a blurhash/thumbhash
 * placeholder transformer.
 *
 * ```ts
 * await media.library.transform(id, 'probe')
 * const record = await media.library.find(id)
 * record.conversions.probe?.meta // { durationSeconds: 41.6, width: 1920, ... }
 * ```
 */
export class MetadataProbeTransformer<Name extends string = 'probe'> implements Transformer {
  readonly name: Name;
  readonly eager: boolean;
  private readonly engine: MediaProbeEngine | undefined;

  constructor(options: MetadataProbeTransformerOptions<Name> = {}) {
    this.name = options.name ?? ('probe' as Name);
    this.eager = options.eager ?? false;
    this.engine = options.engine;
  }

  async transform(context: TransformerContext): Promise<TransformResult> {
    const engine = this.engine ?? (await loadMediabunny(this.name)).createProbeEngine();
    const summary = await withSourceFile(context, ({ sourcePath }) => engine.probe(sourcePath));
    return { meta: compactMeta({ ...summary }) };
  }
}
