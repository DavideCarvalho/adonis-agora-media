import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { SIGNATURE_HEAD_BYTES, verifyContentAgainstWhitelist } from './content_type.js';
import { asBuffer, peekContents, peekStream, toBytes } from './contents.js';
import {
  DEFAULT_DELIVERY_SIGNED_TTL_SECONDS,
  DEFAULT_IMAGE_QUALITIES,
  DEFAULT_IMAGE_WIDTHS,
  type DeliveryMode,
  type DeliveryResult,
  type OnDemandImageConfig,
  resolveDeliveryMode,
} from './delivery.js';
import {
  DEFAULT_DELIVERY_SIGNING_TTL_SECONDS,
  type DeliverySigningConfig,
  deliveryExpiry,
  deliveryQueryString,
  signDelivery,
  verifyDelivery,
} from './delivery_signing.js';
import { type MediaDiagnosticPayloads, publishMedia } from './diagnostics.js';
import {
  ContentSignatureUnrecognizedError,
  ContentTypeMismatchError,
  ConversionArtifactMissingError,
  ConversionNotDefinedError,
  DeliverySignatureError,
  ImageProcessorMissingError,
  ImageSizeNotAllowedError,
  MediaNotFoundError,
  MediaObjectMissingError,
  MimeNotAllowedError,
  NotAnImageError,
  TransformerNotDefinedError,
  TransformerOutputError,
  TransformNotReadyError,
  UploadNotSupportedError,
} from './errors.js';
import { isExtendedDisk } from './extended_disk.js';
import { sanitizeFileName } from './file_name.js';
import {
  type ConversionPreset,
  type FocalPoint,
  focalPointOf,
  type ImageProcessor,
  presetCrops,
} from './image_processor.js';
import { type MediaCollectionConfig, MediaCollectionRegistry } from './media_collection.js';
import type { MediaConversion, MediaRecord } from './media_record.js';
import type { MediaStore } from './media_store.js';
import { resolveDeclaredMimeType } from './mime_type.js';
import {
  BROWSER_IMAGE_TYPES,
  imageCandidates,
  type ResponsiveImage,
  type ResponsiveImageOptions,
} from './responsive_image.js';
import type { StorageManager } from './storage_manager.js';
import {
  DASH_MIME_TYPE,
  HLS_MIME_TYPE,
  type MediaStream,
  type MediaStreamSource,
  signManifest,
  streamArtifactContentType,
  streamEntries,
  streamFormatOf,
} from './streaming.js';
import type {
  Transformer,
  TransformerContext,
  TransformerWriteOptions,
  TransformResult,
} from './transformer.js';
import { placeholderOf } from './transformers/placeholder.js';
import type { Disk, SignedUrlOptions } from './types.js';

export interface MediaLibraryOptions {
  storage: StorageManager;
  store: MediaStore;
  collections?: readonly MediaCollectionConfig[];
  /** Engine for image conversions. Required only if collections define conversions. */
  imageProcessor?: ImageProcessor;
  /** Emit `agora:media:*` diagnostics events (default true). */
  emitDiagnostics?: boolean;
  /** Injectable for deterministic tests. Defaults to `randomUUID`. */
  idGenerator?: () => string;
  /** Injectable for deterministic tests. Defaults to `() => new Date()`. */
  clock?: () => Date;
  /** Default read strategy for {@link MediaLibrary.deliver} (`delivery.mode`). Default `auto`. */
  deliveryMode?: DeliveryMode;
  /** Signed-URL lifetime when delivery resolves to `signed`. Default 300s. */
  deliverySignedTtlSeconds?: number;
  /** On-demand resizing for `deliver(id, { width })` (`delivery.images`). */
  deliveryImages?: OnDemandImageConfig;
  /** Signed delivery URLs (`delivery.signing`). */
  deliverySigning?: DeliverySigningConfig;
  /** Route the app mounts `MediaDeliveryHandler` on, with `:id` (`delivery.path`). Default `/media/:id`. */
  deliveryPath?: string;
  /**
   * Route the app mounts `media.access.streamRoute()` on, with `:id` and `:conversion`, WITHOUT
   * the trailing file part (`delivery.streamPath`). Default `/media/:id/stream/:conversion`.
   */
  deliveryStreamPath?: string;
}

/** What serving one file of a streaming package yields: a manifest's text, or the usual delivery. */
export type StreamFileResult =
  | { kind: 'manifest'; content: string; contentType: string; fileName: string }
  | DeliveryResult;

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

/** Options for {@link MediaLibrary.deliver}. */
export interface DeliverOptions {
  /** Deliver this named conversion instead of the original (generated lazily if absent). */
  conversion?: string | undefined;
  /** Override the configured `delivery.mode` for this call. */
  mode?: DeliveryMode | undefined;
  /** Override the configured signed-URL lifetime, when the resolved mode is `signed`. */
  signedTtlSeconds?: number | undefined;
  /**
   * Deliver the image resized to this width (see {@link MediaLibrary.resized}). Wins over
   * `conversion`. Strings (a query-string value) are parsed and validated.
   */
  width?: number | string | undefined;
  /** Quality of the resized image; defaults to the first of `delivery.images.qualities`. */
  quality?: number | string | undefined;
  /** The request's `Accept` header, to negotiate the resized image's format. */
  accept?: string | undefined;
  /**
   * The request was authorized by a valid delivery signature (`MediaDeliveryHandler` sets this):
   * any `width`/`quality` is served, not just the `delivery.images` whitelist — the app chose it.
   */
  trusted?: boolean | undefined;
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
  /**
   * MIME type the record will carry. Usually the declared type; when that is generic/truncated
   * (a bare top-level type like `"text"`) or not whitelisted, it is normalized from the file
   * extension — see {@link resolveDeclaredMimeType}. Still gated by the collection whitelist.
   */
  mimeType: string;
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
  /**
   * The storage façade the library resolves disks through. Public (read-only) so delivery
   * composition — {@link HlsDeliveryHandler} serving individual package artifacts, custom handlers
   * doing the same — can reach the disk of a record it already holds without re-plumbing a
   * resolver. Writes still belong to the library's own methods.
   */
  readonly storage: StorageManager;
  private readonly store: MediaStore;
  /**
   * Registered collection configs. Public because `acceptsMimeTypes` must have exactly one source
   * of truth: the TUS handler enforces the same whitelist at upload time by reading it from here,
   * rather than the app restating the list next to its routes.
   */
  readonly collections: MediaCollectionRegistry;
  private readonly imageProcessor: ImageProcessor | undefined;
  private readonly emitDiagnostics: boolean;
  private readonly newId: () => string;
  private readonly now: () => Date;
  private readonly deliveryMode: DeliveryMode;
  private readonly deliverySignedTtlSeconds: number;
  private readonly deliveryImages: Required<OnDemandImageConfig>;
  private readonly deliverySigning: DeliverySigningConfig | undefined;
  private readonly deliveryPath: string;
  private readonly deliveryStreamPath: string;

  constructor(options: MediaLibraryOptions) {
    this.storage = options.storage;
    this.store = options.store;
    this.collections = new MediaCollectionRegistry(options.collections ?? []);
    this.imageProcessor = options.imageProcessor;
    this.emitDiagnostics = options.emitDiagnostics ?? true;
    this.newId = options.idGenerator ?? (() => randomUUID());
    this.now = options.clock ?? (() => new Date());
    this.deliveryMode = options.deliveryMode ?? 'auto';
    this.deliverySignedTtlSeconds =
      options.deliverySignedTtlSeconds ?? DEFAULT_DELIVERY_SIGNED_TTL_SECONDS;
    this.deliveryImages = {
      widths: options.deliveryImages?.widths ?? DEFAULT_IMAGE_WIDTHS,
      qualities: options.deliveryImages?.qualities ?? DEFAULT_IMAGE_QUALITIES,
      formats: options.deliveryImages?.formats ?? ['webp'],
    };
    this.deliverySigning = options.deliverySigning;
    this.deliveryPath = options.deliveryPath ?? '/media/:id';
    this.deliveryStreamPath = options.deliveryStreamPath ?? '/media/:id/stream/:conversion';
  }

  private emit<E extends 'attach' | 'delete' | 'conversion'>(
    event: E,
    payload: MediaDiagnosticPayloads[E],
  ): void {
    if (this.emitDiagnostics) publishMedia(event, payload);
  }

  async attach(input: AttachInput): Promise<MediaRecord> {
    const context = await this.#prepare(input);
    const { config, ownerId, disk, id, target, mimeType } = context;
    const path = this.#layoutPath(input.ownerType, ownerId, input.collection, id, input.fileName);
    const hasConversions = (config.conversions ?? []).length > 0;

    // Prove the bytes are what the caller claims BEFORE writing them. Peeking replays the head, so
    // the payload below is still whole — and a `Readable` is still a stream.
    let contents = input.contents;
    if (config.acceptsMimeTypes) {
      const peeked = await peekContents(input.contents, SIGNATURE_HEAD_BYTES);
      contents = peeked.contents;
      this.#assertContentMatches(config.acceptsMimeTypes, input.collection, mimeType, peeked.head);
    }

    // Stream large uploads straight through (no in-memory buffer) when we can: a Readable with a
    // known size, no conversions to generate off the buffered bytes, and a disk that supports it.
    const canStream =
      !Buffer.isBuffer(contents) &&
      input.size !== undefined &&
      !hasConversions &&
      typeof target.putStream === 'function';
    if (canStream) {
      // `input.size` is forwarded, not dropped: it is the very thing that makes this path
      // eligible (see `canStream`), and S3's putStream cannot write without it.
      await target.putStream?.(path, contents as Readable, {
        contentType: mimeType,
        contentLength: input.size as number,
      });
    } else {
      const bytes = await toBytes(contents);
      await target.put(path, bytes, { contentType: mimeType });
    }

    return this.#commit(context, { ...input, mimeType, path, ownsObject: true });
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
    const { ownerId, disk, id, target, mimeType } = context;

    if (!(await target.exists(input.key))) {
      throw new MediaObjectMissingError(disk, input.key);
    }

    // Validate the REAL content of an object we never wrote. `peekStream` tears the stream down
    // after the signature, so this stays a short head read — never the download `attachExisting`
    // exists to avoid.
    if (context.config.acceptsMimeTypes) {
      const head = await peekStream(await target.getStream(input.key), SIGNATURE_HEAD_BYTES);
      this.#assertContentMatches(context.config.acceptsMimeTypes, input.collection, mimeType, head);
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

    return this.#commit(context, {
      ...input,
      mimeType,
      path,
      ownsObject: input.moveIntoLayout === true,
    });
  }

  /**
   * Enforce `acceptsMimeTypes` against what the bytes ACTUALLY are, not what the caller declared.
   * The declared type is written by the app — routinely a hardcoded constant — so checking it alone
   * (as `#prepare` does, cheaply and first) whitelists nothing about the content itself.
   *
   * Outcomes, given the leading bytes (the decision itself lives in
   * {@link verifyContentAgainstWhitelist}, shared with the TUS handler):
   * - a signature matches and agrees with the declared type → accept.
   * - a signature matches and the collection does not accept it, or it contradicts the declared
   *   type → reject with {@link ContentTypeMismatchError}. A PNG announced as `application/pdf` is
   *   a lie whether or not PNG is on the list, and a record whose `mimeType` misdescribes its bytes
   *   poisons every downstream consumer (conversions, `Content-Type` on delivery).
   * - no signature matches, and every accepted type IS signature-detectable (a closed whitelist) →
   *   reject with {@link ContentSignatureUnrecognizedError}: the content is provably none of them.
   * - no signature matches, and some accepted type has no signature (SVG, CSV, text, office
   *   formats) → *unknown*, not invalid. Rejecting would break those legitimate types, so the
   *   declared type stands, already validated by `#prepare`.
   */
  #assertContentMatches(
    accepted: readonly string[],
    collection: string,
    declared: string,
    head: Uint8Array,
  ): void {
    const verdict = verifyContentAgainstWhitelist(head, accepted, declared);
    if (verdict.outcome === 'accepted') return;
    if (verdict.outcome === 'unrecognized') {
      throw new ContentSignatureUnrecognizedError(collection, declared, accepted);
    }
    throw new ContentTypeMismatchError(collection, declared, verdict.detected, accepted);
  }

  /**
   * Storage key layout every record written by this library follows. `fileName` is client-supplied
   * (a form field, or the original name of an already-uploaded object) and goes through
   * {@link sanitizeFileName} first — otherwise `../../etc/passwd` or an absolute path would
   * interpolate straight into the key and escape the owner/collection/id prefix.
   */
  #layoutPath(
    ownerType: string,
    ownerId: string,
    collection: string,
    id: string,
    fileName: string,
  ): string {
    return `${ownerType}/${ownerId}/${collection}/${id}/${sanitizeFileName(fileName)}`;
  }

  /**
   * Everything both attach paths do BEFORE the object exists: resolve the collection, enforce its
   * MIME whitelist against the declared type (normalizing generic/truncated declarations from the
   * file extension first), capture the records a `single: true` collection will replace, and pick
   * the disk and record id.
   *
   * The declared-type check is only the cheap first gate — it rejects without touching a byte. Each
   * attach path then proves the content itself with {@link #assertContentMatches}.
   *
   * A single-file collection replaces whatever is already there — but only once the new media is
   * stored, persisted AND renderable, so anything that fails on the way leaves the old media intact.
   * Hence "capture up front, drop at the end" (see {@link #commit}).
   */
  async #prepare(input: {
    ownerType: string;
    ownerId: string | number;
    collection: string;
    fileName: string;
    mimeType: string;
    disk?: string | undefined;
    id?: string | undefined;
  }): Promise<AttachContext> {
    const config = this.collections.get(input.collection);
    const ownerId = String(input.ownerId);

    const mimeType = resolveDeclaredMimeType(
      input.mimeType,
      input.fileName,
      config.acceptsMimeTypes,
    );
    if (mimeType === undefined) {
      throw new MimeNotAllowedError(
        input.collection,
        input.mimeType,
        config.acceptsMimeTypes ?? [],
      );
    }

    const previous = config.single
      ? await this.store.listByOwner(input.ownerType, ownerId, input.collection)
      : [];
    const disk = input.disk ?? config.disk ?? this.storage.defaultDisk;

    return {
      config,
      ownerId,
      mimeType,
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
      const strippedSize = config.stripMetadata
        ? await this.#stripMetadata(target, path, input.mimeType)
        : undefined;
      // `getMetaData` is a HEAD-shaped metadata read, never a body download — the zero-copy
      // guarantee of `attachExisting` holds even when the caller omits `size` (and the collection
      // does not `stripMetadata`, which has to read the bytes).
      const size = strippedSize ?? input.size ?? (await target.getMetaData(path)).contentLength;
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

    // Eager presets are generated synchronously on attach; lazy ones on first `url()`. Eager
    // transformers run right after them — the hook that makes "TUS drops the bytes, transformers
    // derive from them" automatic, since `attachExisting` (and so `completeUploadToLibrary`)
    // funnels through this same commit. Both run BEFORE `previous` is dropped: a derivation that
    // throws must not leave the owner with nothing.
    const eagerPresets = (config.conversions ?? []).filter((p) => p.eager);
    const eagerTransformers = (config.transformers ?? []).filter((t) => t.eager === true);
    let current = saved;
    if (eagerPresets.length > 0 || eagerTransformers.length > 0) {
      try {
        for (const preset of eagerPresets) {
          current = await this.ensureConversion(saved.id, preset.name);
        }
        for (const transformer of eagerTransformers) {
          current = await this.#runTransformer(current, transformer);
        }
      } catch (error) {
        // The new media can't be rendered, so roll it back whole — bytes, any conversions already
        // written, and the row — and leave what it was replacing untouched.
        if (input.ownsObject) await this.#safeDelete(disk, path);
        for (const variant of Object.values(current.conversions)) {
          await this.#deleteConversionArtifacts(variant, { safe: true });
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
          await this.#deleteConversionArtifacts(variant, { safe: true });
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

    const config = this.collections.get(record.collection);
    const preset = (config.conversions ?? []).find((p) => p.name === conversionName);
    if (!preset) {
      // The name belongs to a transformer, not a preset: it IS defined, just not generated — and a
      // read path never generates a transform (assumed heavy). Point the caller at `transform()`.
      if ((config.transformers ?? []).some((t) => t.name === conversionName)) {
        throw new TransformNotReadyError(id, conversionName);
      }
      throw new ConversionNotDefinedError(record.collection, conversionName);
    }
    return this.#generateConversion(record, preset);
  }

  /** Run `preset` over the record's original, store the output and persist it as a conversion. */
  async #generateConversion(record: MediaRecord, preset: ConversionPreset): Promise<MediaRecord> {
    if (!this.imageProcessor) throw new ImageProcessorMissingError();

    const original = asBuffer(await this.storage.disk(record.disk).getBytes(record.path));
    if (preset.onlyDownscale && preset.width && this.imageProcessor.dimensions) {
      const size = await this.imageProcessor.dimensions(original);
      if (size && size.width <= preset.width) {
        return this.#recordConversion(record, preset.name, {
          meta: { skipped: 'not-smaller-than-original', width: size.width, height: size.height },
        });
      }
    }
    const focalPoint = focalPointOf(record.customProperties);
    const result = await this.imageProcessor.convert(
      original,
      preset,
      focalPoint ? { focalPoint } : {},
    );
    const dir = record.path.slice(0, record.path.lastIndexOf('/'));
    const conversionPath = `${dir}/conversions/${preset.name}.${result.format}`;
    await this.storage.disk(record.disk).put(conversionPath, result.data, {
      contentType: result.contentType,
    });

    const updated = await this.#recordConversion(record, preset.name, {
      path: conversionPath,
      disk: record.disk,
      ...(result.width && result.height
        ? { meta: { width: result.width, height: result.height } }
        : {}),
    });
    this.emit('conversion', { id: record.id, conversion: preset.name, path: conversionPath });
    return updated;
  }

  /**
   * Rewrite the object at `path` without its metadata (`stripMetadata` collections). Returns the
   * new size, or `undefined` when nothing was rewritten (not an image, nothing to strip).
   */
  async #stripMetadata(target: Disk, path: string, mimeType: string): Promise<number | undefined> {
    if (!mimeType.startsWith('image/') || mimeType.startsWith('image/svg')) return undefined;
    if (!this.imageProcessor) throw new ImageProcessorMissingError();
    if (!this.imageProcessor.stripMetadata) return undefined;
    const original = asBuffer(await target.getBytes(path));
    const stripped = await this.imageProcessor.stripMetadata(original);
    if (!stripped) return undefined;
    await target.put(path, stripped, { contentType: mimeType });
    return stripped.byteLength;
  }

  /** Persist one conversion entry, re-reading first so a concurrent one is not dropped. */
  async #recordConversion(
    record: MediaRecord,
    name: string,
    conversion: MediaConversion,
  ): Promise<MediaRecord> {
    const current = (await this.store.find(record.id)) ?? record;
    return this.store.save({
      ...current,
      conversions: { ...current.conversions, [name]: conversion },
      updatedAt: this.now(),
    });
  }

  /**
   * Set (or clear, with `null`) the part of the image every crop must keep — a face in an avatar,
   * the subject of a banner. Stored as `customProperties.focalPoint` (`{ x, y }`, fractions of the
   * displayed image), handed to the processor for every cropping preset (`fit: 'cover'` with both
   * sides), and returned by {@link image} so CSS crops (`object-fit: cover`) keep it too.
   *
   * The cropping conversions already generated are dropped — the eager ones regenerated at once,
   * the lazy ones on next access — since they were cut around the old point.
   *
   * ```ts
   * await media.library.setFocalPoint(user.avatarMediaId, { x: 0.42, y: 0.31 })
   * ```
   */
  async setFocalPoint(id: string, point: FocalPoint | null): Promise<MediaRecord> {
    const record = await this.store.find(id);
    if (!record) throw new MediaNotFoundError(id);
    if (point !== null && !focalPointOf({ focalPoint: point })) {
      throw new RangeError(
        `Focal point must be { x, y } with both between 0 and 1, got ${JSON.stringify(point)}.`,
      );
    }

    const { focalPoint: _previous, ...rest } = record.customProperties;
    const presets = this.collections.get(record.collection).conversions ?? [];
    const cropping = presets.filter((preset) => presetCrops(preset));
    const conversions = { ...record.conversions };
    for (const preset of cropping) {
      const stale = conversions[preset.name];
      if (stale?.path && stale.disk) await this.storage.disk(stale.disk).delete(stale.path);
      delete conversions[preset.name];
    }

    let updated = await this.store.save({
      ...record,
      customProperties: point ? { ...rest, focalPoint: { x: point.x, y: point.y } } : rest,
      conversions,
      updatedAt: this.now(),
    });
    for (const preset of cropping) {
      if (preset.eager) updated = await this.#generateConversion(updated, preset);
    }
    return updated;
  }

  /**
   * Resize the image to one of `delivery.images.widths`, on demand — the server half of a
   * `next/image`-style loader (`?w=640&q=75`). Generated once and kept as the conversion
   * `@w640q75`, so later requests (and `delete()`) treat it like any other conversion. Never
   * enlarges: past the original's width it is the original's size, re-encoded.
   *
   * Returns the conversion to deliver, or `undefined` for an SVG (served as is: it scales by itself).
   * Throws {@link ImageSizeNotAllowedError} outside the whitelist and {@link NotAnImageError} for a
   * record that is not an image.
   */
  async resized(
    id: string,
    request: {
      width: number | string;
      quality?: number | string | undefined;
      accept?: string | undefined;
      /** Signed by the app: any width/quality in range, not just the whitelist. */
      trusted?: boolean | undefined;
    },
  ): Promise<{ record: MediaRecord; conversion: string | undefined }> {
    const { widths, qualities, formats } = this.deliveryImages;
    const width = request.trusted
      ? numberInRange('width', request.width, 1, MAX_SIGNED_WIDTH)
      : allowedNumber('width', request.width, widths);
    const quality =
      request.quality === undefined || request.quality === ''
        ? qualities[0]!
        : request.trusted
          ? numberInRange('quality', request.quality, 1, 100)
          : allowedNumber('quality', request.quality, qualities);

    const record = await this.store.find(id);
    if (!record) throw new MediaNotFoundError(id);
    if (record.mimeType.startsWith('image/svg')) return { record, conversion: undefined };
    if (!record.mimeType.startsWith('image/')) throw new NotAnImageError(id, record.mimeType);

    const format = negotiateFormat(request.accept, formats, record.mimeType);
    const name = `@w${width}q${quality}-${format}`;
    if (record.conversions[name]) return { record, conversion: name };
    const updated = await this.#generateConversion(record, {
      name,
      width,
      quality,
      format,
      fit: 'inside',
      withoutEnlargement: true,
    });
    return { record: updated, conversion: name };
  }

  /**
   * Run a named {@link Transformer} of the record's collection and persist its output as
   * `record.conversions[name]`. **Idempotent**: an already-generated conversion returns the record
   * untouched, so a retried job skips straight through — the library assumes no queue system, it
   * only guarantees this call is safe to repeat.
   *
   * ```ts
   * // app job (the app owns the queue, retries and any locking):
   * await media.library.transform(payload.mediaId, 'video')
   * ```
   *
   * Deliberately explicit: unlike image presets, a transformer conversion is never generated
   * lazily inside `url()`/`deliver()` — reads on a missing one throw {@link TransformNotReadyError}
   * instead of stalling a request behind a remux. Transformers marked `eager: true` are the
   * exception and run inside attach (see {@link Transformer}).
   *
   * Two concurrent calls for the same media+name both run and the second save wins; the artifacts
   * are deterministic per key, so the result is identical — wasteful, not corrupting. Serialize
   * with your own lock if the double work matters.
   *
   * A mid-flight failure sweeps whatever artifacts were already written (best-effort) and
   * re-throws, so no conversion entry is ever persisted for a half-written package.
   */
  async transform(id: string, transformerName: string): Promise<MediaRecord> {
    const record = await this.store.find(id);
    if (!record) throw new MediaNotFoundError(id);
    if (record.conversions[transformerName]) return record;

    const config = this.collections.get(record.collection);
    const transformer = (config.transformers ?? []).find((t) => t.name === transformerName);
    if (!transformer) throw new TransformerNotDefinedError(record.collection, transformerName);

    return this.#runTransformer(record, transformer);
  }

  /**
   * Execute one transformer against one record: build the sandboxed {@link TransformerContext},
   * validate the {@link TransformResult} contract, persist the conversion entry, emit
   * `conversion`. The context's `write` is the only artifact path — it pins every write under the
   * conversion prefix and records it, which is what makes the output deletable and servable
   * without trusting the transformer's bookkeeping.
   */
  async #runTransformer(record: MediaRecord, transformer: Transformer): Promise<MediaRecord> {
    const diskName = record.disk;
    const disk = this.storage.disk(diskName);
    const dir = record.path.slice(0, record.path.lastIndexOf('/'));
    const outputPrefix = `${dir}/conversions/${transformer.name}/`;
    const written: string[] = [];

    const write = async (
      relativePath: string,
      contents: Uint8Array | Readable,
      options: TransformerWriteOptions = {},
    ): Promise<void> => {
      const relative = assertSafeArtifactPath(transformer.name, relativePath);
      const key = `${outputPrefix}${relative}`;
      const writeOptions = {
        ...(options.contentType !== undefined ? { contentType: options.contentType } : {}),
      };
      if (contents instanceof Uint8Array) {
        await disk.put(key, contents, writeOptions);
      } else if (options.contentLength !== undefined && typeof disk.putStream === 'function') {
        // A sized stream goes straight through — a segment file never has to fit in memory twice.
        await disk.putStream(key, contents, {
          ...writeOptions,
          contentLength: options.contentLength,
        });
      } else {
        await disk.put(key, await toBytes(contents), writeOptions);
      }
      if (!written.includes(relative)) written.push(relative);
    };

    const context: TransformerContext = {
      record,
      disk,
      diskName,
      storage: this.storage,
      getBytes: () => disk.getBytes(record.path),
      getStream: () => disk.getStream(record.path),
      outputPrefix,
      write,
    };

    let result: TransformResult;
    try {
      result = await transformer.transform(context);
      if (result.entry !== undefined && !written.includes(result.entry)) {
        throw new TransformerOutputError(
          transformer.name,
          `entry "${result.entry}" was never written through context.write`,
        );
      }
      if (result.entry === undefined && written.length > 0) {
        throw new TransformerOutputError(
          transformer.name,
          `it wrote ${written.length} artifact(s) but declared no entry`,
        );
      }
    } catch (error) {
      // Sweep the partial output (best-effort) so a retry starts clean and a failed transform
      // never leaks storage; the conversion entry was never persisted, so `transform()` will
      // simply run again.
      for (const relative of written) {
        await this.#safeDelete(diskName, `${outputPrefix}${relative}`);
      }
      throw error;
    }

    const conversion: MediaConversion =
      result.entry !== undefined
        ? {
            path: `${outputPrefix}${result.entry}`,
            disk: diskName,
            prefix: outputPrefix,
            files: [...written],
            ...(result.meta !== undefined ? { meta: result.meta } : {}),
          }
        : { ...(result.meta !== undefined ? { meta: result.meta } : {}) };

    // Re-read before saving: the transform may have taken minutes, and `save` persists the whole
    // record — merging over a fresh row keeps conversions generated meanwhile.
    const fresh = (await this.store.find(record.id)) ?? record;
    const updated = await this.store.save({
      ...fresh,
      conversions: { ...fresh.conversions, [transformer.name]: conversion },
      updatedAt: this.now(),
    });
    this.emit('conversion', {
      id: record.id,
      conversion: transformer.name,
      path: conversion.path ?? '',
    });
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
      await this.#deleteConversionArtifacts(conversion, { safe: false });
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
   * Delete every storage key a conversion entry owns: the single artifact of an image conversion,
   * every listed file of a multi-artifact (transformer) conversion, nothing for a metadata-only
   * one. Batched through `deleteMany` on capable disks — an HLS package is hundreds of segments,
   * and one batched call beats hundreds of round-trips. `safe: true` swallows failures
   * (compensation paths must never mask the original error).
   */
  async #deleteConversionArtifacts(
    variant: MediaConversion,
    options: { safe: boolean },
  ): Promise<void> {
    let diskName: string;
    let keys: string[];
    if (variant.prefix !== undefined && variant.files !== undefined && variant.disk !== undefined) {
      diskName = variant.disk;
      keys = variant.files.map((file) => `${variant.prefix}${file}`);
    } else if (variant.path !== undefined && variant.disk !== undefined) {
      diskName = variant.disk;
      keys = [variant.path];
    } else {
      return; // metadata-only conversion: nothing on any disk
    }

    const disk = this.storage.disk(diskName);
    if (isExtendedDisk(disk)) {
      try {
        await disk.deleteMany(keys);
        return;
      } catch (error) {
        if (!options.safe) throw error;
        return;
      }
    }
    for (const key of keys) {
      if (options.safe) {
        await this.#safeDelete(diskName, key);
      } else {
        await disk.delete(key);
      }
    }
  }

  /**
   * Resolve a media id (optionally a named conversion of it) to the concrete object on a disk that
   * every read path — {@link url}, {@link signedUrl}, {@link deliver} — then acts on. Requesting a
   * conversion that has not been generated produces it lazily first.
   */
  async #resolveTarget(
    id: string,
    conversion?: string | undefined,
  ): Promise<{ record: MediaRecord; disk: string; path: string; fileName: string }> {
    if (conversion) {
      const record = await this.ensureConversion(id, conversion);
      const variant = record.conversions[conversion];
      if (!variant) throw new MediaNotFoundError(`${id}#${conversion}`);
      // A metadata-only transform (a probe) HAS a conversion entry but no file behind it.
      if (variant.path === undefined || variant.disk === undefined) {
        throw new ConversionArtifactMissingError(id, conversion);
      }
      return {
        record,
        disk: variant.disk,
        path: variant.path,
        // The conversion has its own format (and so its own extension); the record's `fileName`
        // names the original.
        fileName: variant.path.slice(variant.path.lastIndexOf('/') + 1),
      };
    }
    const record = await this.store.find(id);
    if (!record) throw new MediaNotFoundError(id);
    return { record, disk: record.disk, path: record.path, fileName: record.fileName };
  }

  /**
   * Public URL for a media record or one of its conversions. When a conversion is
   * requested and not yet generated, it is produced lazily (and cached) first.
   */
  async url(id: string, conversion?: string): Promise<string> {
    const target = await this.#resolveTarget(id, conversion);
    return this.storage.disk(target.disk).getUrl(target.path);
  }

  /**
   * Everything an `<img>` needs to render a stored image like `next/image`: `srcSet` from the
   * collection's presets, the intrinsic `width`/`height` and the blur-up `placeholder` — as plain
   * JSON, for a page prop. Render it with `<MediaImage>` from `@adonis-agora/media-react`.
   *
   * ```ts
   * // config: presets at a few widths (eager, so they exist from the attach on) + the placeholder
   * { name: 'banner', conversions: [{ name: 'sm', width: 640, eager: true }, { name: 'lg', width: 1280, eager: true }],
   *   transformers: [transformers.placeholder()] }
   *
   * return inertia.render('courses/show', { banner: await media.library.image(course.bannerMediaId) })
   * ```
   *
   * The intrinsic size and the original-as-candidate come from the placeholder, so without
   * `transformers.placeholder()` the result has no `width`/`height` and only the presets in
   * `srcSet`. Like {@link url}, this answers "how", not "who": authorize the caller first.
   */
  async image(id: string, options: ResponsiveImageOptions = {}): Promise<ResponsiveImage> {
    let record = await this.store.find(id);
    if (!record) throw new MediaNotFoundError(id);
    if (options.onDemand) return this.#onDemandImage(record, options.onDemand);
    const presets = this.collections.get(record.collection).conversions ?? [];

    if (options.generate) {
      for (const preset of presets) {
        if (options.conversions && !options.conversions.includes(preset.name)) continue;
        if (!preset.blur && !record.conversions[preset.name]) {
          record = await this.ensureConversion(id, preset.name);
        }
      }
    }

    const urlOf = (conversion: string | undefined): string | Promise<string> => {
      if (options.url) return options.url(conversion);
      if (options.expiresIn !== undefined) {
        return this.signedUrl(id, options.expiresIn, conversion ? { conversion } : {});
      }
      // With signing configured, nothing goes out as a storage URL: everything through the route.
      if (this.deliverySigning) return this.deliveryUrl(id, conversion ? { conversion } : {});
      return this.url(id, conversion);
    };

    const candidates = imageCandidates(record, presets, options.conversions);
    const urls = await Promise.all(candidates.map((c) => urlOf(c.conversion)));
    const widest = urls.at(-1);
    const placeholder = placeholderOf(record);
    // An explicit group (an art-directed `<source>`) reports its own size — a square crop is not
    // the original's shape.
    const groupSize = options.conversions
      ? [...candidates].reverse().find((c) => c.height !== undefined)
      : undefined;
    const size = groupSize
      ? { width: groupSize.width, height: groupSize.height! }
      : placeholder
        ? { width: placeholder.width, height: placeholder.height }
        : undefined;

    return {
      src: widest ?? (await urlOf(undefined)),
      ...(candidates.length > 0
        ? { srcSet: candidates.map((c, i) => `${urls[i]} ${c.width}w`).join(', ') }
        : {}),
      ...(size ?? {}),
      ...(placeholder
        ? { placeholder: { dataUrl: placeholder.dataUrl, color: placeholder.color } }
        : {}),
      ...focalPointProp(record),
    };
  }

  /** {@link image} with `onDemand`: candidates are delivery-route URLs resized per width. */
  #onDemandImage(
    record: MediaRecord,
    onDemand: true | { widths?: readonly number[]; quality?: number },
  ): ResponsiveImage {
    const settings = onDemand === true ? {} : onDemand;
    const placeholder = placeholderOf(record);
    const extra = {
      ...(placeholder
        ? {
            width: placeholder.width,
            height: placeholder.height,
            placeholder: { dataUrl: placeholder.dataUrl, color: placeholder.color },
          }
        : {}),
      ...focalPointProp(record),
    };
    const original = this.deliveryUrl(record.id);
    // Not resizable (an SVG scales itself; a non-image has no widths): the route serves it as is.
    if (!record.mimeType.startsWith('image/') || record.mimeType.startsWith('image/svg')) {
      return { src: original, ...extra };
    }

    const originalWidth = placeholder?.width;
    const widths = [...(settings.widths ?? this.deliveryImages.widths)]
      .filter((w) => (originalWidth === undefined ? w >= 256 : w < originalWidth))
      .sort((a, b) => a - b);
    const candidates = widths.map((width) => ({
      url: this.deliveryUrl(record.id, {
        width,
        ...(settings.quality !== undefined ? { quality: settings.quality } : {}),
      }),
      width,
    }));
    // The original, full size, as the widest — when its width is known and browsers decode it.
    if (originalWidth !== undefined && BROWSER_IMAGE_TYPES.has(record.mimeType)) {
      candidates.push({ url: original, width: originalWidth });
    }
    if (candidates.length === 0) return { src: original, ...extra };
    return {
      src: candidates.at(-1)!.url,
      srcSet: candidates.map((c) => `${c.url} ${c.width}w`).join(', '),
      ...extra,
    };
  }

  /**
   * URL of the delivery route (`delivery.path`, default `/media/:id`) for a record — optionally a
   * conversion, or resized (`width`/`quality`). With `delivery.signing` configured it is signed and
   * expires, and `MediaDeliveryHandler` serves exactly what was signed (any width) and nothing else;
   * without it, a plain route URL (widths limited to `delivery.images`).
   *
   * ```ts
   * media.library.deliveryUrl(id)                 // /media/<id>?exp=…&sig=…
   * media.library.deliveryUrl(id, { width: 640 }) // /media/<id>?w=640&exp=…&sig=…
   * ```
   */
  deliveryUrl(
    id: string,
    options: {
      conversion?: string;
      width?: number;
      quality?: number;
      /** Seconds; overrides `delivery.signing.expiresIn`. */
      expiresIn?: number;
    } = {},
  ): string {
    const path = this.deliveryPath.replace(':id', encodeURIComponent(id));
    const { conversion, width, quality } = options;
    if (!this.deliverySigning) return path + deliveryQueryString({ conversion, width, quality });
    const ttl =
      options.expiresIn ?? this.deliverySigning.expiresIn ?? DEFAULT_DELIVERY_SIGNING_TTL_SECONDS;
    const expires = deliveryExpiry(this.now().getTime(), ttl);
    const signature = signDelivery(this.deliverySigning.secret, {
      mediaId: id,
      conversion,
      width,
      quality,
      expires,
    });
    return path + deliveryQueryString({ conversion, width, quality, expires, signature });
  }

  /**
   * What a player needs to stream a video: the URLs of every HLS/DASH manifest the record's
   * conversions provide (`transformers.video()`), HLS first, through the
   * stream route (`delivery.streamPath`, served by `media.access.streamRoute()`). Pass the result
   * to `useMediaStream` from `@adonis-agora/media-react` as is.
   *
   * With `delivery.signing`, the URLs are signed for the whole package: the route then serves the
   * manifest and every segment it leads to without asking the app again, until they expire. The
   * lifetime is `expiresIn`, else `delivery.signing.expiresIn` — but never shorter than the video
   * plus an hour, so a player does not lose access mid-video.
   *
   * Like {@link image}, this answers "how", not "who": authorize the caller first — or use
   * `media.access.stream(ctx, id)`, which does.
   *
   * Throws {@link TransformNotReadyError} when no streamable conversion exists yet.
   */
  async stream(
    id: string,
    options: {
      /** Which conversions to offer, in order. Default: every streamable one. */
      conversions?: readonly string[];
      /** Signed-URL lifetime in seconds (with `delivery.signing`). */
      expiresIn?: number;
    } = {},
  ): Promise<MediaStream> {
    const record = await this.store.find(id);
    if (!record) throw new MediaNotFoundError(id);
    const entries = streamEntries(record, options.conversions);
    const first = entries[0];
    if (!first) throw new TransformNotReadyError(id, options.conversions?.join(', ') ?? 'hls/dash');

    const sources: MediaStreamSource[] = entries.map((entry) => ({
      src: this.streamUrl(record, entry.conversion, entry.file, options),
      format: entry.format,
      type: entry.format === 'hls' ? HLS_MIME_TYPE : DASH_MIME_TYPE,
      conversion: entry.conversion,
    }));
    const meta = record.conversions[first.conversion]?.meta ?? {};
    const numeric = (key: string) =>
      typeof meta[key] === 'number' ? { [key]: meta[key] as number } : {};
    return {
      src: sources[0]!.src,
      format: sources[0]!.format,
      sources,
      ...numeric('width'),
      ...numeric('height'),
      ...numeric('durationSeconds'),
    };
  }

  /**
   * URL of one file of a streaming package on the stream route — signed for the whole package
   * with `delivery.signing`. {@link stream} builds the entry URLs with it.
   */
  streamUrl(
    record: MediaRecord,
    conversion: string,
    file: string,
    options: { expiresIn?: number } = {},
  ): string {
    const path = this.deliveryStreamPath
      .replace(':id', encodeURIComponent(record.id))
      .replace(':conversion', encodeURIComponent(conversion));
    const url = `${path.replace(/\/+$/, '')}/${file.split('/').map(encodeURIComponent).join('/')}`;
    const query = this.streamQuery(record, conversion, options.expiresIn);
    return query ? `${url}?${query}` : url;
  }

  /**
   * The `exp=…&sig=…` that authorizes every file of one streaming package (no `?`), or `''`
   * without `delivery.signing`. The signature covers the record and the conversion — not a file —
   * so it can ride along on every reference a manifest makes.
   */
  streamQuery(record: MediaRecord, conversion: string, expiresIn?: number): string {
    if (!this.deliverySigning) return '';
    const duration = record.conversions[conversion]?.meta?.durationSeconds;
    const ttl = Math.max(
      expiresIn ?? this.deliverySigning.expiresIn ?? DEFAULT_DELIVERY_SIGNING_TTL_SECONDS,
      typeof duration === 'number' ? Math.ceil(duration) + 3600 : 0,
    );
    const expires = deliveryExpiry(this.now().getTime(), ttl);
    const signature = signDelivery(this.deliverySigning.secret, {
      mediaId: record.id,
      conversion,
      expires,
    });
    return deliveryQueryString({ expires, signature }).slice(1);
  }

  /**
   * Serve one file of a record's streaming package — the "how" of `media.access.streamRoute()`
   * (authorize first). `file` is checked against the package's persisted artifact list, so a
   * request can never reach outside it.
   *
   * - A **manifest** (`.m3u8`/`.mpd`) comes back as text. Its references are relative and resolve
   *   to the same route, so it is served as stored — plus `query` (a package signature) on every
   *   relative reference when given, which is how segment requests inherit the authorization.
   * - Anything else (segments, init sections) is delivered per `mode` (default `delivery.mode`):
   *   a redirect to the object (signed URLs stay short-lived — they are minted per segment
   *   request), or a stream through the app.
   */
  async streamFile(
    record: MediaRecord,
    conversion: string,
    file: string,
    options: {
      query?: string | undefined;
      mode?: DeliveryMode | undefined;
      signedTtlSeconds?: number | undefined;
    } = {},
  ): Promise<StreamFileResult> {
    const variant = record.conversions[conversion];
    if (!variant) throw new TransformNotReadyError(record.id, conversion);
    if (variant.path === undefined || variant.disk === undefined || !variant.files) {
      throw new ConversionArtifactMissingError(record.id, conversion);
    }
    // Membership in the persisted artifact list is the whole path check: caller input never
    // reaches a disk key by arithmetic, so traversal is structurally impossible.
    if (!variant.files.includes(file)) {
      throw new MediaNotFoundError(`${record.id}#${conversion}:${file}`);
    }
    const prefix = variant.prefix ?? variant.path.slice(0, variant.path.lastIndexOf('/') + 1);
    const disk = this.storage.disk(variant.disk);
    const key = `${prefix}${file}`;
    const fileName = file.slice(file.lastIndexOf('/') + 1);

    const format = streamFormatOf(file);
    if (format) {
      const stored = Buffer.from(await disk.getBytes(key)).toString('utf8');
      return {
        kind: 'manifest',
        content: await signManifest(file, stored, options.query ?? ''),
        contentType: format === 'hls' ? HLS_MIME_TYPE : DASH_MIME_TYPE,
        fileName,
      };
    }

    const mode = await resolveDeliveryMode(options.mode ?? this.deliveryMode, disk, key);
    if (mode === 'public') return { kind: 'redirect', url: await disk.getUrl(key) };
    if (mode === 'signed') {
      const expiresIn = options.signedTtlSeconds ?? this.deliverySignedTtlSeconds;
      return { kind: 'redirect', url: await disk.getSignedUrl(key, { expiresIn }) };
    }
    const metadata = await disk.getMetaData(key);
    return {
      kind: 'stream',
      stream: await disk.getStream(key),
      // A disk that stores everything as a generic type (S3 multipart) would make a player
      // refuse the segment; the extension knows better.
      mimeType:
        metadata.contentType && metadata.contentType !== 'application/octet-stream'
          ? metadata.contentType
          : (streamArtifactContentType(file) ?? 'application/octet-stream'),
      size: metadata.contentLength,
      fileName,
    };
  }

  /**
   * Check a delivery request against `delivery.signing`: `true` when it is signed and valid (serve
   * any size it names), `false` when signing is off or the request is unsigned and that is allowed.
   * Throws {@link DeliverySignatureError} for an invalid or expired signature, or a missing one when
   * `delivery.signing.required` (the default). `MediaDeliveryHandler` calls this for you.
   */
  checkDeliverySignature(
    request: {
      mediaId: string;
      conversion?: string | undefined;
      width?: number | string | undefined;
      quality?: number | string | undefined;
      expires?: number | string | undefined;
      signature?: string | undefined;
    },
    options: {
      /** Override `delivery.signing.required` for this check (a route that authorizes by itself). */
      required?: boolean;
    } = {},
  ): boolean {
    if (!this.deliverySigning) return false;
    const signed = verifyDelivery(this.deliverySigning.secret, request, this.now().getTime());
    if (!signed && (options.required ?? this.deliverySigning.required ?? true)) {
      throw new DeliverySignatureError('missing');
    }
    return signed;
  }

  /**
   * Resolve how a media record should reach the client, per the configured `delivery.mode` — the
   * read-side counterpart to `uploads.mode`. Returns either a URL to redirect to (`public`/`signed`)
   * or a {@link Readable} to pipe (`proxy`), so an app on a private bucket with no
   * internet-reachable storage stops hand-rolling a streaming route.
   *
   * Like every other library method this answers "how", NOT "who": authorize the caller first. See
   * {@link MediaDeliveryHandler} for mounting this as a route.
   *
   * ```ts
   * const result = await media.library.deliver(id)
   * if (result.kind === 'redirect') return response.redirect(result.url)
   * response.header('content-type', result.mimeType)
   * return response.stream(result.stream)
   * ```
   */
  async deliver(id: string, options: DeliverOptions = {}): Promise<DeliveryResult> {
    const resizing = options.width !== undefined && options.width !== '';
    const conversion = resizing
      ? (
          await this.resized(id, {
            width: options.width!,
            quality: options.quality,
            accept: options.accept,
            trusted: options.trusted,
          })
        ).conversion
      : options.conversion;
    const vary = resizing && options.accept !== undefined ? { vary: 'Accept' as const } : {};
    const target = await this.#resolveTarget(id, conversion);
    const disk = this.storage.disk(target.disk);
    const mode = await resolveDeliveryMode(options.mode ?? this.deliveryMode, disk, target.path);

    if (mode === 'public') {
      return { kind: 'redirect', url: await disk.getUrl(target.path), ...vary };
    }
    if (mode === 'signed') {
      const expiresIn = options.signedTtlSeconds ?? this.deliverySignedTtlSeconds;
      return {
        kind: 'redirect',
        url: await disk.getSignedUrl(target.path, { expiresIn }),
        ...vary,
      };
    }

    // Prefer the disk's own metadata over the record's: for a conversion the record describes the
    // ORIGINAL (a `thumb` of a PNG may well be a WEBP), and its `size` is the original's too.
    const metadata = await disk.getMetaData(target.path);
    return {
      kind: 'stream',
      stream: await disk.getStream(target.path),
      mimeType: deliveredMimeType(metadata.contentType, target.record.mimeType, conversion),
      size: metadata.contentLength,
      fileName: target.fileName,
      ...vary,
    };
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

    const target = await this.#resolveTarget(id, conversion);
    return this.storage.disk(target.disk).getSignedUrl(target.path, signOptions);
  }
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * Validate an artifact path a transformer hands to `context.write`: relative, normalized, and
 * incapable of escaping the conversion prefix. Throws {@link TransformerOutputError} — a traversal
 * attempt is a transformer bug (or a transformer echoing hostile input), never something to
 * silently normalize into place.
 */
function assertSafeArtifactPath(transformer: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized === '' || normalized.startsWith('/') || normalized.endsWith('/')) {
    throw new TransformerOutputError(
      transformer,
      `artifact path "${relativePath}" must be a relative file path`,
    );
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new TransformerOutputError(
      transformer,
      `artifact path "${relativePath}" must not contain empty, "." or ".." segments`,
    );
  }
  return normalized;
}

/** Widest image a signed URL may ask for — a sanity bound; the original's width still caps it. */
const MAX_SIGNED_WIDTH = 8192;

/** Parse a requested width/quality and check it is within `[min, max]` (signed requests). */
function numberInRange(
  field: 'width' | 'quality',
  value: number | string,
  min: number,
  max: number,
): number {
  const parsed =
    typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ImageSizeNotAllowedError(field, value, [min, max]);
  }
  return parsed;
}

/** Parse a requested width/quality (a query-string value, possibly) and check it is whitelisted. */
function allowedNumber(
  field: 'width' | 'quality',
  value: number | string,
  allowed: readonly number[],
): number {
  const parsed =
    typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!allowed.includes(parsed)) throw new ImageSizeNotAllowedError(field, value, allowed);
  return parsed;
}

/**
 * The resized image's format: the first configured modern format the browser accepts. A browser
 * that accepts none gets a format every browser decodes: PNG for an original that may be
 * transparent, JPEG otherwise. No `Accept` at all (a server-side caller) ⇒ the first configured.
 */
function negotiateFormat(
  accept: string | undefined,
  formats: readonly ('avif' | 'webp')[],
  originalMimeType: string,
): 'avif' | 'webp' | 'jpeg' | 'png' {
  if (accept === undefined) return formats[0] ?? 'webp';
  const accepted = accept.toLowerCase();
  const modern = formats.find((format) => accepted.includes(`image/${format}`));
  if (modern) return modern;
  return originalMimeType === 'image/png' || originalMimeType === 'image/gif' ? 'png' : 'jpeg';
}

function focalPointProp(record: MediaRecord): { focalPoint?: FocalPoint } {
  const focalPoint = focalPointOf(record.customProperties);
  return focalPoint ? { focalPoint } : {};
}

const GENERIC_CONTENT_TYPES = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * The `Content-Type` of a proxied file. The disk's own type wins — for a conversion the record
 * describes the ORIGINAL (a `thumb` of a PNG may be WebP) — unless it is a generic one: an object
 * assembled by a multipart/TUS upload comes back from S3 as `application/octet-stream`, and a PDF
 * served that way opens in no viewer. For the original, the record's type (checked against the
 * file's signature on attach) is then the truth.
 */
function deliveredMimeType(
  fromDisk: string | undefined,
  fromRecord: string,
  conversion: string | undefined,
): string {
  const base = (fromDisk ?? '').split(';')[0]!.trim().toLowerCase();
  if (!GENERIC_CONTENT_TYPES.has(base)) return fromDisk!;
  return conversion === undefined ? fromRecord : fromDisk || 'application/octet-stream';
}
