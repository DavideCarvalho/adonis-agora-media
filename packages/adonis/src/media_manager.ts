import { AttachmentManager } from './attachment.js';
import type { ImageProcessor } from './image_processor.js';
import type { MediaCollectionConfig } from './media_collection.js';
import { MediaLibrary } from './media_library.js';
import type { MediaStore } from './media_store.js';
import { StorageManager } from './storage_manager.js';
import type { DiskResolver } from './types.js';

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
  }

  /** Resolve a raw disk by name (escape hatch to the underlying Drive disk). */
  disk(name?: string) {
    return this.storage.disk(name);
  }
}
