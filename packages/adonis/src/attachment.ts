import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { asBuffer, toBytes } from './contents.js';
import { publishMedia } from './diagnostics.js';
import { ImageProcessorMissingError, VariantNotFoundError } from './errors.js';
import type { ConversionPreset, ImageProcessor } from './image_processor.js';
import type { StorageManager } from './storage_manager.js';

export interface AttachmentVariant {
  disk: string;
  path: string;
  size: number;
  mimeType: string;
}

/** Plain, JSON-serializable shape stored in a model column. */
export interface AttachmentData {
  name: string;
  disk: string;
  path: string;
  size: number;
  mimeType: string;
  variants: Record<string, AttachmentVariant>;
  meta: Record<string, unknown>;
}

/**
 * A file attached to a model as a column value (adonis-attachment style). Pure value
 * object — it carries disk + path + variant metadata and serializes to JSON. URL
 * resolution and deletion go through {@link AttachmentManager} (which holds the disks).
 */
export class Attachment {
  readonly name: string;
  readonly disk: string;
  readonly path: string;
  readonly size: number;
  readonly mimeType: string;
  readonly variants: Record<string, AttachmentVariant>;
  readonly meta: Record<string, unknown>;

  constructor(data: AttachmentData) {
    this.name = data.name;
    this.disk = data.disk;
    this.path = data.path;
    this.size = data.size;
    this.mimeType = data.mimeType;
    this.variants = data.variants;
    this.meta = data.meta;
  }

  toJSON(): AttachmentData {
    return {
      name: this.name,
      disk: this.disk,
      path: this.path,
      size: this.size,
      mimeType: this.mimeType,
      variants: this.variants,
      meta: this.meta,
    };
  }

  /** Rebuild from a stored column value; returns null for null/undefined. */
  static fromJSON(json: AttachmentData | null | undefined): Attachment | null {
    return json ? new Attachment(json) : null;
  }
}

export interface CreateAttachmentInput {
  fileName: string;
  mimeType: string;
  contents: Buffer | Readable;
  size?: number;
}

export interface CreateAttachmentOptions {
  disk?: string;
  /** Key prefix on the disk. Default `attachments`. */
  keyPrefix?: string;
  /** Image variants to generate eagerly (needs an ImageProcessor). */
  variants?: ConversionPreset[];
  /** Display name override (defaults to the file name). */
  name?: string;
  meta?: Record<string, unknown>;
}

export interface AttachmentManagerOptions {
  storage: StorageManager;
  imageProcessor?: ImageProcessor;
  keyPrefix?: string;
  idGenerator?: () => string;
  /** Emit `agora:media:attachment.*` diagnostics events (default true). */
  emitDiagnostics?: boolean;
}

/**
 * Creates and resolves {@link Attachment}s — the adonis-attachment-style API.
 * `createFromFile` uploads the bytes (and any variants) and returns a value object
 * you assign to a model column.
 */
export class AttachmentManager {
  private readonly storage: StorageManager;
  private readonly imageProcessor: ImageProcessor | undefined;
  private readonly keyPrefix: string;
  private readonly newId: () => string;
  private readonly emitDiagnostics: boolean;

  constructor(options: AttachmentManagerOptions) {
    this.storage = options.storage;
    this.imageProcessor = options.imageProcessor;
    this.keyPrefix = options.keyPrefix ?? 'attachments';
    this.newId = options.idGenerator ?? (() => randomUUID());
    this.emitDiagnostics = options.emitDiagnostics ?? true;
  }

  async createFromFile(
    input: CreateAttachmentInput,
    options: CreateAttachmentOptions = {},
  ): Promise<Attachment> {
    const disk = options.disk ?? this.storage.defaultDisk;
    const prefix = options.keyPrefix ?? this.keyPrefix;
    const id = this.newId();
    const dir = `${prefix}/${id}`;
    const path = `${dir}/${input.fileName}`;
    const target = this.storage.disk(disk);
    const presets = options.variants ?? [];

    // Stream large uploads straight through (no in-memory buffer) when we can: a Readable with a
    // known size, no variants to generate off the buffered bytes, and a disk that supports it.
    const canStream =
      !Buffer.isBuffer(input.contents) &&
      input.size !== undefined &&
      presets.length === 0 &&
      typeof target.putStream === 'function';
    if (canStream) {
      await target.putStream?.(path, input.contents as Readable, { contentType: input.mimeType });
    } else {
      const bytes = await toBytes(input.contents);
      await target.put(path, bytes, { contentType: input.mimeType });
    }

    const variants: Record<string, AttachmentVariant> = {};
    let size: number;
    try {
      size = input.size ?? (await target.getMetaData(path)).contentLength;
      if (presets.length > 0) {
        if (!this.imageProcessor) throw new ImageProcessorMissingError();
        const original = asBuffer(await target.getBytes(path));
        for (const preset of presets) {
          const result = await this.imageProcessor.convert(original, preset);
          const variantPath = `${dir}/variants/${preset.name}.${result.format}`;
          await target.put(variantPath, result.data, { contentType: result.contentType });
          variants[preset.name] = {
            disk,
            path: variantPath,
            size: result.data.byteLength,
            mimeType: result.contentType,
          };
        }
      }
    } catch (error) {
      // Compensation: the original (and any variants already written) leaked when the metadata read
      // or a conversion failed — best-effort remove them before rethrowing.
      await this.#safeDelete(disk, path);
      for (const variant of Object.values(variants)) {
        await this.#safeDelete(variant.disk, variant.path);
      }
      throw error;
    }

    const attachment = new Attachment({
      name: options.name ?? input.fileName,
      disk,
      path,
      size,
      mimeType: input.mimeType,
      variants,
      meta: options.meta ?? {},
    });

    if (this.emitDiagnostics) {
      publishMedia('attachment.create', {
        disk,
        path,
        size,
        mimeType: attachment.mimeType,
        name: attachment.name,
        variants: Object.keys(variants),
      });
    }
    return attachment;
  }

  /** Public URL for the attachment, or a named variant. */
  async url(attachment: Attachment, variant?: string): Promise<string> {
    const target = this.resolve(attachment, variant);
    return this.storage.disk(target.disk).getUrl(target.path);
  }

  /** Signed, expiring URL (presign-capable disks). */
  async signedUrl(
    attachment: Attachment,
    expiresIn: string | number,
    variant?: string,
  ): Promise<string> {
    const target = this.resolve(attachment, variant);
    return this.storage.disk(target.disk).getSignedUrl(target.path, { expiresIn });
  }

  /** Remove the attachment and all its variants from storage. */
  async delete(attachment: Attachment): Promise<void> {
    await this.storage.disk(attachment.disk).delete(attachment.path);
    for (const variant of Object.values(attachment.variants)) {
      await this.storage.disk(variant.disk).delete(variant.path);
    }
    if (this.emitDiagnostics) {
      publishMedia('attachment.delete', {
        disk: attachment.disk,
        path: attachment.path,
        variants: Object.keys(attachment.variants),
      });
    }
  }

  private resolve(attachment: Attachment, variant?: string): { disk: string; path: string } {
    if (!variant) return { disk: attachment.disk, path: attachment.path };
    const v = attachment.variants[variant];
    if (!v) throw new VariantNotFoundError(variant);
    return { disk: v.disk, path: v.path };
  }

  /** Best-effort disk cleanup for the orphan-compensation path; never masks the original error. */
  async #safeDelete(disk: string, path: string): Promise<void> {
    try {
      await this.storage.disk(disk).delete(path);
    } catch {
      // swallow: this is compensation for a failed create; the original error is what matters
    }
  }
}
