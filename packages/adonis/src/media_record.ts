/**
 * One generated derivative of a media record, keyed by conversion name in
 * {@link MediaRecord.conversions}. Three shapes share this type:
 *
 * - an **image conversion** (a `ConversionPreset`): `{ path, disk }` — one file.
 * - a **transformer output with artifacts** (e.g. the HLS package): `path` is the entry artifact
 *   (the master playlist), `prefix` is the storage prefix holding every artifact, and `files`
 *   lists them all relative to `prefix` — the authority for serving files out of the package and
 *   for deleting it whole.
 * - a **metadata-only transform** (a probe, a blurhash): no artifact at all — `path`/`disk` are
 *   absent and only `meta` carries the result.
 */
export interface MediaConversion {
  /** Entry-point artifact key. Absent for metadata-only transforms. */
  path?: string;
  /** Disk holding the artifact(s). Absent when there are none. */
  disk?: string;
  /** Storage prefix (ends in `/`) holding every artifact of a multi-file conversion. */
  prefix?: string;
  /** Every artifact key relative to {@link prefix}, the entry included. */
  files?: string[];
  /** Transformer-reported metadata (duration, codecs, hashes, …), persisted verbatim. */
  meta?: Record<string, unknown>;
}

/** A stored file associated with an owning entity (spatie media-library style). */
export interface MediaRecord {
  id: string;
  ownerType: string;
  ownerId: string;
  collection: string;
  /** Logical display name (defaults to the file name without extension). */
  name: string;
  fileName: string;
  mimeType: string;
  size: number;
  disk: string;
  path: string;
  order: number;
  customProperties: Record<string, unknown>;
  /** Generated variants keyed by conversion name (e.g. `thumb`). */
  conversions: Record<string, MediaConversion>;
  createdAt: Date;
  updatedAt: Date;
}
