import { randomUUID } from 'node:crypto';
import { publishMedia } from './diagnostics.js';
import {
  MimeNotAllowedError,
  UploadNotSupportedError,
  UploadPartOutOfRangeError,
  UploadPartSizeError,
  UploadPartsIncompleteError,
  UploadSessionExpiredError,
  UploadSessionNotFoundError,
} from './errors.js';
import type { MediaCollectionRegistry } from './media_collection.js';
import { isMultipartCapable } from './multipart.js';
import type {
  UploadSession,
  UploadSessionListFilter,
  UploadSessionStore,
} from './resumable_upload.js';
import type { StorageManager } from './storage_manager.js';
import type { MultipartPart, MultipartUploadDisk } from './types.js';

/**
 * Default part size: 20 MiB. Between S3's 5 MiB minimum and a reasonable payload per browser `PUT`;
 * with S3's 10,000-part cap it covers files up to ~195 GiB. Larger than the proxy default (8 MiB)
 * on purpose — direct parts don't occupy app memory, so the only cost of a bigger part is a bigger
 * retry unit.
 */
export const DEFAULT_DIRECT_PART_SIZE = 20 * 1024 * 1024;
/** S3's minimum part size (every part but the last). Enforced at `initiate` — see {@link UploadPartSizeError}. */
export const MIN_DIRECT_PART_SIZE = 5 * 1024 * 1024;
/** S3's cap on parts per multipart upload. */
export const MAX_DIRECT_PARTS = 10_000;
/**
 * Default presigned part-URL lifetime (1 hour). Deliberately not sized to "the whole upload on a
 * slow connection": {@link DirectUploadManager.status} re-issues fresh URLs for whatever is still
 * pending, so an expired URL costs one status round-trip, not the upload.
 */
const DEFAULT_PRESIGN_TTL_SECONDS = 3600;

/** Session-metadata key marking a session as a direct upload and carrying its agreed part size. */
const PART_SIZE_METADATA_KEY = 'direct:partSize';

/** A part the client should `PUT`: its number and the presigned URL that authorizes exactly that. */
export interface DirectUploadPartUrl {
  partNumber: number;
  url: string;
}

export interface DirectUploadInitiateInput {
  /** Disk name; defaults to the manager's default disk. Must be multipart-capable. */
  disk?: string | undefined;
  /** Final object key. Resolve it server-side (per user/tenant) — never trust a client-sent key. */
  key: string;
  /** Content-Type stamped on the final object, and checked against `collection`'s whitelist. */
  contentType?: string | undefined;
  /** Total file size in bytes. Required: it fixes the part count both sides slice by. */
  size: number;
  /**
   * Collection this upload is destined for. When the manager holds a collection registry, the
   * declared `contentType` is checked against that collection's `acceptsMimeTypes` HERE — before
   * the multipart upload is opened, before a single byte moves. Mirrors the TUS `POST` gate: fast
   * feedback and bandwidth economy, not the security boundary — `attachExisting` re-validates the
   * real bytes at attach time.
   */
  collection?: string | undefined;
  /** Public/private visibility for the final object. */
  visibility?: 'public' | 'private' | undefined;
  /** Override the manager's part size for this upload. Same S3 bounds apply. */
  partSize?: number | undefined;
  /** Extra metadata persisted on the session (keys under `direct:` are reserved). */
  metadata?: Record<string, string> | undefined;
}

/** What {@link DirectUploadManager.initiate} hands back — everything the client needs to start `PUT`ing. */
export interface DirectUploadCreatedSession {
  /** Session id — the handle for `status`/`confirmPart`/`complete`/`abort`. */
  id: string;
  key: string;
  disk: string;
  /** The agreed slice size. The client MUST cut the file with exactly this. */
  partSize: number;
  size: number;
  totalParts: number;
  /** One presigned URL per part, 1-based, in order. */
  parts: DirectUploadPartUrl[];
  expiresAt?: Date | undefined;
}

/**
 * The resume answer: what is already confirmed (ETags the server holds) and what is still pending
 * (with FRESH presigned URLs). A client that lost its state — page reload, new tab, new device —
 * asks this and continues from the parts that are missing, re-uploading nothing.
 */
export interface DirectUploadStatus {
  id: string;
  key: string;
  disk: string;
  partSize: number;
  size: number;
  totalParts: number;
  contentType?: string | undefined;
  /** Parts whose ETags the session holds — already uploaded and confirmed. */
  completedParts: MultipartPart[];
  /** Parts still missing, each with a freshly presigned URL (expiry never strands an upload). */
  pendingParts: DirectUploadPartUrl[];
  expiresAt?: Date | undefined;
}

export interface DirectUploadManagerOptions {
  storage: StorageManager;
  /**
   * Session persistence — the SAME SPI (and, with the Lucid driver, the same tables) the resumable
   * (TUS) subsystem uses. The store must implement `addPart`/`listParts`; both bundled drivers do.
   */
  sessions: UploadSessionStore;
  /** Collection registry (`media.collections`) for the `initiate` MIME gate. Omit ⇒ no gate here. */
  collections?: MediaCollectionRegistry | undefined;
  /** Default part size in bytes. Default 20 MiB ({@link DEFAULT_DIRECT_PART_SIZE}). */
  partSize?: number | undefined;
  /** Lifetime of presigned part URLs, in seconds. Default 3600. */
  presignTtlSeconds?: number | undefined;
  /** Session lifetime in seconds. Omit for sessions that never expire. */
  sessionTtlSeconds?: number | undefined;
  idGenerator?: (() => string) | undefined;
  /** Injectable clock (tests drive expiry deterministically). Default `() => new Date()`. */
  clock?: (() => Date) | undefined;
  /** Emit `upload.*` diagnostics events (default true). */
  emitDiagnostics?: boolean | undefined;
}

/**
 * Session-backed direct-to-S3 multipart uploads: the browser `PUT`s every byte straight to storage
 * through presigned part URLs, and the app only coordinates — open, presign, collect ETags, close.
 * The app's bandwidth cost is a handful of JSON round-trips regardless of file size, which is the
 * entire point for video-sized files: the TUS path streams every chunk THROUGH the app (2× the
 * bytes: client→app, app→S3), where this path streams none.
 *
 * What this adds over the raw primitives on {@link UploadManager} (`initiateDirect` & friends) is
 * the **persisted session**: `uploadId`, the agreed `partSize` and every confirmed part ETag live
 * in an {@link UploadSessionStore} — the same SPI the TUS engine persists its offsets in — instead
 * of in the client's memory. A page reload no longer orphans the upload: the client asks
 * {@link status} and gets back the confirmed ETags plus fresh URLs for what is missing.
 *
 * Framework-free, like {@link ResumableUploadManager}: the `DirectUploadHandler` maps it onto HTTP
 * and the AdonisJS provider mounts that. `MediaManager.completeDirectUploadToLibrary` bridges a
 * finished session into the media library through `attachExisting` — where the collection's
 * whitelist checks the REAL bytes, exactly like every other upload path.
 */
export class DirectUploadManager {
  private readonly storage: StorageManager;
  private readonly sessions: UploadSessionStore;
  private readonly collections: MediaCollectionRegistry | undefined;
  private readonly partSize: number;
  private readonly presignTtlSeconds: number;
  private readonly ttlSeconds: number | undefined;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly emitDiagnostics: boolean;

  constructor(options: DirectUploadManagerOptions) {
    this.storage = options.storage;
    this.sessions = options.sessions;
    this.collections = options.collections;
    this.partSize = options.partSize ?? DEFAULT_DIRECT_PART_SIZE;
    this.presignTtlSeconds = options.presignTtlSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS;
    this.ttlSeconds = options.sessionTtlSeconds;
    this.newId = options.idGenerator ?? (() => randomUUID());
    this.now = options.clock ?? (() => new Date());
    this.emitDiagnostics = options.emitDiagnostics ?? true;
  }

  /**
   * Open a direct upload: validate everything that can be validated without bytes, start the native
   * multipart upload, persist the session, and presign every part URL in one batch (presigning is
   * local computation — see `sigv4.ts` — so a 10,000-part batch costs no S3 round-trips).
   */
  async initiate(input: DirectUploadInitiateInput): Promise<DirectUploadCreatedSession> {
    const diskName = input.disk ?? this.storage.defaultDisk;
    const disk = this.storage.disk(diskName);
    if (!isMultipartCapable(disk)) throw new UploadNotSupportedError(diskName);
    if (
      typeof this.sessions.addPart !== 'function' ||
      typeof this.sessions.listParts !== 'function'
    ) {
      throw new UploadNotSupportedError(diskName, 'direct upload part recording');
    }
    if (!Number.isInteger(input.size) || input.size <= 0) {
      throw new RangeError(`Direct upload size must be a positive integer, got ${input.size}`);
    }

    const partSize = input.partSize ?? this.partSize;
    if (!Number.isInteger(partSize) || partSize < MIN_DIRECT_PART_SIZE) {
      throw new UploadPartSizeError(
        `${partSize} bytes is below S3's ${MIN_DIRECT_PART_SIZE}-byte minimum`,
      );
    }
    const totalParts = Math.max(1, Math.ceil(input.size / partSize));
    if (totalParts > MAX_DIRECT_PARTS) {
      throw new UploadPartSizeError(
        `${input.size} bytes at ${partSize} bytes/part needs ${totalParts} parts, over S3's cap of ${MAX_DIRECT_PARTS} — increase partSize`,
      );
    }

    // The cheapest possible rejection, before the multipart upload even opens. Only the DECLARED
    // type can be checked here (there are no bytes yet); the collection config stays the single
    // source of truth, and attach-time validation of the real content remains the final barrier.
    if (input.collection !== undefined && this.collections !== undefined) {
      const accepts = this.collections.get(input.collection).acceptsMimeTypes;
      if (accepts && input.contentType !== undefined && !accepts.includes(input.contentType)) {
        throw new MimeNotAllowedError(input.collection, input.contentType);
      }
    }

    const putOptions =
      input.contentType !== undefined || input.visibility !== undefined
        ? {
            ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
            ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
          }
        : undefined;
    const { uploadId } = await disk.createMultipartUpload(input.key, putOptions);

    const createdAt = this.now();
    const session = await this.sessions.create({
      id: this.newId(),
      disk: diskName,
      key: input.key,
      contentType: input.contentType,
      size: input.size,
      offset: 0,
      parts: 0,
      multipartUploadId: uploadId,
      createdAt,
      ...(this.ttlSeconds !== undefined
        ? { expiresAt: new Date(createdAt.getTime() + this.ttlSeconds * 1000) }
        : {}),
      metadata: { ...input.metadata, [PART_SIZE_METADATA_KEY]: String(partSize) },
    });

    const parts = await this.#presignParts(
      disk,
      session,
      Array.from({ length: totalParts }, (_, index) => index + 1),
    );

    this.emit('upload.start', {
      id: session.id,
      disk: diskName,
      key: input.key,
      mode: 'direct',
      size: input.size,
      contentType: input.contentType,
    });

    return {
      id: session.id,
      key: session.key,
      disk: diskName,
      partSize,
      size: input.size,
      totalParts,
      parts,
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Record one part the client finished `PUT`ing (its S3 `ETag` response header). This is what makes
   * the session resumable: an ETag the server holds survives any client-side loss of state. Safe to
   * retry — confirming the same part again overwrites its ETag.
   */
  async confirmPart(
    id: string,
    part: MultipartPart,
  ): Promise<{ offset: number; completedParts: number }> {
    const session = await this.#require(id);
    const { partSize, totalParts } = this.#geometry(session);
    if (!Number.isInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > totalParts) {
      throw new UploadPartOutOfRangeError(part.partNumber, totalParts);
    }

    await this.sessions.addPart?.(id, { partNumber: part.partNumber, etag: part.etag });

    // Recompute progress from what is actually recorded (parts confirm in any order and in
    // parallel), so offset means "bytes safely on S3" rather than a linear cursor.
    const confirmed = (await this.sessions.listParts?.(id)) ?? [];
    session.parts = confirmed.length;
    session.offset = confirmed.reduce(
      (sum, recorded) => sum + this.#partBytes(session, partSize, totalParts, recorded.partNumber),
      0,
    );
    await this.sessions.update(session);

    this.emit('upload.progress', {
      id: session.id,
      offset: session.offset,
      parts: session.parts,
      size: session.size,
    });
    return { offset: session.offset, completedParts: confirmed.length };
  }

  /**
   * Where the upload stands, framed for resumption: the ETags already confirmed and a FRESH
   * presigned URL for every part still missing. After a page reload the client calls this, slices
   * the file with the returned `partSize`, uploads only `pendingParts`, and completes.
   */
  async status(id: string): Promise<DirectUploadStatus> {
    const session = await this.#require(id);
    const disk = this.storage.disk(session.disk);
    if (!isMultipartCapable(disk)) throw new UploadNotSupportedError(session.disk);
    const { partSize, totalParts } = this.#geometry(session);

    const completedParts = [...((await this.sessions.listParts?.(id)) ?? [])].sort(
      (a, b) => a.partNumber - b.partNumber,
    );
    const confirmedNumbers = new Set(completedParts.map((part) => part.partNumber));
    const pendingNumbers = Array.from({ length: totalParts }, (_, index) => index + 1).filter(
      (partNumber) => !confirmedNumbers.has(partNumber),
    );

    return {
      id: session.id,
      key: session.key,
      disk: session.disk,
      partSize,
      size: session.size as number,
      totalParts,
      contentType: session.contentType,
      completedParts,
      pendingParts: await this.#presignParts(disk, session, pendingNumbers),
      expiresAt: session.expiresAt,
    };
  }

  /**
   * Assemble the parts into the final object and close the session. `parts` supplements what the
   * session already holds (a client may hand over ETags it never got to confirm — e.g. it raced
   * completion against its last confirms); on overlap the caller's ETag wins. Every part number in
   * `1..totalParts` must be accounted for, or this throws {@link UploadPartsIncompleteError} naming
   * the gaps — BEFORE the S3 round-trip that would report an opaque `InvalidPart`.
   *
   * This is the raw primitive (the object exists, no media record). To land in the library, use
   * `MediaManager.completeDirectUploadToLibrary`, which chains `attachExisting` — collection
   * whitelist against the real bytes included.
   */
  async complete(
    id: string,
    parts: MultipartPart[] = [],
  ): Promise<{ key: string; disk: string; size: number }> {
    const session = await this.#require(id);
    const disk = this.storage.disk(session.disk);
    if (!isMultipartCapable(disk)) throw new UploadNotSupportedError(session.disk);
    const { totalParts } = this.#geometry(session);

    const byNumber = new Map<number, MultipartPart>();
    for (const recorded of (await this.sessions.listParts?.(id)) ?? []) {
      byNumber.set(recorded.partNumber, recorded);
    }
    for (const given of parts) byNumber.set(given.partNumber, given);

    const missing = Array.from({ length: totalParts }, (_, index) => index + 1).filter(
      (partNumber) => !byNumber.has(partNumber),
    );
    if (missing.length > 0) throw new UploadPartsIncompleteError(id, missing);

    const assembled = [...byNumber.values()].sort((a, b) => a.partNumber - b.partNumber);
    await disk.completeMultipartUpload(session.key, session.multipartUploadId as string, assembled);
    await this.sessions.delete(id);

    this.emit('upload.complete', { id: session.id, disk: session.disk, key: session.key });
    return { key: session.key, disk: session.disk, size: session.size as number };
  }

  /**
   * Discard an in-flight upload: abort the native multipart upload (S3 frees the stored parts and
   * stops charging for them) and drop the session. The S3 abort is best-effort — a bucket lifecycle
   * rule may have already reaped the upload (`NoSuchUpload`), and a session that can no longer be
   * aborted remotely must still be deletable locally.
   */
  async abort(id: string): Promise<void> {
    const session = await this.sessions.get(id);
    if (!session) return;
    const disk = this.storage.disk(session.disk);
    if (session.multipartUploadId && isMultipartCapable(disk)) {
      await disk.abortMultipartUpload(session.key, session.multipartUploadId).catch(() => {});
    }
    await this.sessions.delete(id);
    this.emit('upload.abort', { id: session.id, disk: session.disk, key: session.key });
  }

  /** In-progress direct sessions, optionally filtered. Empty when the store cannot enumerate. */
  async list(filter?: UploadSessionListFilter): Promise<UploadSession[]> {
    const sessions = (await this.sessions.list?.(filter)) ?? [];
    return sessions.filter((session) => session.metadata?.[PART_SIZE_METADATA_KEY] !== undefined);
  }

  /** Presign a `PUT` URL for each given part number, in one local batch. */
  async #presignParts(
    disk: MultipartUploadDisk,
    session: UploadSession,
    partNumbers: number[],
  ): Promise<DirectUploadPartUrl[]> {
    const urls: DirectUploadPartUrl[] = [];
    for (const partNumber of partNumbers) {
      urls.push({
        partNumber,
        url: await disk.presignUploadPart(
          session.key,
          session.multipartUploadId as string,
          partNumber,
          this.presignTtlSeconds,
        ),
      });
    }
    return urls;
  }

  /** The agreed slicing for a session, recovered from its persisted metadata. */
  #geometry(session: UploadSession): { partSize: number; totalParts: number } {
    const partSize = Number(session.metadata?.[PART_SIZE_METADATA_KEY]);
    const size = session.size as number;
    return { partSize, totalParts: Math.max(1, Math.ceil(size / partSize)) };
  }

  /** Byte length of one part: `partSize`, except the last part which takes the remainder. */
  #partBytes(
    session: UploadSession,
    partSize: number,
    totalParts: number,
    partNumber: number,
  ): number {
    const size = session.size as number;
    return partNumber === totalParts ? size - (totalParts - 1) * partSize : partSize;
  }

  /**
   * Load a session, requiring it to be a DIRECT one: the store may be shared with the TUS engine
   * (the Lucid driver even shares tables), so a session lacking the direct part-size marker — or a
   * declared size, or a native upload id — is "not found" here, never misinterpreted. An expired
   * session is treated as gone: native upload aborted, record deleted,
   * {@link UploadSessionExpiredError} thrown.
   */
  async #require(id: string): Promise<UploadSession> {
    const session = await this.sessions.get(id);
    if (
      !session ||
      session.multipartUploadId === undefined ||
      session.size === undefined ||
      !Number.isFinite(Number(session.metadata?.[PART_SIZE_METADATA_KEY]))
    ) {
      throw new UploadSessionNotFoundError(id);
    }
    if (session.expiresAt && session.expiresAt.getTime() <= this.now().getTime()) {
      const disk = this.storage.disk(session.disk);
      if (isMultipartCapable(disk)) {
        await disk.abortMultipartUpload(session.key, session.multipartUploadId).catch(() => {});
      }
      await this.sessions.delete(id);
      throw new UploadSessionExpiredError(id);
    }
    return session;
  }

  private emit<E extends 'upload.start' | 'upload.progress' | 'upload.complete' | 'upload.abort'>(
    event: E,
    payload: Parameters<typeof publishMedia<E>>[1],
  ): void {
    if (this.emitDiagnostics) publishMedia(event, payload);
  }
}
