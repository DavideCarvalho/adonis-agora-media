import { randomUUID } from 'node:crypto';
import { publishMedia } from './diagnostics.js';
import {
  UploadNotSupportedError,
  UploadOffsetConflictError,
  UploadSessionExpiredError,
  UploadSessionNotFoundError,
} from './errors.js';
import { isMultipartCapable } from './multipart.js';
import type { StorageManager } from './storage_manager.js';
import type { MultipartPart } from './types.js';

/**
 * One in-flight resumable upload. Persisted through an {@link UploadSessionStore} so a dropped
 * connection resumes from {@link offset} rather than re-sending. Bytes accumulate as temporary
 * parts on the target disk (native S3 multipart when the disk is multipart-capable, otherwise
 * buffered part objects) until {@link ResumableUploadManager.complete} assembles the final object.
 */
export interface UploadSession {
  id: string;
  disk: string;
  /** Final object key the assembled upload will be written to. */
  key: string;
  contentType: string | undefined;
  /** Total expected size in bytes, if declared up front (TUS `Upload-Length`). */
  size: number | undefined;
  /** Bytes received so far — the resume offset. */
  offset: number;
  /** Number of chunk parts written so far. */
  parts: number;
  /** S3 (or other native-multipart) upload id, when the target disk is multipart-capable. */
  multipartUploadId?: string;
  /** When the session was created. */
  createdAt?: Date;
  /** When the session expires (TUS `expiration` extension); absent = never expires. */
  expiresAt?: Date;
  /** Decoded TUS `Upload-Metadata`, retained for finalization/inspection. */
  metadata?: Record<string, string>;
}

/** Optional filter for {@link UploadSessionStore.list}. */
export interface UploadSessionListFilter {
  /** Only sessions on this disk. */
  disk?: string;
  /** Only sessions whose `key` starts with this prefix. */
  keyPrefix?: string;
}

/**
 * Persistence SPI for resumable upload sessions. Ships with an in-memory driver
 * (`@adonis-agora/media/testing`) and a Lucid driver (`@adonis-agora/media/upload_sessions/lucid`),
 * mirroring the {@link MediaStore} pattern. `addPart`/`listParts` are optional and only needed when
 * the target disk is multipart-capable (they record the S3 part ETags for finalization).
 */
export interface UploadSessionStore {
  create(session: UploadSession): Promise<UploadSession>;
  get(id: string): Promise<UploadSession | null>;
  update(session: UploadSession): Promise<UploadSession>;
  delete(id: string): Promise<void>;
  /** Record one part's ETag, keyed by partNumber (multipart-capable disks only). */
  addPart?(id: string, part: MultipartPart): Promise<void>;
  /** All recorded parts for a session (unordered). Used by `complete()` + resume. */
  listParts?(id: string): Promise<MultipartPart[]>;
  /**
   * List currently-stored (in-progress) sessions, optionally filtered. Admin-facing (an "uploads in
   * progress" view), not a hot path. Optional: stores that cannot enumerate omit it and callers
   * degrade to an empty list.
   */
  list?(filter?: UploadSessionListFilter): Promise<UploadSession[]>;
}

export interface CreateUploadInput {
  disk: string;
  key: string;
  size?: number;
  contentType?: string;
  metadata?: Record<string, string>;
}

export interface ResumableUploadManagerOptions {
  storage: StorageManager;
  sessions: UploadSessionStore;
  /** Prefix for temporary chunk parts on the target disk (buffered path). Default `.uploads`. */
  tmpPrefix?: string;
  /** Session lifetime in seconds (TUS `expiration`). Omit for sessions that never expire. */
  sessionTtlSeconds?: number;
  idGenerator?: () => string;
  /** Injectable clock (tests drive expiry deterministically). Default `() => new Date()`. */
  clock?: () => Date;
  /** Emit `upload.*` diagnostics events (default true). */
  emitDiagnostics?: boolean;
}

/**
 * Framework-agnostic resumable-upload engine — the storage core the TUS HTTP handler drives. Bytes
 * flow through the backend in chunks; each chunk is written immediately as a part on the target disk
 * (native S3 multipart when available, else a buffered part object), so a dropped connection resumes
 * from `offset` without re-sending. {@link complete} assembles the parts into the final object.
 *
 * This never imports AdonisJS; the provider exposes it over TUS routes and {@link MediaManager}
 * surfaces it as `media.resumable`.
 */
export class ResumableUploadManager {
  private readonly storage: StorageManager;
  private readonly sessions: UploadSessionStore;
  private readonly tmpPrefix: string;
  private readonly ttlSeconds: number | undefined;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly emitDiagnostics: boolean;

  constructor(options: ResumableUploadManagerOptions) {
    this.storage = options.storage;
    this.sessions = options.sessions;
    this.tmpPrefix = options.tmpPrefix ?? '.uploads';
    this.ttlSeconds = options.sessionTtlSeconds;
    this.newId = options.idGenerator ?? (() => randomUUID());
    this.now = options.clock ?? (() => new Date());
    this.emitDiagnostics = options.emitDiagnostics ?? true;
  }

  private partKey(session: UploadSession, part: number): string {
    return `${this.tmpPrefix}/${session.id}/${part}`;
  }

  /** Begin a resumable upload session and reserve any native multipart upload the disk supports. */
  async createUpload(input: CreateUploadInput): Promise<UploadSession> {
    const disk = this.storage.disk(input.disk);
    const multipart = isMultipartCapable(disk)
      ? {
          multipartUploadId: (
            await disk.createMultipartUpload(
              input.key,
              input.contentType ? { contentType: input.contentType } : undefined,
            )
          ).uploadId,
        }
      : {};
    const createdAt = this.now();
    const session = await this.sessions.create({
      id: this.newId(),
      disk: input.disk,
      key: input.key,
      contentType: input.contentType,
      size: input.size,
      offset: 0,
      parts: 0,
      createdAt,
      ...(this.ttlSeconds !== undefined
        ? { expiresAt: new Date(createdAt.getTime() + this.ttlSeconds * 1000) }
        : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...multipart,
    });
    this.emit('upload.start', {
      id: session.id,
      disk: session.disk,
      key: session.key,
      mode: 'proxy',
      size: session.size,
      contentType: session.contentType,
    });
    return session;
  }

  /** Append a chunk at `offset` (must equal the session's current offset). Returns the new offset. */
  async writeChunk(id: string, offset: number, chunk: Uint8Array): Promise<{ offset: number }> {
    const session = await this.require(id);
    if (offset !== session.offset) {
      throw new UploadOffsetConflictError(session.offset, offset);
    }
    const disk = this.storage.disk(session.disk);
    if (session.multipartUploadId && isMultipartCapable(disk)) {
      if (typeof this.sessions.addPart !== 'function') {
        throw new UploadNotSupportedError(session.disk, 'resumable multipart part recording');
      }
      const part = await disk.uploadPart(
        session.key,
        session.multipartUploadId,
        session.parts + 1,
        chunk,
      );
      await this.sessions.addPart(id, part);
    } else {
      await disk.put(this.partKey(session, session.parts), chunk);
    }
    session.parts += 1;
    session.offset += chunk.byteLength;
    await this.sessions.update(session);
    this.emit('upload.progress', {
      id: session.id,
      offset: session.offset,
      parts: session.parts,
      size: session.size,
    });
    return { offset: session.offset };
  }

  /** Current offset, declared size, and expiry for a session (drives the TUS `HEAD` response). */
  async status(
    id: string,
  ): Promise<{ offset: number; size: number | undefined; expiresAt: Date | undefined }> {
    const session = await this.require(id);
    return { offset: session.offset, size: session.size, expiresAt: session.expiresAt };
  }

  /** Assemble all parts into the final object, clean up, and return the final key/disk/size. */
  async complete(id: string): Promise<{ key: string; disk: string; size: number }> {
    const session = await this.require(id);
    const disk = this.storage.disk(session.disk);

    if (session.multipartUploadId && isMultipartCapable(disk)) {
      const parts = [...((await this.sessions.listParts?.(id)) ?? [])].sort(
        (a, b) => a.partNumber - b.partNumber,
      );
      await disk.completeMultipartUpload(session.key, session.multipartUploadId, parts);
    } else {
      const chunks: Buffer[] = [];
      for (let part = 0; part < session.parts; part += 1) {
        chunks.push(Buffer.from(await disk.getBytes(this.partKey(session, part))));
      }
      await disk.put(
        session.key,
        new Uint8Array(Buffer.concat(chunks)),
        session.contentType ? { contentType: session.contentType } : {},
      );
    }

    await this.cleanup(session);
    await this.sessions.delete(id);
    const size = session.size ?? session.offset;
    this.emit('upload.complete', { id: session.id, disk: session.disk, key: session.key });
    return { key: session.key, disk: session.disk, size };
  }

  /** Discard an in-flight session, freeing its native multipart upload or buffered parts. */
  async abort(id: string): Promise<void> {
    const session = await this.sessions.get(id);
    if (!session) return;
    const disk = this.storage.disk(session.disk);
    if (session.multipartUploadId && isMultipartCapable(disk)) {
      await disk.abortMultipartUpload(session.key, session.multipartUploadId);
    }
    await this.cleanup(session);
    await this.sessions.delete(id);
    this.emit('upload.abort', { id: session.id, disk: session.disk, key: session.key });
  }

  /** All recorded parts for a session (multipart-capable disks). */
  async listParts(id: string): Promise<MultipartPart[]> {
    await this.require(id);
    return (await this.sessions.listParts?.(id)) ?? [];
  }

  /** In-progress sessions, optionally filtered. Empty when the store cannot enumerate. */
  async list(filter?: UploadSessionListFilter): Promise<UploadSession[]> {
    return (await this.sessions.list?.(filter)) ?? [];
  }

  private emit<E extends 'upload.start' | 'upload.progress' | 'upload.complete' | 'upload.abort'>(
    event: E,
    payload: Parameters<typeof publishMedia<E>>[1],
  ): void {
    if (this.emitDiagnostics) publishMedia(event, payload);
  }

  private async cleanup(session: UploadSession): Promise<void> {
    if (session.multipartUploadId) return;
    const disk = this.storage.disk(session.disk);
    for (let part = 0; part < session.parts; part += 1) {
      await disk.delete(this.partKey(session, part)).catch(() => {});
    }
  }

  /**
   * Load a session, treating an expired one as gone: its native/buffered parts are cleaned up, the
   * record is deleted, and an {@link UploadSessionExpiredError} is thrown (the TUS handler maps this
   * to `410 Gone`).
   */
  private async require(id: string): Promise<UploadSession> {
    const session = await this.sessions.get(id);
    if (!session) throw new UploadSessionNotFoundError(id);
    if (session.expiresAt && session.expiresAt.getTime() <= this.now().getTime()) {
      const disk = this.storage.disk(session.disk);
      if (session.multipartUploadId && isMultipartCapable(disk)) {
        await disk.abortMultipartUpload(session.key, session.multipartUploadId).catch(() => {});
      }
      await this.cleanup(session);
      await this.sessions.delete(id);
      throw new UploadSessionExpiredError(id);
    }
    return session;
  }
}
