import type { DeliveryMode } from './delivery.js';
import { disks } from './disks/factory.js';
import type { DiskFactory, S3Credentials, S3DiskConfig } from './disks/factory.js';
import type { ImageProcessor } from './image_processor.js';
import type { MediaCollectionConfig } from './media_collection.js';
import { processors } from './processors/factory.js';
import type { ImageProcessorFactory } from './processors/factory.js';
import { stores } from './stores/factory.js';
import type { LucidStoreConfig, StoreContext, StoreFactory } from './stores/factory.js';
import { transformers } from './transformers/factory.js';
import type { DirectUploadPolicy } from './types.js';
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
  /**
   * Session-backed direct upload settings (`media.direct`) — browser→S3 multipart through presigned
   * part URLs, with the session (uploadId, part size, confirmed ETags) persisted server-side so an
   * interrupted upload resumes after a page reload. Present ⇒ `media.direct` is available; when
   * `routes.enabled`, the provider mounts the JSON endpoints. Absent ⇒ disabled, no session store
   * is built. See {@link MediaDirectUploadConfig} for how this relates to TUS.
   */
  direct?: MediaDirectUploadConfig;
}

/**
 * Session-backed direct upload configuration. The session store is the SAME SPI (and, with
 * `uploadSessions.lucid()`, the same tables) the resumable (TUS) subsystem uses — the two flows are
 * complements, not rivals: TUS streams every chunk THROUGH the app (works on any disk, byte-exact
 * resume), while direct hands the browser presigned URLs and the bytes never touch the app (S3-only,
 * resumes at part granularity, needs bucket CORS exposing `ETag`). For video-sized files on S3,
 * direct halves the total bandwidth.
 */
export interface MediaDirectUploadConfig {
  /**
   * Name of the session store (a key of {@link stores} below). Omit to use the in-memory store
   * (single-process, non-durable — sessions won't survive a restart, uploads in flight will).
   */
  store?: string;
  /** Named session stores, built with the {@link uploadSessions} factory (lazy peers). */
  stores?: Record<string, UploadSessionStoreFactory>;
  /**
   * Multipart part size in bytes. Falls back to `uploads.partSize`, then 20 MiB. S3 requires at
   * least 5 MiB and at most 10,000 parts per upload.
   */
  partSize?: number;
  /**
   * Lifetime of presigned part URLs, in seconds. Falls back to `uploads.presignTtlSeconds`, then
   * 3600. Expiry never strands an upload: `status()` re-issues fresh URLs for pending parts.
   */
  presignTtlSeconds?: number;
  /** Session lifetime in seconds. Omit for sessions that never expire. */
  sessionTtlSeconds?: number;
  /** Mount the built-in direct-session HTTP routes. Opt-in. */
  routes?: {
    /** Register the routes. Default false. */
    enabled?: boolean;
    /** Path prefix for the routes. Default `/media/uploads/direct/sessions`. */
    prefix?: string;
    /** Disk uploads land on. Defaults to the media default disk (must be multipart-capable). */
    disk?: string;
    /** Reject initiations whose declared `size` exceeds this many bytes. */
    maxSize?: number;
    /**
     * Collection these uploads are destined for. Set it to have `initiate` reject a declared
     * `contentType` outside that collection's `acceptsMimeTypes` — before the multipart upload
     * even opens. The collection config remains the single source of truth; nothing is restated
     * here. Omit to accept any type (size limits still apply).
     */
    collection?: string;
    /**
     * Middleware applied to every built-in direct-session route (the provider passes them straight
     * to the AdonisJS route group). Typed framework-neutrally as `unknown[]` so this config never
     * imports AdonisJS — guard the routes here (e.g. `middleware.auth()`), since the handler itself
     * performs NO authorization.
     */
    middleware?: readonly unknown[];
    /**
     * Lazily load a {@link DirectUploadPolicy} that owns the app-specific decisions (key resolution,
     * what the upload becomes on completion, error→HTTP mapping). A thunk so the policy module — and
     * anything it imports — loads only when the routes mount. The provider reads its default export.
     */
    policy?: () => Promise<{ default: DirectUploadPolicy<unknown, unknown> }>;
  };
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
    /**
     * Collection these uploads are destined for. Set it to have the TUS endpoint enforce that
     * collection's `acceptsMimeTypes` up front — at `POST` from the declared `filetype`, and on the
     * first `PATCH` from the real file signature — instead of only discovering the wrong type at
     * attach time, after the whole file was uploaded. The collection config remains the single
     * source of truth; nothing is restated here. Omit to accept any type (size limits still apply).
     */
    collection?: string;
  };
}

/**
 * How stored media reaches the client — the READ counterpart to {@link MediaUploadsConfig.mode}.
 *
 * The library resolves this into either a URL to redirect to or a stream to pipe
 * ({@link MediaLibrary.deliver} / `MediaDeliveryHandler`); it never mounts a route of its own,
 * because serving a record is an authorization decision only the app can make.
 */
export interface MediaDeliveryConfig {
  /**
   * `public` = the disk's stable public URL; `signed` = a time-limited signed URL; `proxy` = stream
   * the bytes through the app, so the storage need not be reachable from the internet at all.
   * `auto` asks the disk for the object's visibility — public ⇒ `public`, otherwise (including a
   * disk that cannot answer) ⇒ `signed`. Default `auto`.
   */
  mode?: DeliveryMode;
  /** Lifetime of the signed URL when delivery resolves to `signed`. Default 300. */
  signedTtlSeconds?: number;
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
  /** Collection definitions (MIME whitelist, single-file replace, conversions, transformers). */
  collections?: readonly MediaCollectionConfig[];
  /** Key prefix for column attachments created via the `AttachmentManager`. Default `attachments`. */
  attachmentKeyPrefix?: string;
  /** Emit `agora:media:*` diagnostics events (default true). */
  emitDiagnostics?: boolean;
  /** Direct-S3 upload settings (default mode, part size, presign TTL, optional HTTP routes). */
  uploads?: MediaUploadsConfig;
  /** How stored media is served back (`auto`/`public`/`signed`/`proxy` + signed-URL TTL). */
  delivery?: MediaDeliveryConfig;
}

/**
 * Identity helper giving `config/media.ts` full type-checking. The `const` type parameter keeps
 * collection/conversion/transformer names as literal types, so {@link InferConversions} /
 * {@link InferTransformers} can extract them from `typeof config` — no `as const` needed.
 */
export function defineConfig<const T extends MediaConfig>(config: T = {} as T): T {
  return config;
}

/** The collection literal types of a config (helper for the `Infer*` utilities). */
type CollectionOf<T extends MediaConfig> = T['collections'] extends readonly (infer C extends
  MediaCollectionConfig)[]
  ? C
  : never;

/**
 * Union of the transformer names a config declares — for typing job payloads, `transform()` call
 * sites, and route params against the config instead of restating strings:
 *
 * ```ts
 * const config = defineConfig({
 *   collections: [{ name: 'videos', transformers: [transformers.hls(), transformers.probe()] }],
 * })
 * type AppTransformer = InferTransformers<typeof config> // 'hls' | 'probe'
 * ```
 */
export type InferTransformers<T extends MediaConfig> = NonNullable<
  CollectionOf<T>['transformers']
>[number]['name'];

/**
 * Union of every conversion name a config declares — image presets and transformers alike, since
 * both persist under `record.conversions`:
 *
 * ```ts
 * type AppConversion = InferConversions<typeof config> // 'thumb' | 'og' | 'hls' | 'probe'
 * ```
 */
export type InferConversions<T extends MediaConfig> =
  | NonNullable<CollectionOf<T>['conversions']>[number]['name']
  | InferTransformers<T>;

export { stores, processors, disks, uploadSessions, transformers };
export type {
  StoreContext,
  StoreFactory,
  LucidStoreConfig,
  ImageProcessorFactory,
  DiskFactory,
  S3DiskConfig,
  S3Credentials,
  UploadMode,
  DeliveryMode,
  UploadSessionStoreContext,
  UploadSessionStoreFactory,
  LucidUploadSessionStoreConfig,
};
