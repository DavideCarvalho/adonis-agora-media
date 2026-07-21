import { AttachmentManager } from './attachment.js';
import type { DeliveryMode } from './delivery.js';
import { ResumableUploadsNotConfiguredError } from './errors.js';
import type { ImageProcessor } from './image_processor.js';
import type { MediaCollectionConfig, MediaCollectionRegistry } from './media_collection.js';
import { MediaLibrary } from './media_library.js';
import type { AttachExistingInput } from './media_library.js';
import type { MediaRecord } from './media_record.js';
import type { MediaStore } from './media_store.js';
import { ResumableUploadManager } from './resumable_upload.js';
import type { UploadSessionStore } from './resumable_upload.js';
import { StorageManager } from './storage_manager.js';
import type { DiskResolver } from './types.js';
import {
  type AbortDirectUploadInput,
  type CompleteDirectUploadInput,
  type DirectUploadCreated,
  type InitiateDirectUploadInput,
  type ProxyUploadInput,
  UploadManager,
} from './upload_manager.js';
import type { UploadMode } from './upload_mode.js';

export interface MediaManagerOptions {
  /** Default disk name (resolved by `resolve`). */
  defaultDisk: string;
  /** Resolves a disk by name — `(name) => drive.use(name)` in production. */
  resolve: DiskResolver;
  store: MediaStore;
  imageProcessor?: ImageProcessor;
  collections?: MediaCollectionConfig[];
  attachmentKeyPrefix?: string;
  emitDiagnostics?: boolean;
  /** Default upload mode for direct-S3 uploads (`auto`/`proxy`/`direct`). Default `auto`. */
  uploadMode?: UploadMode;
  /** Default multipart part size in bytes (direct mode). Default 8 MiB. */
  uploadPartSize?: number;
  /** Presigned part-URL TTL in seconds (direct mode). Default 3600. */
  uploadPresignTtlSeconds?: number;
  /**
   * Session store for resumable (TUS) uploads. When provided, `media.resumable` exposes a
   * {@link ResumableUploadManager}; when omitted, accessing `media.resumable` throws a helpful error.
   */
  uploadSessions?: UploadSessionStore;
  /** Prefix for temporary resumable chunk parts on the target disk. Default `.uploads`. */
  resumableTmpPrefix?: string;
  /** Resumable session lifetime in seconds (TUS `expiration`). Omit for never-expiring sessions. */
  resumableSessionTtlSeconds?: number;
  /** Default read strategy (`auto`/`public`/`signed`/`proxy`) for `library.deliver`. Default `auto`. */
  deliveryMode?: DeliveryMode;
  /** Signed-URL lifetime in seconds when delivery resolves to `signed`. Default 300. */
  deliverySignedTtlSeconds?: number;
}

/**
 * The singleton bound into the AdonisJS container as `MediaManager`. Composes the two layers over a
 * shared {@link StorageManager}: {@link MediaLibrary} (owner collections + conversions) and
 * {@link AttachmentManager} (column attachments).
 *
 * ```ts
 * const media = await app.container.make(MediaManager)
 * await media.library.attach({ ownerType: 'Post', ownerId: '1', collection: 'gallery', ... })
 * const att = await media.attachments.createFromFile({ fileName, mimeType, contents })
 * ```
 */
export class MediaManager {
  readonly storage: StorageManager;
  readonly library: MediaLibrary;
  readonly attachments: AttachmentManager;
  /**
   * The configured persistence SPI. Exposed for management/console reads (e.g. the cross-owner
   * {@link MediaStore.list}); day-to-day writes go through {@link MediaManager.library}.
   */
  readonly store: MediaStore;
  /** Direct-S3 upload coordinator (proxy + direct multipart modes). */
  readonly uploads: UploadManager;
  /** Resumable (TUS) upload coordinator — present only when a session store is configured. */
  readonly #resumable: ResumableUploadManager | undefined;

  constructor(options: MediaManagerOptions) {
    this.store = options.store;
    this.storage = new StorageManager({ default: options.defaultDisk, resolve: options.resolve });
    this.library = new MediaLibrary({
      storage: this.storage,
      store: options.store,
      ...(options.collections !== undefined ? { collections: options.collections } : {}),
      ...(options.imageProcessor !== undefined ? { imageProcessor: options.imageProcessor } : {}),
      ...(options.emitDiagnostics !== undefined
        ? { emitDiagnostics: options.emitDiagnostics }
        : {}),
      ...(options.deliveryMode !== undefined ? { deliveryMode: options.deliveryMode } : {}),
      ...(options.deliverySignedTtlSeconds !== undefined
        ? { deliverySignedTtlSeconds: options.deliverySignedTtlSeconds }
        : {}),
    });
    this.attachments = new AttachmentManager({
      storage: this.storage,
      ...(options.imageProcessor !== undefined ? { imageProcessor: options.imageProcessor } : {}),
      ...(options.attachmentKeyPrefix !== undefined
        ? { keyPrefix: options.attachmentKeyPrefix }
        : {}),
      ...(options.emitDiagnostics !== undefined
        ? { emitDiagnostics: options.emitDiagnostics }
        : {}),
    });
    this.uploads = new UploadManager({
      storage: this.storage,
      ...(options.uploadMode !== undefined ? { mode: options.uploadMode } : {}),
      ...(options.uploadPartSize !== undefined ? { partSize: options.uploadPartSize } : {}),
      ...(options.uploadPresignTtlSeconds !== undefined
        ? { presignTtlSeconds: options.uploadPresignTtlSeconds }
        : {}),
      ...(options.emitDiagnostics !== undefined
        ? { emitDiagnostics: options.emitDiagnostics }
        : {}),
    });
    if (options.uploadSessions !== undefined) {
      this.#resumable = new ResumableUploadManager({
        storage: this.storage,
        sessions: options.uploadSessions,
        ...(options.resumableTmpPrefix !== undefined
          ? { tmpPrefix: options.resumableTmpPrefix }
          : {}),
        ...(options.resumableSessionTtlSeconds !== undefined
          ? { sessionTtlSeconds: options.resumableSessionTtlSeconds }
          : {}),
        ...(options.emitDiagnostics !== undefined
          ? { emitDiagnostics: options.emitDiagnostics }
          : {}),
      });
    }
  }

  /**
   * The resumable (TUS) upload coordinator. Throws {@link ResumableUploadsNotConfiguredError} unless
   * a session store was configured via `uploads.resumable` in `config/media.ts`.
   */
  get resumable(): ResumableUploadManager {
    if (!this.#resumable) throw new ResumableUploadsNotConfiguredError();
    return this.#resumable;
  }

  /**
   * Finish a resumable (TUS) upload and register the assembled object as a media record, in one
   * step and without ever reading the uploaded bytes back: `resumable.complete()` returns the final
   * `{ key, disk, size }`, which {@link MediaLibrary.attachExisting} adopts as-is.
   *
   * This lives here because the two layers meet only at the manager — {@link ResumableUploadManager}
   * knows nothing of the library. It is opt-in: {@link resumable}'s `complete()` stays the raw
   * primitive for uploads that should NOT become library assets.
   *
   * ```ts
   * await media.completeUploadToLibrary(sessionId, {
   *   ownerType: 'Post', ownerId: post.id, collection: 'gallery',
   *   fileName: 'scan.pdf', mimeType: 'application/pdf',
   * })
   * ```
   */
  async completeUploadToLibrary(
    sessionId: string,
    input: Omit<AttachExistingInput, 'key' | 'disk' | 'size'>,
  ): Promise<MediaRecord> {
    const { key, disk, size } = await this.resumable.complete(sessionId);
    return this.library.attachExisting({ ...input, key, disk, size });
  }

  /**
   * The registered collection configs — the single source of truth for `acceptsMimeTypes`. Exposed
   * so the upload edge (`TusUploadHandler`) can enforce the very same whitelist the library will
   * enforce at attach time, without the app restating it.
   */
  get collections(): MediaCollectionRegistry {
    return this.library.collections;
  }

  /** Whether resumable (TUS) uploads are configured (a session store is present). */
  get hasResumable(): boolean {
    return this.#resumable !== undefined;
  }

  /** Resolve a raw disk by name (escape hatch to the underlying Drive disk). */
  disk(name?: string) {
    return this.storage.disk(name);
  }

  /** Begin a direct-S3 multipart upload — returns presigned part URLs for the client. */
  initiateDirectUpload(input: InitiateDirectUploadInput): Promise<DirectUploadCreated> {
    return this.uploads.initiateDirect(input);
  }

  /** Assemble the client-uploaded parts into the final object. */
  completeDirectUpload(input: CompleteDirectUploadInput): Promise<{ key: string; disk: string }> {
    return this.uploads.completeDirect(input);
  }

  /** Abort an in-flight direct-S3 multipart upload. */
  abortDirectUpload(input: AbortDirectUploadInput): Promise<void> {
    return this.uploads.abortDirect(input);
  }

  /** Proxy upload: stream bytes through the app to the disk (works on any disk). */
  proxyUpload(input: ProxyUploadInput): Promise<{ key: string; disk: string }> {
    return this.uploads.proxyUpload(input);
  }
}
