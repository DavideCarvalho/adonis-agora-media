import type { Readable } from 'node:stream';
import { publishMedia } from './diagnostics.js';
import { UploadNotSupportedError } from './errors.js';
import { isMultipartCapable } from './multipart.js';
import type { StorageManager } from './storage_manager.js';
import type { MultipartPart } from './types.js';
import { type ResolvedUploadMode, type UploadMode, resolveUploadMode } from './upload_mode.js';

/** Default size of each multipart part when the caller gives none (8 MiB — S3's part minimum is 5 MiB). */
const DEFAULT_PART_SIZE = 8 * 1024 * 1024;
/** Default lifetime of a presigned part URL (1 hour). */
const DEFAULT_PRESIGN_TTL_SECONDS = 3600;

export interface UploadManagerOptions {
  storage: StorageManager;
  /** Global default upload mode (`auto` when omitted). */
  mode?: UploadMode | undefined;
  /** Default part size in bytes for direct multipart uploads. Default 8 MiB. */
  partSize?: number | undefined;
  /** Lifetime of presigned part URLs, in seconds. Default 3600. */
  presignTtlSeconds?: number | undefined;
  /** Emit `upload.*` diagnostics events (default true). */
  emitDiagnostics?: boolean | undefined;
}

export interface InitiateDirectUploadInput {
  /** Disk name; defaults to the manager's default disk. */
  disk?: string;
  /** Object key to write. Resolve this server-side (never trust the client) in your route. */
  key: string;
  /** Content-Type stamped on the final object. */
  contentType?: string;
  /** Public/private visibility for the final object. */
  visibility?: 'public' | 'private';
  /** Total size in bytes — used to pre-compute how many part URLs to hand back. */
  size?: number;
  /** Override the part size for this upload. */
  partSize?: number;
}

export interface DirectUploadCreated {
  uploadId: string;
  key: string;
  disk: string;
  partSize: number;
  parts: { partNumber: number; url: string }[];
}

export interface PresignPartInput {
  disk?: string;
  key: string;
  uploadId: string;
  partNumber: number;
}

export interface CompleteDirectUploadInput {
  disk?: string;
  key: string;
  uploadId: string;
  parts: MultipartPart[];
}

export interface AbortDirectUploadInput {
  disk?: string;
  key: string;
  uploadId: string;
}

export interface ProxyUploadInput {
  disk?: string;
  key: string;
  contents: Uint8Array | Readable;
  contentType?: string;
  visibility?: 'public' | 'private';
}

/**
 * Coordinates the two direct-S3 upload strategies over a {@link StorageManager}:
 *
 * - **proxy** — the client sends bytes to the app, which streams them to the disk with
 *   `put`/`putStream` (works on any disk). {@link proxyUpload} / {@link proxyUploadPart}.
 * - **direct** — for multipart-capable disks (S3), the app hands the client presigned part URLs so
 *   the client uploads straight to S3, then assembles the parts. {@link initiateDirect} /
 *   {@link presignPart} / {@link completeDirect} / {@link abortDirect}.
 *
 * This is the framework-free core; the AdonisJS provider exposes it over HTTP routes and
 * {@link MediaManager} delegates its `*DirectUpload` convenience methods here.
 */
export class UploadManager {
  private readonly storage: StorageManager;
  private readonly mode: UploadMode;
  private readonly partSize: number;
  private readonly presignTtlSeconds: number;
  private readonly emitDiagnostics: boolean;

  constructor(options: UploadManagerOptions) {
    this.storage = options.storage;
    this.mode = options.mode ?? 'auto';
    this.partSize = options.partSize ?? DEFAULT_PART_SIZE;
    this.presignTtlSeconds = options.presignTtlSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS;
    this.emitDiagnostics = options.emitDiagnostics ?? true;
  }

  /**
   * Resolve the effective mode for a disk (`proxy`/`direct`), honouring the per-call override, the
   * configured global default, and the disk's multipart capability. Throws when `direct` is forced
   * on a disk that can't do multipart.
   */
  resolveMode(input?: { disk?: string; mode?: UploadMode }): ResolvedUploadMode {
    const diskName = input?.disk ?? this.storage.defaultDisk;
    const disk = this.storage.disk(diskName);
    return resolveUploadMode(
      { global: this.mode, perCall: input?.mode },
      isMultipartCapable(disk),
      diskName,
    );
  }

  // --- direct mode ---------------------------------------------------------------------------

  /** Begin a direct multipart upload and return a presigned URL per part for the client to PUT to. */
  async initiateDirect(input: InitiateDirectUploadInput): Promise<DirectUploadCreated> {
    const diskName = input.disk ?? this.storage.defaultDisk;
    const disk = this.storage.disk(diskName);
    if (!isMultipartCapable(disk)) throw new UploadNotSupportedError(diskName);

    const putOptions =
      input.contentType !== undefined || input.visibility !== undefined
        ? {
            ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          }
        : undefined;

    const { uploadId } = await disk.createMultipartUpload(input.key, putOptions);

    const partSize = input.partSize ?? this.partSize;
    const partCount = input.size !== undefined ? Math.max(1, Math.ceil(input.size / partSize)) : 1;

    const parts: { partNumber: number; url: string }[] = [];
    for (let n = 1; n <= partCount; n++) {
      const url = await disk.presignUploadPart(input.key, uploadId, n, this.presignTtlSeconds);
      parts.push({ partNumber: n, url });
    }

    if (this.emitDiagnostics) {
      publishMedia('upload.start', {
        id: uploadId,
        disk: diskName,
        key: input.key,
        mode: 'direct',
        size: input.size,
        contentType: input.contentType,
      });
    }

    return { uploadId, key: input.key, disk: diskName, partSize, parts };
  }

  /** Issue a presigned URL for a single (e.g. retried) part of an in-flight direct upload. */
  async presignPart(input: PresignPartInput): Promise<{ url: string }> {
    const diskName = input.disk ?? this.storage.defaultDisk;
    const disk = this.storage.disk(diskName);
    if (!isMultipartCapable(disk)) throw new UploadNotSupportedError(diskName);

    const url = await disk.presignUploadPart(
      input.key,
      input.uploadId,
      input.partNumber,
      this.presignTtlSeconds,
    );
    return { url };
  }

  /** Assemble the uploaded parts into the final object, closing out the direct upload. */
  async completeDirect(input: CompleteDirectUploadInput): Promise<{ key: string; disk: string }> {
    const diskName = input.disk ?? this.storage.defaultDisk;
    const disk = this.storage.disk(diskName);
    if (!isMultipartCapable(disk)) throw new UploadNotSupportedError(diskName);

    await disk.completeMultipartUpload(input.key, input.uploadId, input.parts);

    if (this.emitDiagnostics) {
      publishMedia('upload.complete', { id: input.uploadId, disk: diskName, key: input.key });
    }
    return { key: input.key, disk: diskName };
  }

  /** Discard an in-flight direct upload and free its parts on S3. */
  async abortDirect(input: AbortDirectUploadInput): Promise<void> {
    const diskName = input.disk ?? this.storage.defaultDisk;
    const disk = this.storage.disk(diskName);
    if (!isMultipartCapable(disk)) throw new UploadNotSupportedError(diskName);

    await disk.abortMultipartUpload(input.key, input.uploadId);

    if (this.emitDiagnostics) {
      publishMedia('upload.abort', { id: input.uploadId, disk: diskName, key: input.key });
    }
  }

  // --- proxy mode ----------------------------------------------------------------------------

  /**
   * Proxy upload: stream the whole body through the app to the disk in a single write. Uses the
   * disk's `putStream` for a `Readable` (no in-memory buffering) and falls back to `put` for bytes.
   * Works on any disk — no multipart capability required.
   */
  async proxyUpload(input: ProxyUploadInput): Promise<{ key: string; disk: string }> {
    const diskName = input.disk ?? this.storage.defaultDisk;
    const disk = this.storage.disk(diskName);

    const writeOptions =
      input.contentType !== undefined || input.visibility !== undefined
        ? {
            ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          }
        : undefined;

    if (input.contents instanceof Uint8Array) {
      await disk.put(input.key, input.contents, writeOptions);
    } else if (disk.putStream) {
      await disk.putStream(input.key, input.contents, writeOptions);
    } else {
      // A disk without streaming support: buffer the stream, then `put`.
      const chunks: Buffer[] = [];
      for await (const chunk of input.contents) chunks.push(Buffer.from(chunk));
      await disk.put(input.key, new Uint8Array(Buffer.concat(chunks)), writeOptions);
    }

    return { key: input.key, disk: diskName };
  }

  /**
   * Proxy a single multipart part's bytes server-side (client PUTs the part to the app, the app
   * forwards it to S3). Pairs with {@link initiateDirect}/{@link completeDirect} for a
   * proxy-through-backend multipart flow on a multipart-capable disk.
   */
  async proxyUploadPart(input: {
    disk?: string;
    key: string;
    uploadId: string;
    partNumber: number;
    body: Uint8Array;
  }): Promise<MultipartPart> {
    const diskName = input.disk ?? this.storage.defaultDisk;
    const disk = this.storage.disk(diskName);
    if (!isMultipartCapable(disk))
      throw new UploadNotSupportedError(diskName, 'proxy multipart part');

    return disk.uploadPart(input.key, input.uploadId, input.partNumber, input.body);
  }
}
