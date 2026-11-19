import type { MediaIdentityResolver } from './access.js';
import type { MediaAccountConsoleOptions } from './account_console/extension.js';
import type { MediaTenancyOption } from './agora/tenancy.js';
import type { DeliveryMode, OnDemandImageConfig } from './delivery.js';
import type { DeliverySigningConfig } from './delivery_signing.js';
import type { DiskFactory, S3Credentials, S3DiskConfig } from './disks/factory.js';
import { disks } from './disks/factory.js';
import type { ImageProcessor } from './image_processor.js';
import type { MediaCollectionConfig } from './media_collection.js';
import type { ImageProcessorFactory } from './processors/factory.js';
import { processors } from './processors/factory.js';
import type { LucidStoreConfig, StoreContext, StoreFactory } from './stores/factory.js';
import { stores } from './stores/factory.js';
import type { TenantTokenSource, TenantVerifierInput } from './topology/auth.js';
import type { ControlPlaneAccountsOptions } from './topology/control_plane.js';
import { type MediaTopology, PARTITION_PATTERN } from './topology/protocol.js';
import type { ControlPlaneUrlSource } from './topology/tenant_client.js';
import type { TenantUrls } from './topology/tenant_library.js';
import { engines, transformers } from './transformers/factory.js';
import type { DirectUploadPolicy } from './types.js';
import type { UploadMode } from './upload_mode.js';
import type {
  LucidUploadSessionStoreConfig,
  UploadSessionStoreContext,
  UploadSessionStoreFactory,
} from './upload_sessions/factory.js';
import { uploadSessions } from './upload_sessions/factory.js';

/**
 * The default export of a lazy `policy` module: a {@link DirectUploadPolicy} CLASS (the provider
 * instantiates it with no arguments) or a ready policy OBJECT (used as-is).
 *
 * `DirectUploadPolicy` is INVARIANT in `Ctx` and `C` — its methods receive `InitiateDecision<C>` /
 * `CompleteResolution<C>` as inputs — so a concretely-typed policy (e.g. one over `HttpContext` and
 * a Lucid model) is NOT assignable to `DirectUploadPolicy<unknown, unknown>`. This config is the
 * existential boundary where the app's policy types meet the framework-neutral handler, so the
 * policy is typed `<any, any>`: the one typing that admits every concrete policy. The `any` is
 * contained here; the handler still sees a fully-typed policy at its own boundary.
 */
export type DirectUploadPolicyModule =
  // biome-ignore lint/suspicious/noExplicitAny: invariant `Ctx` and `C` — see the doc above.
  (new (...args: unknown[]) => DirectUploadPolicy<any, any>) | DirectUploadPolicy<any, any>;

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
     * anything it imports — loads only when the routes mount. The provider reads its default export
     * (see {@link DirectUploadPolicyModule}): a policy class, instantiated with no arguments, or a
     * ready policy object.
     */
    policy?: () => Promise<{ default: DirectUploadPolicyModule }>;
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
  /**
   * On-demand resizing — the `?w=640&q=75` of a `next/image`-style loader, through
   * `MediaDeliveryHandler`. Only these widths and qualities are served (each resized once, then
   * cached as a conversion), so a client cannot fill the storage with arbitrary sizes. Defaults
   * match `next/image` and `@adonis-agora/media-react`'s loader.
   */
  images?: OnDemandImageConfig;
  /**
   * Sign delivery URLs (`media.library.deliveryUrl()`, and `image()` URLs): the route serves only
   * what the app signed, until it expires — no public URL, and an `<img>` carries its own
   * authorization. With `required` (the default), unsigned requests are refused.
   */
  signing?: DeliverySigningConfig;
  /**
   * The route the app mounts `MediaDeliveryHandler` on, with `:id` — what `deliveryUrl()` builds
   * URLs for. Default `/media/:id`.
   */
  path?: string;
  /**
   * The route the app mounts `media.access.streamRoute()` on, with `:id` and `:conversion` and
   * without the file part — what `media.library.stream()` builds manifest URLs for. Default
   * `/media/:id/stream/:conversion` (mounted as `/media/:id/stream/:conversion/*`).
   */
  streamPath?: string;
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
/** Media authorization (`media.access`). */
export interface MediaAccessConfig {
  /**
   * Who the current user is. Default: AdonisJS auth's `ctx.auth.user`. Apps on authkit use
   * `authkitIdentity()` from `@adonis-agora/media/authkit`.
   */
  identity?: MediaIdentityResolver;
}

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
  /**
   * Authorization: who the current user is (`identity`). The rules themselves live on each
   * collection (`collections[].access`) or are passed to `media.access.deliveryRoute()`.
   */
  access?: MediaAccessConfig;
  /**
   * Organizations as tenants. `'inherit'` (default) follows `tenancy.enabled` in
   * `config/context.ts`; `false` opts media out. Once on, new files are stamped with the active
   * tenant (and stored under `t/<tenantId>/`), and reads, serving and the console only see the
   * active tenant's files. Needs the `tenant_id` column: `node ace media:publish-migration tenancy`.
   */
  tenancy?: MediaTenancyOption;
  /**
   * A "My files" page in the authkit account console (`/account/files`), registered when
   * `@adonis-agora/authkit-server` (or authkit-client with remote pages) runs in the app. Nothing is
   * exposed until `collections` lists one; each listed collection gets browse, upload, rename,
   * delete and download, allowed by its own `access` rules. `false` registers nothing.
   */
  accountConsole?: false | MediaAccountConsoleOptions;
  /**
   * Answer another app's federated media console (its `config/media_dashboard.ts` → `apps`): that
   * console reads this app's records from the database and sends here, over Redis, what only this
   * app can do — list its disks, sign URLs for its objects, and (with `actions: true`) delete,
   * copy, move or abort. Every web instance listens; one claims each command and runs it.
   *
   * ```ts
   * consoleCommands: { connection: 'main', prefix: 'entretextos' },
   * ```
   *
   * Needs `@adonisjs/redis`. Off when omitted.
   */
  consoleCommands?: MediaConsoleCommandsConfig;
  /**
   * Where this app's media runs. `standalone` (default): its own records, disks and conversions.
   * `control-plane`: the same, and other apps keep their media here too, through the API under
   * `controlPlane.prefix` (needs `verifyTenant`). `tenant`: the records, files and conversions live
   * on a control plane (`tenant`); `media.library` keeps its API and runs it there.
   */
  topology?: MediaTopology;
  /**
   * Control plane only: validates a tenant app's token. The app (the partition) and its
   * capabilities (`media:read`, `media:write`) come from the verified token, never from the request.
   * A function, a class instance, or `() => import('./verifier.js')`.
   *
   * With authkit: `authkitTenantVerifier({ issuer, resource: 'urn:agora:media' })` from
   * `@adonis-agora/authkit-client`. Without it: `sharedSecretVerifier({ partitions })`.
   */
  verifyTenant?: TenantVerifierInput;
  /** Control plane only: the tenant API. */
  controlPlane?: MediaControlPlaneConfig;
  /** Tenant only: the control plane this app keeps its media on. */
  tenant?: MediaTenantConfig;
}

/** {@link MediaConfig.controlPlane}. */
export interface MediaControlPlaneConfig {
  /** Route prefix of the tenant API (mounted under `<prefix>/v1`). Default `/_media`. */
  prefix?: string;
  /** The collections tenants may use. Default: every collection. */
  collections?: string[];
  /** Largest upload, in bytes. Default 100 MiB. */
  maxBytes?: number;
  /**
   * A person's own files, shared by every app (an avatar): apps read them with their service token,
   * and a person's own access token writes to its `sub`.
   */
  accounts?: ControlPlaneAccountsOptions;
}

/** {@link MediaConfig.tenant}. */
export interface MediaTenantConfig {
  /**
   * The control plane's URL including its prefix (`https://hub.example.com/_media`), or
   * `controlPlaneUrl({ issuer, resource: 'urn:agora:media' })` from `@adonis-agora/authkit-client`
   * (found in the issuer's discovery document).
   */
  url: ControlPlaneUrlSource;
  /** This app's name on the control plane (the partition its token carries). */
  partition: string;
  /**
   * This app's token: `authkitTenantToken({ issuer, clientId, clientSecret, resource:
   * 'urn:agora:media' })` from `@adonis-agora/authkit-client`, a shared secret, or `{ get() }`.
   */
  token: TenantTokenSource;
  /**
   * Where `media.library.url()` and image URLs point: `app` (default), this app's delivery route
   * (`delivery.path`), which reads the bytes from the control plane; `control-plane`, the storage
   * URL the control plane hands out.
   */
  urls?: TenantUrls;
  /** Per request. Default 10000. */
  timeoutMs?: number;
  /** Per upload. Default 120000. */
  uploadTimeoutMs?: number;
  /** Retries of a read after a network error or a 5xx. Default 1. Writes are never retried. */
  retries?: number;
}

/** What a tenant does not have: its files live on the control plane. */
const TENANT_FORBIDDEN = [
  'disk',
  'disks',
  'store',
  'stores',
  'imageProcessor',
  'uploads',
  'tenancy',
  'consoleCommands',
  'accountConsole',
  'verifyTenant',
  'controlPlane',
] as const;

/** Refuses a topology that cannot work, at boot, with the change to make. */
export function assertMediaTopology(config: MediaConfig): void {
  const topology = config.topology ?? 'standalone';
  if (!['standalone', 'control-plane', 'tenant'].includes(topology)) {
    throw new Error(`media: unknown topology "${String(topology)}"`);
  }
  if (topology === 'tenant') {
    const tenant = config.tenant;
    if (!tenant?.url) throw new Error('media: tenant.url is required on a tenant');
    if (!tenant.partition || !PARTITION_PATTERN.test(tenant.partition)) {
      throw new Error('media: tenant.partition is required (1-64 characters of A-Z a-z 0-9 _ . -)');
    }
    if (!tenant.token) {
      throw new Error(
        "media: tenant.token is required (authkitTenantToken({ issuer, clientId, clientSecret, resource: 'urn:agora:media' }) or a shared secret)",
      );
    }
    if (typeof tenant.url === 'string' && !/^https?:\/\//.test(tenant.url)) {
      throw new Error('media: tenant.url must be an absolute http(s) URL or a function');
    }
    for (const key of ['timeoutMs', 'uploadTimeoutMs'] as const) {
      const value = tenant[key];
      if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
        throw new Error(`media: tenant.${key} must be a positive number of milliseconds`);
      }
    }
    if (
      tenant.retries !== undefined &&
      !(Number.isInteger(tenant.retries) && tenant.retries >= 0)
    ) {
      throw new Error('media: tenant.retries must be a whole number, 0 or more');
    }
    if (tenant.urls !== undefined && tenant.urls !== 'app' && tenant.urls !== 'control-plane') {
      throw new Error("media: tenant.urls is 'app' or 'control-plane'");
    }
    for (const key of TENANT_FORBIDDEN) {
      if (config[key] !== undefined) {
        throw new Error(
          `media: \`${key}\` does not apply to a tenant: its media lives on the control plane`,
        );
      }
    }
    return;
  }
  if (config.tenant !== undefined) {
    throw new Error('media: `tenant` only applies to topology "tenant"');
  }
  if (topology === 'control-plane') {
    const verify = config.verifyTenant as unknown;
    if (
      typeof verify !== 'function' &&
      !(
        verify &&
        typeof verify === 'object' &&
        typeof (verify as { verify?: unknown }).verify === 'function'
      )
    ) {
      throw new Error(
        "media: a control plane needs `verifyTenant` (authkitTenantVerifier({ issuer, resource: 'urn:agora:media' }) or sharedSecretVerifier({ partitions })): a tenant is never trusted without a token",
      );
    }
    const prefix = config.controlPlane?.prefix;
    if (prefix !== undefined && !/^\/[A-Za-z0-9_.~/-]*$/.test(prefix)) {
      throw new Error("media: controlPlane.prefix is a path starting with '/' (like '/_media')");
    }
    for (const [key, value] of [
      ['controlPlane.maxBytes', config.controlPlane?.maxBytes],
      ['controlPlane.accounts.maxBytes', config.controlPlane?.accounts?.maxBytes],
    ] as const) {
      if (value !== undefined && !(Number.isFinite(value) && value > 0)) {
        throw new Error(`media: ${key} must be a positive number of bytes`);
      }
    }
    const accounts = config.controlPlane?.accounts;
    if (accounts && typeof accounts.verifyUser !== 'function') {
      throw new Error('media: controlPlane.accounts.verifyUser is required');
    }
    if (accounts && (!Array.isArray(accounts.collections) || accounts.collections.length === 0)) {
      throw new Error('media: controlPlane.accounts.collections lists at least one collection');
    }
    return;
  }
  if (config.verifyTenant !== undefined || config.controlPlane !== undefined) {
    throw new Error(
      'media: `verifyTenant` and `controlPlane` only apply to topology "control-plane"',
    );
  }
}

/** {@link MediaConfig.consoleCommands}. */
export interface MediaConsoleCommandsConfig {
  /** The `@adonisjs/redis` connection. Defaults to its default connection. */
  connection?: string;
  /**
   * This app's name on the channel (`<prefix>-media-console`): the same `prefix` the other app's
   * console names in its `apps` entry. Not the connection's `keyPrefix`.
   */
  prefix: string;
  /**
   * Run the mutating commands too (delete a record, delete/copy/move objects and folders, abort an
   * upload). Default `false`: the other console may browse this app's media but not change it.
   */
  actions?: boolean;
}

/**
 * Identity helper giving `config/media.ts` full type-checking. The `const` type parameter keeps
 * collection/conversion/transformer names as literal types, so {@link InferConversions} /
 * {@link InferTransformers} can extract them from `typeof config` — no `as const` needed.
 */
export function defineConfig<const T extends MediaConfig>(config: T = {} as T): T {
  assertMediaTopology(config);
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
 *   collections: [{ name: 'videos', transformers: [transformers.video(), transformers.probe()] }],
 * })
 * type AppTransformer = InferTransformers<typeof config> // 'video' | 'probe'
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
 * type AppConversion = InferConversions<typeof config> // 'thumb' | 'og' | 'video' | 'probe'
 * ```
 */
export type InferConversions<T extends MediaConfig> =
  | NonNullable<CollectionOf<T>['conversions']>[number]['name']
  | InferTransformers<T>;

export type {
  DeliveryMode,
  DiskFactory,
  ImageProcessorFactory,
  LucidStoreConfig,
  LucidUploadSessionStoreConfig,
  S3Credentials,
  S3DiskConfig,
  StoreContext,
  StoreFactory,
  UploadMode,
  UploadSessionStoreContext,
  UploadSessionStoreFactory,
};
export { disks, engines, processors, stores, transformers, uploadSessions };
