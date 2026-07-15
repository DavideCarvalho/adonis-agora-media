import { disks } from './disks/factory.js';
import type { DiskFactory, S3Credentials, S3DiskConfig } from './disks/factory.js';
import type { ImageProcessor } from './image_processor.js';
import type { MediaCollectionConfig } from './media_collection.js';
import { processors } from './processors/factory.js';
import type { ImageProcessorFactory } from './processors/factory.js';
import { stores } from './stores/factory.js';
import type { LucidStoreConfig, StoreContext, StoreFactory } from './stores/factory.js';
import type { UploadMode } from './upload_mode.js';
import { uploadSessions } from './upload_sessions/factory.js';
import type {
  LucidUploadSessionStoreConfig,
  UploadSessionStoreContext,
  UploadSessionStoreFactory,
} from './upload_sessions/factory.js';

/**
 * Direct-S3 upload configuration. Governs the `proxy`/`direct` multipart upload modes and, when
 * `routes.enabled`, the HTTP endpoints the provider mounts to drive them (idiomatic AdonisJS routes,
 * NOT controllers).
 */
export interface MediaUploadsConfig {
  /**
   * Default upload mode. `direct` presigns multipart parts for the client to upload straight to S3;
   * `proxy` streams bytes through the app; `auto` picks `direct` on a multipart-capable disk, else
   * `proxy`. Default `auto`.
   */
  mode?: UploadMode;
  /** Multipart part size in bytes for direct uploads. Default 8 MiB (S3's part minimum is 5 MiB). */
  partSize?: number;
  /** Lifetime of presigned part URLs, in seconds. Default 3600. */
  presignTtlSeconds?: number;
  /**
   * Mount the built-in upload HTTP routes. Opt-in — omit or set `enabled: false` to expose the
   * upload API only through the `MediaManager` methods and wire your own routes.
   */
  routes?: {
    /** Register the routes. Default false. */
    enabled?: boolean;
    /** Path prefix for the routes. Default `/media/uploads`. */
    prefix?: string;
  };
  /**
   * Resumable (TUS) upload settings. Present ⇒ `media.resumable` is available; when
   * `routes.enabled`, the provider mounts the TUS protocol endpoints. Absent ⇒ resumable uploads are
   * disabled and no session store is built.
   */
  resumable?: MediaResumableConfig;
}

/**
 * Resumable (TUS) upload configuration. The session store persists offset/length/metadata/expiry so
 * a dropped connection resumes; pick it by name from `stores` (built with the {@link uploadSessions}
 * factory so each peer is imported lazily). When `routes.enabled`, the provider mounts the TUS
 * protocol under `routes.prefix` (idiomatic AdonisJS routes, NOT controllers).
 */
export interface MediaResumableConfig {
  /**
   * Name of the session store (a key of {@link stores} below). Omit to use the in-memory store
   * (single-process, non-durable).
   */
  store?: string;
  /** Named session stores, built with the {@link uploadSessions} factory (lazy peers). */
  stores?: Record<string, UploadSessionStoreFactory>;
  /** Prefix for temporary chunk parts on the target disk (buffered path). Default `.uploads`. */
  tmpPrefix?: string;
  /** Session lifetime in seconds (TUS `expiration`). Omit for sessions that never expire. */
  sessionTtlSeconds?: number;
  /** Mount the built-in TUS HTTP routes. Opt-in. */
  routes?: {
    /** Register the routes. Default false. */
    enabled?: boolean;
    /** Path prefix for the TUS routes. Default `/media/uploads/tus`. */
    prefix?: string;
    /** Disk resumable uploads land on. Defaults to the media default disk. */
    disk?: string;
    /** Reject creations whose `Upload-Length` exceeds this many bytes. */
    maxSize?: number;
  };
}

/**
 * Shape of `config/media.ts`. Storage is delegated to `@adonisjs/drive` — the `disk` is the name of a
 * disk in your `config/drive.ts`; omit it to use Drive's default disk. Pick a `store` by name from the
 * `stores` map (built with the {@link stores} factory so each peer is imported lazily). Conversions need
 * an `imageProcessor` (use `processors.sharp()` for the optional sharp peer, or pass your own instance).
 *
 * ```ts
 * import { defineConfig, stores, processors } from '@adonis-agora/media'
 *
 * export default defineConfig({
 *   disk: 's3',
 *   store: 'lucid',
 *   stores: {
 *     memory: stores.memory(),
 *     lucid: stores.lucid({ connection: 'pg' }),
 *   },
 *   imageProcessor: processors.sharp(),
 *   collections: [
 *     { name: 'avatar', single: true, acceptsMimeTypes: ['image/png', 'image/jpeg'] },
 *     { name: 'gallery', conversions: [{ name: 'thumb', width: 200 }, { name: 'og', width: 1200, eager: true }] },
 *   ],
 * })
 * ```
 */
export interface MediaConfig {
  /**
   * Name of the disk media is written to. Resolved first from the {@link disks} map (e.g. an
   * `disks.s3()` driver bundled with this package), then from your `@adonisjs/drive` config. Omit
   * to use Drive's default disk. A collection may override it per-collection, and each `attach`
   * call may override it per-call.
   */
  disk?: string;
  /**
   * Named disks built with the {@link disks} factory (e.g. `disks.s3({ bucket, region })`). Each
   * factory lazily imports its peer (the AWS SDK for S3) so it only loads when selected. Names here
   * take precedence over `@adonisjs/drive` disks of the same name.
   */
  disks?: Record<string, DiskFactory>;
  /** Name of the media store (a key of {@link stores}). Defaults to `memory` (single-process). */
  store?: string;
  /** Named media stores, built with the {@link stores} factory. */
  stores?: Record<string, StoreFactory>;
  /**
   * The image conversion engine. Either a ready {@link ImageProcessor} instance or an
   * {@link ImageProcessorFactory} built with the {@link processors} factory (e.g. `processors.sharp()`)
   * so the heavy peer is imported lazily. Required only if any collection defines conversions.
   */
  imageProcessor?: ImageProcessor | ImageProcessorFactory;
  /** Collection definitions (MIME whitelist, single-file replace, conversions). */
  collections?: MediaCollectionConfig[];
  /** Key prefix for column attachments created via the `AttachmentManager`. Default `attachments`. */
  attachmentKeyPrefix?: string;
  /** Emit `agora:media:*` diagnostics events (default true). */
  emitDiagnostics?: boolean;
  /** Direct-S3 upload settings (default mode, part size, presign TTL, optional HTTP routes). */
  uploads?: MediaUploadsConfig;
}

/** Identity helper giving `config/media.ts` full type-checking. */
export function defineConfig(config: MediaConfig = {}): MediaConfig {
  return config;
}

export { stores, processors, disks, uploadSessions };
export type {
  StoreContext,
  StoreFactory,
  LucidStoreConfig,
  ImageProcessorFactory,
  DiskFactory,
  S3DiskConfig,
  S3Credentials,
  UploadMode,
  UploadSessionStoreContext,
  UploadSessionStoreFactory,
  LucidUploadSessionStoreConfig,
};
