import type { Readable } from 'node:stream';
import type { MediaRecord } from './media_record.js';
import type { StorageManager } from './storage_manager.js';
import type { Disk } from './types.js';

/**
 * Options for {@link TransformerContext.write}. `contentLength` matters when `contents` is a
 * `Readable` on a disk that streams (S3 needs the length up front); it is ignored for byte payloads.
 */
export interface TransformerWriteOptions {
  contentType?: string;
  contentLength?: number;
}

/**
 * Everything a {@link Transformer} gets to work with: the record being transformed, read access to
 * its original bytes, and a sandboxed writer for the derived artifacts.
 *
 * The context — not the transformer — decides WHERE artifacts live: every {@link write} lands under
 * {@link outputPrefix} (`<owner>/<id>/conversions/<name>/`), and the library tracks each written
 * path so it can persist the artifact list on the record and delete every artifact when the media
 * is deleted. A transformer never touches disk keys outside its prefix.
 */
export interface TransformerContext {
  /** The media record whose content is being transformed. */
  record: MediaRecord;
  /** The disk holding the original object (and receiving the artifacts). */
  disk: Disk;
  /** Name of {@link disk}, as resolvable through the storage manager. */
  diskName: string;
  /**
   * The storage façade, for reads OUTSIDE the record's own disk — auxiliary assets a transformer
   * was configured with (a watermark logo on another disk, a font, a sidecar file). Artifact
   * writes still go through {@link write}, never directly through a disk.
   */
  storage: StorageManager;
  /** Buffer the original's bytes. Convenient for small originals; prefer {@link getStream} for video. */
  getBytes(): Promise<Uint8Array>;
  /** Stream the original without buffering it. */
  getStream(): Promise<Readable>;
  /**
   * Storage prefix (ending in `/`) reserved for this transformation's artifacts:
   * `<ownerType>/<ownerId>/<collection>/<mediaId>/conversions/<transformerName>/`.
   */
  outputPrefix: string;
  /**
   * Write one artifact at `outputPrefix + relativePath`. The path is validated (no `..`, no
   * absolute paths) and recorded — the persisted conversion lists every written artifact, which is
   * what makes multi-file outputs (an HLS package) deletable and servable file-by-file.
   *
   * A `Readable` with a known `contentLength` streams straight to the disk; anything else is
   * buffered.
   */
  write(
    relativePath: string,
    contents: Uint8Array | Readable,
    options?: TransformerWriteOptions,
  ): Promise<void>;
}

/**
 * What a {@link Transformer.transform} run reports back. The artifacts themselves were already
 * written through {@link TransformerContext.write}; this names which of them is the entry point and
 * attaches free-form metadata.
 */
export interface TransformResult {
  /**
   * The entry-point artifact, relative to {@link TransformerContext.outputPrefix} — what
   * `url(id, name)` / `deliver(id, { conversion: name })` resolve for this conversion. Required
   * when any artifact was written (and must be one of them); omit it for a metadata-only
   * transform (a probe, a blurhash) that wrote nothing.
   */
  entry?: string;
  /**
   * Transformer-specific metadata persisted verbatim on the conversion entry
   * (`record.conversions[name].meta`): duration, resolution, codecs, a blurhash string — whatever
   * the transformer learned. Must be JSON-serializable (the Lucid store serializes it).
   */
  meta?: Record<string, unknown>;
}

/**
 * A pluggable content transformation: takes a stored media's content and produces derived
 * artifacts on the disk and/or metadata on the record, persisted as a named conversion
 * (`record.conversions[transformer.name]`).
 *
 * This is the seam the library's own {@link HlsTransformer} and {@link MetadataProbeTransformer}
 * implement, and the one you implement for your own derivations — extract an audio track,
 * stamp a watermark, generate a poster frame, request a transcription. The shapes it supports:
 *
 * - **many artifacts** — an HLS package (segments + playlists); `entry` names the master playlist.
 * - **one artifact** — an optimized image, an extracted audio file; `entry` names it.
 * - **no artifact** — a metadata probe or perceptual hash; return only `meta`.
 * - **auxiliary inputs** — configure them on your transformer instance (bytes, a path, a media id)
 *   and read foreign disks through {@link TransformerContext.storage}.
 *
 * Registered per collection (`collections: [{ name, transformers: [...] }]`). Set `eager: true`
 * only for cheap transforms — they run synchronously inside `attach`/`attachExisting` (and so
 * inside a TUS finalize), and a failure rolls the new media back. Heavy transforms (video!) stay
 * deferred: the app triggers them from its own job via `media.library.transform(id, name)`,
 * which is idempotent — already generated ⇒ skip.
 *
 * Import heavy engines lazily INSIDE `transform` (the built-ins import `mediabunny` there), so
 * configuring a transformer never loads its optional peer at boot. A transformer that needs a
 * runtime capability the host lacks (e.g. WebCodecs for re-encoding) should throw
 * {@link TransformerRuntimeMissingError} with a clear hint rather than failing obscurely.
 */
export interface Transformer {
  /** Unique conversion name this transformer produces (the key in `record.conversions`). */
  readonly name: string;
  /**
   * Run synchronously on attach (like an eager image conversion) instead of waiting for an
   * explicit `transform()` call. Default `false` — transformations are assumed heavy.
   */
  readonly eager?: boolean;
  /** Produce the derived artifacts/metadata for one media record. */
  transform(context: TransformerContext): Promise<TransformResult>;
}
