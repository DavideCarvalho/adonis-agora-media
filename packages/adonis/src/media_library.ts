import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { asBuffer, toBytes } from './contents.js';
import { type MediaDiagnosticPayloads, publishMedia } from './diagnostics.js';
import {
  ConversionNotDefinedError,
  ImageProcessorMissingError,
  MediaNotFoundError,
  MimeNotAllowedError,
} from './errors.js';
import type { ImageProcessor } from './image_processor.js';
import { type MediaCollectionConfig, MediaCollectionRegistry } from './media_collection.js';
import type { MediaRecord } from './media_record.js';
import type { MediaStore } from './media_store.js';
import type { StorageManager } from './storage_manager.js';

export interface MediaLibraryOptions {
  storage: StorageManager;
  store: MediaStore;
  collections?: MediaCollectionConfig[];
  /** Engine for image conversions. Required only if collections define conversions. */
  imageProcessor?: ImageProcessor;
  /** Emit `agora:media:*` diagnostics events (default true). */
  emitDiagnostics?: boolean;
  /** Injectable for deterministic tests. Defaults to `randomUUID`. */
  idGenerator?: () => string;
  /** Injectable for deterministic tests. Defaults to `() => new Date()`. */
  clock?: () => Date;
}

export interface AttachInput {
  ownerType: string;
  ownerId: string;
  collection: string;
  fileName: string;
  mimeType: string;
  contents: Buffer | Readable;
  /** Known byte size; when omitted it is read back from the disk after writing. */
  size?: number;
  name?: string;
  customProperties?: Record<string, unknown>;
  /** Disk override (else collection disk, else storage default). */
  disk?: string;
}

/**
 * An owning entity bound to the library, so collection operations don't repeat
 * `ownerType`/`ownerId`. Obtained from {@link MediaLibrary.for}.
 */
export interface OwnerMediaBinding {
  attach(input: Omit<AttachInput, 'ownerType' | 'ownerId'>): Promise<MediaRecord>;
  list(collection?: string): Promise<MediaRecord[]>;
}

export class MediaLibrary {
  private readonly storage: StorageManager;
  private readonly store: MediaStore;
  private readonly collections: MediaCollectionRegistry;
  private readonly imageProcessor: ImageProcessor | undefined;
  private readonly emitDiagnostics: boolean;
  private readonly newId: () => string;
  private readonly now: () => Date;

  constructor(options: MediaLibraryOptions) {
    this.storage = options.storage;
    this.store = options.store;
    this.collections = new MediaCollectionRegistry(options.collections ?? []);
    this.imageProcessor = options.imageProcessor;
    this.emitDiagnostics = options.emitDiagnostics ?? true;
    this.newId = options.idGenerator ?? (() => randomUUID());
    this.now = options.clock ?? (() => new Date());
  }

  private emit<E extends 'attach' | 'delete' | 'conversion'>(
    event: E,
    payload: MediaDiagnosticPayloads[E],
  ): void {
    if (this.emitDiagnostics) publishMedia(event, payload);
  }

  async attach(input: AttachInput): Promise<MediaRecord> {
    const config = this.collections.get(input.collection);

    if (config.acceptsMimeTypes && !config.acceptsMimeTypes.includes(input.mimeType)) {
      throw new MimeNotAllowedError(input.collection, input.mimeType);
    }

    // A single-file collection replaces whatever is already there.
    if (config.single) {
      const existing = await this.store.listByOwner(
        input.ownerType,
        input.ownerId,
        input.collection,
      );
      for (const record of existing) await this.delete(record.id);
    }

    const disk = input.disk ?? config.disk ?? this.storage.defaultDisk;
    const id = this.newId();
    const path = `${input.ownerType}/${input.ownerId}/${input.collection}/${id}/${input.fileName}`;

    const bytes = await toBytes(input.contents);
    await this.storage.disk(disk).put(path, bytes, { contentType: input.mimeType });
    const size = input.size ?? (await this.storage.disk(disk).getMetaData(path)).contentLength;
    const order = await this.store.nextOrder(input.ownerType, input.ownerId, input.collection);
    const timestamp = this.now();

    const saved = await this.store.save({
      id,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      collection: input.collection,
      name: input.name ?? stripExtension(input.fileName),
      fileName: input.fileName,
      mimeType: input.mimeType,
      size,
      disk,
      path,
      order,
      customProperties: input.customProperties ?? {},
      conversions: {},
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    this.emit('attach', {
      id: saved.id,
      ownerType: saved.ownerType,
      ownerId: saved.ownerId,
      collection: saved.collection,
      disk: saved.disk,
      path: saved.path,
      size: saved.size,
      mimeType: saved.mimeType,
    });

    // Eager presets are generated synchronously on attach; lazy ones on first `url()`.
    const eager = (config.conversions ?? []).filter((p) => p.eager);
    if (eager.length === 0) return saved;
    let current = saved;
    for (const preset of eager) current = await this.ensureConversion(saved.id, preset.name);
    return current;
  }

  /** Generate (if absent) and persist a named conversion; returns the updated record. Lazy entry point. */
  async ensureConversion(id: string, conversionName: string): Promise<MediaRecord> {
    const record = await this.store.find(id);
    if (!record) throw new MediaNotFoundError(id);
    if (record.conversions[conversionName]) return record;

    const preset = (this.collections.get(record.collection).conversions ?? []).find(
      (p) => p.name === conversionName,
    );
    if (!preset) throw new ConversionNotDefinedError(record.collection, conversionName);
    if (!this.imageProcessor) throw new ImageProcessorMissingError();

    const original = asBuffer(await this.storage.disk(record.disk).getBytes(record.path));
    const result = await this.imageProcessor.convert(original, preset);
    const dir = record.path.slice(0, record.path.lastIndexOf('/'));
    const conversionPath = `${dir}/conversions/${conversionName}.${result.format}`;
    await this.storage.disk(record.disk).put(conversionPath, result.data, {
      contentType: result.contentType,
    });

    const updated = await this.store.save({
      ...record,
      conversions: {
        ...record.conversions,
        [conversionName]: { path: conversionPath, disk: record.disk },
      },
      updatedAt: this.now(),
    });
    this.emit('conversion', { id, conversion: conversionName, path: conversionPath });
    return updated;
  }

  list(ownerType: string, ownerId: string, collection?: string): Promise<MediaRecord[]> {
    return this.store.listByOwner(ownerType, ownerId, collection);
  }

  find(id: string): Promise<MediaRecord | null> {
    return this.store.find(id);
  }

  /**
   * Bind an owning entity so collection operations don't repeat its type/id:
   * `const m = media.library.for('Post', post.id); await m.attach({ collection, ... })`.
   */
  for(ownerType: string, ownerId: string | number): OwnerMediaBinding {
    const ownerId_ = String(ownerId);
    return {
      attach: (input) => this.attach({ ...input, ownerType, ownerId: ownerId_ }),
      list: (collection) => this.list(ownerType, ownerId_, collection),
    };
  }

  async delete(id: string): Promise<void> {
    const record = await this.store.find(id);
    if (!record) return;
    await this.storage.disk(record.disk).delete(record.path);
    for (const conversion of Object.values(record.conversions)) {
      await this.storage.disk(conversion.disk).delete(conversion.path);
    }
    await this.store.delete(id);
    this.emit('delete', { id, ownerType: record.ownerType, ownerId: record.ownerId });
  }

  /**
   * Public URL for a media record or one of its conversions. When a conversion is
   * requested and not yet generated, it is produced lazily (and cached) first.
   */
  async url(id: string, conversion?: string): Promise<string> {
    if (conversion) {
      const record = await this.ensureConversion(id, conversion);
      const variant = record.conversions[conversion];
      if (!variant) throw new MediaNotFoundError(`${id}#${conversion}`);
      return this.storage.disk(variant.disk).getUrl(variant.path);
    }
    const record = await this.store.find(id);
    if (!record) throw new MediaNotFoundError(id);
    return this.storage.disk(record.disk).getUrl(record.path);
  }

  /** Signed, expiring URL for a media record or one of its conversions. */
  async signedUrl(id: string, expiresIn: string | number, conversion?: string): Promise<string> {
    if (conversion) {
      const record = await this.ensureConversion(id, conversion);
      const variant = record.conversions[conversion];
      if (!variant) throw new MediaNotFoundError(`${id}#${conversion}`);
      return this.storage.disk(variant.disk).getSignedUrl(variant.path, { expiresIn });
    }
    const record = await this.store.find(id);
    if (!record) throw new MediaNotFoundError(id);
    return this.storage.disk(record.disk).getSignedUrl(record.path, { expiresIn });
  }
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}
