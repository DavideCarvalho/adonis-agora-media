import { AttachmentManager } from './attachment.js';
import type { ImageProcessor } from './image_processor.js';
import type { MediaCollectionConfig } from './media_collection.js';
import { MediaLibrary } from './media_library.js';
import type { MediaStore } from './media_store.js';
import { StorageManager } from './storage_manager.js';
import type { DiskResolver } from './types.js';
import type { UploadMode } from './upload_mode.js';
import {
  type AbortDirectUploadInput,
  type CompleteDirectUploadInput,
  type DirectUploadCreated,
  type InitiateDirectUploadInput,
  type ProxyUploadInput,
  UploadManager,
} from './upload_manager.js';

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
  /** Direct-S3 upload coordinator (proxy + direct multipart modes). */
  readonly uploads: UploadManager;

  constructor(options: MediaManagerOptions) {
    this.storage = new StorageManager({ default: options.defaultDisk, resolve: options.resolve });
    this.library = new MediaLibrary({
      storage: this.storage,
      store: options.store,
      ...(options.collections !== undefined ? { collections: options.collections } : {}),
      ...(options.imageProcessor !== undefined ? { imageProcessor: options.imageProcessor } : {}),
      ...(options.emitDiagnostics !== undefined
        ? { emitDiagnostics: options.emitDiagnostics }
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
