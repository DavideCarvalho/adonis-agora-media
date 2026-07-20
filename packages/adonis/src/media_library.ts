import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { asBuffer, toBytes } from './contents.js';
import { type MediaDiagnosticPayloads, publishMedia } from './diagnostics.js';
import {
  ConversionNotDefinedError,
  ImageProcessorMissingError,
  MediaNotFoundError,
  MediaObjectMissingError,
  MimeNotAllowedError,
  UploadNotSupportedError,
} from './errors.js';
import { isExtendedDisk } from './extended_disk.js';
import type { ImageProcessor } from './image_processor.js';
import { type MediaCollectionConfig, MediaCollectionRegistry } from './media_collection.js';
import type { MediaRecord } from './media_record.js';
import type { MediaStore } from './media_store.js';
import type { StorageManager } from './storage_manager.js';
import type { Disk, SignedUrlOptions } from './types.js';

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
  /** Owner primary key; a numeric Lucid id is accepted and coerced to a string internally. */
  ownerId: string | number;
  collection: string;
  /**
   * Deterministic id segment for the storage key, replacing the generated UUID. Use for
   * idempotent overwrites (e.g. a durable step that re-renders the same file): a fixed id
   * yields a fixed key that the disk overwrites on retry, instead of orphaning the prior
   * object under a fresh UUID.
   */
  id?: string;
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
 * Input for {@link MediaLibrary.attachExisting} — the same descriptors as {@link AttachInput}, but
 * pointing at an object that ALREADY lives on the disk (`key`) instead of carrying its `contents`.
 */
export interface AttachExistingInput {
  ownerType: string;
  /** Owner primary key; a numeric Lucid id is accepted and coerced to a string internally. */
  ownerId: string | number;
  collection: string;
  /**
   * Object key that already exists on the disk (e.g. what `resumable.complete()` returned). Its
   * bytes are never read or rewritten — the record simply points at it.
   */
  key: string;
  /** Disk holding {@link key} (else collection disk, else storage default). */
  disk?: string;
  fileName: string;
  mimeType: string;
  /** Known byte size; when omitted it is read from the disk's metadata (a HEAD, not a download). */
  size?: number;
  /** Deterministic id segment, as in {@link AttachInput.id}. Defaults to a generated UUID. */
  id?: string;
  name?: string;
  customProperties?: Record<string, unknown>;
  /**
   * Server-side move the object into the library's canonical layout
   * (`ownerType/ownerId/collection/id/fileName`) instead of registering it where it landed.
   * Default `false` — registering in place is free, while a move costs a backend copy.
   *
   * Requires a disk implementing the {@link ExtendedDisk} surface (its native, server-side
   * `move`); the bytes are NEVER streamed through the app to emulate one. Throws
   * {@link UploadNotSupportedError} on a disk without it.
   */
  moveIntoLayout?: boolean;
}

/** Options for {@link MediaLibrary.signedUrl}: the disk's response headers, plus a conversion to sign instead of the original. */
export interface MediaSignedUrlOptions extends Omit<SignedUrlOptions, 'expiresIn'> {
  /** Sign this named conversion instead of the original (generated lazily if absent). */
  conversion?: string;
}

/**
 * An owning entity bound to the library, so collection operations don't repeat
 * `ownerType`/`ownerId`. Obtained from {@link MediaLibrary.for}.
 */
export interface OwnerMediaBinding {
  attach(input: Omit<AttachInput, 'ownerType' | 'ownerId'>): Promise<MediaRecord>;
  attachExisting(input: Omit<AttachExistingInput, 'ownerType' | 'ownerId'>): Promise<MediaRecord>;
  list(collection?: string): Promise<MediaRecord[]>;
}

/** What {@link MediaLibrary.#prepare} resolves once, for both attach paths. */
interface AttachContext {
  config: MediaCollectionConfig;
  ownerId: string;
  /** Records a `single: true` collection will replace, captured before the new object lands. */
  previous: MediaRecord[];
  disk: string;
  target: Disk;
  id: string;
}

/** Record descriptors {@link MediaLibrary.#commit} persists, once the object is in place. */
interface CommitInput {
  ownerType: string;
  collection: string;
  fileName: string;
  mimeType: string;
  size?: number | undefined;
  name?: string | undefined;
  customProperties?: Record<string, unknown> | undefined;
  /** Final key of the stored object. */
  path: string;
  /** Whether this call put the object there — i.e. whether compensation may delete it. */
  ownsObject: boolean;
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
    const context = await this.#prepare(input);
    const { config, ownerId, disk, id, target } = context;
    const path = this.#layoutPath(input.ownerType, ownerId, input.collection, id, input.fileName);
    const hasConversions = (config.conversions ?? []).length > 0;

    // Stream large uploads straight through (no in-memory buffer) when we can: a Readable with a
    // known size, no conversions to generate off the buffered bytes, and a disk that supports it.
    const canStream =
      !Buffer.isBuffer(input.contents) &&
      input.size !== undefined &&
      !hasConversions &&
      typeof target.putStream === 'function';
    if (canStream) {
      // `input.size` is forwarded, not dropped: it is the very thing that makes this path
      // eligible (see `canStream`), and S3's putStream cannot write without it.
      await target.putStream?.(path, input.contents as Readable, {
        contentType: input.mimeType,
        contentLength: input.size as number,
      });
    } else {
      const bytes = await toBytes(input.contents);
      await target.put(path, bytes, { contentType: input.mimeType });
    }

    return this.#commit(context, { ...input, path, ownsObject: true });
  }

  /**
   * Register an object that ALREADY exists on the disk as a media record — zero-copy: its bytes are
   * never read back or rewritten, only its metadata is inspected. The bridge for uploads that land
   * on the disk on their own (`media.resumable` / TUS, direct-S3), where round-tripping the bytes
   * through {@link attach} would defeat the point of a resumable upload.
   *
   * Everything after storage behaves exactly as {@link attach}: collection resolution,
   * `acceptsMimeTypes`, atomic `single: true` replace, ordering, eager conversions and diagnostics.
   *
   * ```ts
   * const { key, disk, size } = await media.resumable.complete(sessionId)
   * await media.library.attachExisting({
   *   ownerType: 'Post', ownerId: post.id, collection: 'gallery',
   *   key, disk, size, fileName: 'scan.pdf', mimeType: 'application/pdf',
   * })
   * ```
   *
   * Unlike {@link attach}, a failure downstream of the object does NOT delete it: the caller wrote
   * those bytes and may retry with them, so only what this call created is rolled back.
   */
  async attachExisting(input: AttachExistingInput): Promise<MediaRecord> {
    const context = await this.#prepare(input);
    const { ownerId, disk, id, target } = context;

    if (!(await target.exists(input.key))) {
      throw new MediaObjectMissingError(disk, input.key);
    }

    let path = input.key;
    const layout = this.#layoutPath(input.ownerType, ownerId, input.collection, id, input.fileName);
    if (input.moveIntoLayout && path !== layout) {
      // Server-side only. There is deliberately no fallback that reads and re-writes the bytes:
      // that is precisely the copy this method exists to avoid.
      if (!isExtendedDisk(target)) throw new UploadNotSupportedError(disk, 'server-side move');
      await target.move(path, layout);
      path = layout;
    }

    return this.#commit(context, { ...input, path, ownsObject: input.moveIntoLayout === true });
  }

  /** Storage key layout every record written by this library follows. */
  #layoutPath(
    ownerType: string,
    ownerId: string,
    collection: string,
    id: string,
    fileName: string,
  ): string {
    return `${ownerType}/${ownerId}/${collection}/${id}/${fileName}`;
  }

  /**
   * Everything both attach paths do BEFORE the object exists: resolve the collection, enforce its
   * MIME whitelist, capture the records a `single: true` collection will replace, and pick the disk
   * and record id.
   *
   * A single-file collection replaces whatever is already there — but only once the new media is
   * stored, persisted AND renderable, so anything that fails on the way leaves the old media intact.
   * Hence "capture up front, drop at the end" (see {@link #commit}).
   */
  async #prepare(input: {
    ownerType: string;
    ownerId: string | number;
    collection: string;
    mimeType: string;
    disk?: string | undefined;
    id?: string | undefined;
  }): Promise<AttachContext> {
    const config = this.collections.get(input.collection);
    const ownerId = String(input.ownerId);

    if (config.acceptsMimeTypes && !config.acceptsMimeTypes.includes(input.mimeType)) {
      throw new MimeNotAllowedError(input.collection, input.mimeType);
    }

    const previous = config.single
      ? await this.store.listByOwner(input.ownerType, ownerId, input.collection)
      : [];
    const disk = input.disk ?? config.disk ?? this.storage.defaultDisk;

    return {
      config,
      ownerId,
      previous,
      disk,
      target: this.storage.disk(disk),
      id: input.id ?? this.newId(),
    };
  }

  /**
   * Everything both attach paths do AFTER the object is in place: persist the record, generate eager
   * conversions, drop what a `single: true` collection replaced, and emit `attach`. Compensates on
   * failure — dropping the object itself only when `ownsObject` says this call put it there.
   */
  async #commit(context: AttachContext, input: CommitInput): Promise<MediaRecord> {
    const { config, ownerId, previous, disk, id, target } = context;
    const { path } = input;

    let saved: MediaRecord;
    try {
      // `getMetaData` is a HEAD-shaped metadata read, never a body download — the zero-copy
      // guarantee of `attachExisting` holds even when the caller omits `size`.
      const size = input.size ?? (await target.getMetaData(path)).contentLength;
      // A single-file collection holds exactly one item, so its order resets to 0 on replace.
      const order = config.single
        ? 0
        : await this.store.nextOrder(input.ownerType, ownerId, input.collection);
      const timestamp = this.now();

      saved = await this.store.save({
        id,
        ownerType: input.ownerType,
        ownerId,
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
    } catch (error) {
      // Compensation (disk + store aren't a single transaction): the bytes landed but the record
      // didn't persist — best-effort remove the orphaned object before rethrowing.
      if (input.ownsObject) await this.#safeDelete(disk, path);
      throw error;
    }

    // Eager presets are generated synchronously on attach; lazy ones on first `url()`. This runs
    // BEFORE `previous` is dropped: a preset that throws must not leave the owner with nothing.
    const eager = (config.conversions ?? []).filter((p) => p.eager);
    let current = saved;
    if (eager.length > 0) {
      try {
        for (const preset of eager) current = await this.ensureConversion(saved.id, preset.name);
      } catch (error) {
        // The new media can't be rendered, so roll it back whole — bytes, any conversions already
        // written, and the row — and leave what it was replacing untouched.
        if (input.ownsObject) await this.#safeDelete(disk, path);
        for (const variant of Object.values(current.conversions)) {
          await this.#safeDelete(variant.disk, variant.path);
        }
        await this.store.delete(saved.id);
        throw error;
      }
    }

    // The new media is committed and renderable; only now is it safe to drop what it replaced. A
    // replaced record can overlap the new one — the store row when the caller reused `id`, the disk
    // object when the same key is re-registered — and cleaning up an overlap would destroy the media
    // just committed, so each half is dropped only where it is genuinely superseded.
    for (const record of previous) {
      const sharesObject = record.disk === disk && record.path === path;
      const sharesRow = record.id === id;
      if (sharesObject && sharesRow) continue;
      if (sharesObject) {
        await this.store.delete(record.id);
        continue;
      }
      if (sharesRow) {
        await this.#safeDelete(record.disk, record.path);
        for (const variant of Object.values(record.conversions)) {
          await this.#safeDelete(variant.disk, variant.path);
        }
        continue;
      }
      await this.#deleteRecord(record);
    }

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

  list(ownerType: string, ownerId: string | number, collection?: string): Promise<MediaRecord[]> {
    return this.store.listByOwner(ownerType, String(ownerId), collection);
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
      attachExisting: (input) => this.attachExisting({ ...input, ownerType, ownerId: ownerId_ }),
      list: (collection) => this.list(ownerType, ownerId_, collection),
    };
  }

  async delete(id: string): Promise<void> {
    const record = await this.store.find(id);
    if (!record) return;
    await this.#deleteRecord(record);
  }

  /** Remove a record we already hold (disk bytes + conversions + store row) and emit `delete`. */
  async #deleteRecord(record: MediaRecord): Promise<void> {
    await this.storage.disk(record.disk).delete(record.path);
    for (const conversion of Object.values(record.conversions)) {
      await this.storage.disk(conversion.disk).delete(conversion.path);
    }
    await this.store.delete(record.id);
    this.emit('delete', {
      id: record.id,
      ownerType: record.ownerType,
      ownerId: record.ownerId,
    });
  }

  /** Best-effort disk cleanup for the orphan-compensation path; never masks the original error. */
  async #safeDelete(disk: string, path: string): Promise<void> {
    try {
      await this.storage.disk(disk).delete(path);
    } catch {
      // swallow: this is compensation for a failed write; the original error is what matters
    }
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

  /**
   * Signed, expiring URL for a media record or one of its conversions.
   *
   * Everything in `options` except `conversion` is a response header the presigner bakes into
   * the URL, so it applies to whoever follows the link rather than to this call:
   * `contentDisposition` is what forces a download with a chosen file name.
   */
  async signedUrl(
    id: string,
    expiresIn: string | number,
    options: MediaSignedUrlOptions = {},
  ): Promise<string> {
    const { conversion, ...responseOptions } = options;
    const signOptions: SignedUrlOptions = { expiresIn, ...responseOptions };

    if (conversion) {
      const record = await this.ensureConversion(id, conversion);
      const variant = record.conversions[conversion];
      if (!variant) throw new MediaNotFoundError(`${id}#${conversion}`);
      return this.storage.disk(variant.disk).getSignedUrl(variant.path, signOptions);
    }
    const record = await this.store.find(id);
    if (!record) throw new MediaNotFoundError(id);
    return this.storage.disk(record.disk).getSignedUrl(record.path, signOptions);
  }
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}
