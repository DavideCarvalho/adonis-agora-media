import type { Readable } from 'node:stream';

/**
 * The minimal disk surface `@adonis-agora/media` needs — a structural subset of an
 * `@adonisjs/drive` (flydrive) Disk, so a real Drive disk satisfies it directly. The library
 * NEVER imports Drive; it resolves a disk from the {@link DiskResolver} (the Drive manager's
 * `use(name)` in production, a fake in tests) and only ever calls these methods. This keeps Drive
 * a peer dependency and lets the in-memory test disk implement the same contract.
 *
 * Binary reads use `getBytes` (a `Uint8Array`) rather than `get` (which flydrive returns as a UTF-8
 * string); writes accept a `Uint8Array`, so callers buffer any `Readable` first.
 */
export interface Disk {
  put(key: string, contents: Uint8Array, options?: DiskWriteOptions): Promise<void>;
  /**
   * Write a stream straight to the disk without buffering it in memory (flydrive exposes this). Used
   * for large uploads when no conversions are needed and the size is known up front. Optional so the
   * structural contract stays minimal; callers fall back to {@link put} when it is absent.
   */
  putStream?(key: string, contents: Readable, options?: DiskWriteOptions): Promise<void>;
  getBytes(key: string): Promise<Uint8Array>;
  getStream(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  getUrl(key: string): Promise<string>;
  getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string>;
  getMetaData(key: string): Promise<DiskMetaData>;
}

export interface DiskWriteOptions {
  contentType?: string;
  visibility?: 'public' | 'private';
}

export interface SignedUrlOptions {
  /** Human-readable duration accepted by Drive, e.g. `'30m'`, `'1h'`, or seconds as a number. */
  expiresIn?: string | number;
  contentType?: string;
  contentDisposition?: string;
}

export interface DiskMetaData {
  contentLength: number;
  contentType?: string | undefined;
  etag?: string | undefined;
  lastModified?: Date | undefined;
}

/** One completed part of a native multipart upload: its number and the ETag S3 returned for it. */
export interface MultipartPart {
  partNumber: number;
  etag: string;
}

/**
 * Coarse feature descriptor for a disk, letting callers branch on what a backend supports without
 * probing methods one by one. Advertised by disks that implement {@link ExtendedDisk}; the media
 * library reads it structurally (via `isExtendedDisk`) and never depends on it statically.
 */
export interface DiskCapabilities {
  /** Can issue signed, time-limited URLs ({@link Disk.getSignedUrl}). */
  presign: boolean;
  /** Supports native server-side multipart assembly ({@link MultipartUploadDisk}). */
  multipart: boolean;
  /** Can serve stable public URLs ({@link Disk.getUrl}). */
  publicUrls: boolean;
  /** Can enumerate keys under a prefix ({@link ExtendedDisk.list}). */
  list: boolean;
}

/** Options for {@link ExtendedDisk.list}. */
export interface ListOptions {
  /** Delimiter that rolls deeper keys up into folder prefixes. Default `'/'`. */
  delimiter?: string;
  /** Opaque pagination cursor returned by a previous {@link ListResult}. */
  cursor?: string;
  /** Max entries per page. */
  limit?: number;
  /**
   * Override the disk's configured bucket (admin cross-bucket browse). Ignored by disks without a
   * bucket concept.
   */
  bucket?: string;
}

/** One file entry returned by {@link ExtendedDisk.list}. */
export interface ListEntry {
  /** Full key relative to the bucket/root. */
  key: string;
  /** Last path segment (file name, no trailing slash). */
  name: string;
  sizeBytes: number | null;
  lastModified: Date | null;
}

/** One page of a {@link ExtendedDisk.list} enumeration. */
export interface ListResult {
  /** Sub-folder prefixes (each ends in the delimiter), from `CommonPrefixes`. */
  folders: string[];
  /** File entries directly under the prefix. */
  files: ListEntry[];
  /** Present when the page is truncated; pass back as {@link ListOptions.cursor}. */
  cursor?: string;
}

/** Object metadata from {@link ExtendedDisk.stat} — size/content-type/last-modified without a body download. */
export interface DiskStat {
  size: number;
  contentType?: string | undefined;
  lastModified?: Date | undefined;
}

/** Optional destination overrides for {@link ExtendedDisk.copy}/{@link ExtendedDisk.move}. */
export interface CopyOptions {
  /** Copy into a different bucket than the disk's configured one (cross-bucket copy/move). */
  toBucket?: string;
}

/**
 * Optional add-on surface for disks that support richer object operations — cross-key/cross-bucket
 * copy & move, batched deletes, prefix listing, and cheap metadata (`size`/`stat`) — plus a
 * {@link DiskCapabilities} descriptor. Like {@link MultipartUploadDisk} it is kept OFF the base
 * {@link Disk} contract on purpose (the in-memory/Drive disks don't provide it) and detected
 * structurally at runtime via `isExtendedDisk`. The bundled `disks.s3()` disk implements it.
 */
export interface ExtendedDisk {
  /** Coarse feature descriptor for this disk. */
  readonly capabilities: DiskCapabilities;
  /** Server-side copy an object to another key (and optionally another bucket). */
  copy(from: string, to: string, options?: CopyOptions): Promise<void>;
  /** Server-side move (copy then delete the source). Supports cross-bucket via {@link CopyOptions}. */
  move(from: string, to: string, options?: CopyOptions): Promise<void>;
  /** Delete many keys in as few round-trips as the backend allows. An empty array is a no-op. */
  deleteMany(keys: string[]): Promise<void>;
  /** Enumerate keys under a prefix, one page at a time. */
  list(prefix: string, options?: ListOptions): Promise<ListResult>;
  /** Object size in bytes, without downloading the body. */
  size(key: string): Promise<number>;
  /** Object metadata (size/content-type/last-modified), without downloading the body. */
  stat(key: string): Promise<DiskStat>;
}

/**
 * Optional add-on surface for disks that support native server-side multipart uploads (S3). It is
 * kept OFF the base {@link Disk} contract on purpose — the in-memory/Drive disks don't provide it —
 * and detected structurally at runtime via `isMultipartCapable`. Powers the two direct-S3 upload
 * modes:
 *
 * - `proxy`: the client PUTs each part to the app, which forwards the bytes to S3 with
 *   {@link MultipartUploadDisk.uploadPart} (bytes flow through the backend).
 * - `direct`: the app issues presigned part URLs with
 *   {@link MultipartUploadDisk.presignUploadPart}; the client uploads each part straight to S3 and
 *   the app assembles them with {@link MultipartUploadDisk.completeMultipartUpload}.
 */
export interface MultipartUploadDisk {
  /** Begin a multipart upload; returns the S3 `UploadId` that ties the parts together. */
  createMultipartUpload(key: string, options?: DiskWriteOptions): Promise<{ uploadId: string }>;
  /** Upload one part's bytes server-side (the `proxy` path). Returns that part's number + ETag. */
  uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
  ): Promise<MultipartPart>;
  /** Issue a presigned URL the client PUTs one part to directly (the `direct` path). */
  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string>;
  /** Assemble the uploaded parts into the final object. */
  completeMultipartUpload(key: string, uploadId: string, parts: MultipartPart[]): Promise<void>;
  /** Discard an in-flight multipart upload and free its parts. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

/**
 * Resolves a disk by name. In an AdonisJS app this is `(name) => drive.use(name)`; the
 * provider builds it from the booted Drive manager. Tests pass a resolver over fake disks.
 * Omitting the name yields the configured default disk.
 */
export type DiskResolver = (name?: string) => Disk;
