import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, HttpRouterService } from '@adonisjs/core/types';
import type { MiddlewareFn, ParsedNamedMiddleware } from '@adonisjs/core/types/http';
import type { DirectUploadPolicyModule, MediaConfig } from '../src/define_config.js';
import { DirectUploadHandler } from '../src/direct_upload_handler.js';
import type { DirectUploadRequest } from '../src/direct_upload_handler.js';
import { createDriveBackedResolver } from '../src/disks/drive.js';
import type { DriveServiceModule } from '../src/disks/drive.js';
import { resolveConfiguredDisks } from '../src/disks/factory.js';
import type { ImageProcessor } from '../src/image_processor.js';
import { MediaManager } from '../src/media_manager.js';
import type { UploadSessionStore } from '../src/resumable_upload.js';
import { setBootedApp } from '../src/services/booted_app.js';
import { resolveStore } from '../src/stores/factory.js';
import type { StoreContext } from '../src/stores/factory.js';
import { TusUploadHandler } from '../src/tus.js';
import type { TusRequest } from '../src/tus.js';
import type { DirectUploadPolicy, MultipartPart } from '../src/types.js';
import { resolveUploadSessionStore } from '../src/upload_sessions/factory.js';

/**
 * Wires `@adonis-agora/media` into the AdonisJS application: binds a singleton {@link MediaManager}
 * built from `config/media.ts`. Storage is delegated to `@adonisjs/drive` — the manager resolves disks
 * from the booted Drive manager, so this package never reimplements disk drivers. The selected store
 * (`memory` / `lucid`) and image processor (`processors.sharp()`) are built lazily from the config so
 * their peer dependencies (`@adonisjs/lucid`, `sharp`) load only when chosen.
 *
 * ```ts
 * const media = await app.container.make(MediaManager)
 * await media.library.attach({ ownerType: 'Post', ownerId: '1', collection: 'gallery', ... })
 * ```
 */
export default class MediaProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    // Hand the booted app to the internal singleton so it never has to `import` an
    // `@adonisjs/core` copy that may not be the one `bin/server` booted (see
    // `../src/services/booted_app.js`) — mirrors the fix already applied to the `@adonisjs/lucid`
    // `Database` token (`'lucid.db'` string alias) for the same class of dual-package hazard.
    setBootedApp(this.app);

    this.app.container.singleton(MediaManager, async () => {
      const config = this.app.config.get<MediaConfig>('media', {});

      // Validate + build the store from config first, so a misconfigured `store` fails fast (before
      // we touch Drive) rather than silently booting on a non-durable in-memory fallback.
      const ctx: StoreContext = { app: this.app };
      const store = await resolveStore(config, ctx);
      const imageProcessor = await this.#resolveImageProcessor(config);

      // Build the resumable (TUS) session store only when `uploads.resumable` is configured, so its
      // peer (`@adonisjs/lucid`) loads lazily and the resumable subsystem stays fully opt-in.
      const resumable = config.uploads?.resumable;
      const uploadSessions: UploadSessionStore | undefined = resumable
        ? await resolveUploadSessionStore(
            {
              ...(resumable.store !== undefined ? { store: resumable.store } : {}),
              ...(resumable.stores !== undefined ? { stores: resumable.stores } : {}),
            },
            { app: this.app },
          )
        : undefined;

      // Same lazy, opt-in construction for the session-backed direct upload store. It may share
      // the resumable store's Lucid tables, but each subsystem owns its store INSTANCE so enabling
      // one never implies the other.
      const direct = config.uploads?.direct;
      const directUploadSessions: UploadSessionStore | undefined = direct
        ? await resolveUploadSessionStore(
            {
              ...(direct.store !== undefined ? { store: direct.store } : {}),
              ...(direct.stores !== undefined ? { stores: direct.stores } : {}),
            },
            { app: this.app },
          )
        : undefined;

      // Build any disks declared in `config.disks` (e.g. the bundled `disks.s3()` driver). Each
      // factory lazily loads its peer (the AWS SDK), so nothing is imported unless an S3 disk is
      // actually configured.
      const configuredDisks = await resolveConfiguredDisks(config.disks);

      // Resolve disks from Drive without a hard dependency: import its service lazily. We keep the
      // module NAMESPACE, never a value read out of it — Drive assigns its manager inside
      // `app.booted(...)`, which resolves immediately while the app is still booting, so the export
      // is `undefined` at this point and only the live binding sees the later assignment. The
      // resolver reads it at the first real disk use and memoizes it (see `createDriveBackedResolver`).
      const driveService = (await import(
        '@adonisjs/drive/services/main'
      )) as unknown as DriveServiceModule;
      const defaultDisk = config.disk ?? (await this.#resolveDefaultDiskName());

      // A disk named in `config.disks` wins over a Drive disk of the same name; otherwise fall
      // through to Drive so existing Drive disks keep working unchanged.
      const resolve = createDriveBackedResolver({ driveService, configuredDisks, defaultDisk });

      return new MediaManager({
        defaultDisk,
        resolve,
        store,
        ...(imageProcessor !== undefined ? { imageProcessor } : {}),
        ...(config.collections !== undefined ? { collections: config.collections } : {}),
        ...(config.attachmentKeyPrefix !== undefined
          ? { attachmentKeyPrefix: config.attachmentKeyPrefix }
          : {}),
        ...(config.emitDiagnostics !== undefined
          ? { emitDiagnostics: config.emitDiagnostics }
          : {}),
        ...(config.uploads?.mode !== undefined ? { uploadMode: config.uploads.mode } : {}),
        ...(config.uploads?.partSize !== undefined
          ? { uploadPartSize: config.uploads.partSize }
          : {}),
        ...(config.uploads?.presignTtlSeconds !== undefined
          ? { uploadPresignTtlSeconds: config.uploads.presignTtlSeconds }
          : {}),
        ...(uploadSessions !== undefined ? { uploadSessions } : {}),
        ...(resumable?.tmpPrefix !== undefined ? { resumableTmpPrefix: resumable.tmpPrefix } : {}),
        ...(resumable?.sessionTtlSeconds !== undefined
          ? { resumableSessionTtlSeconds: resumable.sessionTtlSeconds }
          : {}),
        ...(directUploadSessions !== undefined ? { directUploadSessions } : {}),
        // Direct settings fall back to the shared `uploads.*` knobs, so one part size / TTL can
        // govern both the raw primitives and the session flow.
        ...((direct?.partSize ?? config.uploads?.partSize)
          ? { directPartSize: (direct?.partSize ?? config.uploads?.partSize) as number }
          : {}),
        ...((direct?.presignTtlSeconds ?? config.uploads?.presignTtlSeconds)
          ? {
              directPresignTtlSeconds: (direct?.presignTtlSeconds ??
                config.uploads?.presignTtlSeconds) as number,
            }
          : {}),
        ...(direct?.sessionTtlSeconds !== undefined
          ? { directSessionTtlSeconds: direct.sessionTtlSeconds }
          : {}),
        // Delivery is config only — no route is mounted for it, deliberately: serving a record is
        // an authorization decision, so the app owns the route (see `MediaDeliveryHandler`).
        ...(config.delivery?.mode !== undefined ? { deliveryMode: config.delivery.mode } : {}),
        ...(config.delivery?.signedTtlSeconds !== undefined
          ? { deliverySignedTtlSeconds: config.delivery.signedTtlSeconds }
          : {}),
      });
    });
  }

  /**
   * Mount the media routes once the app has booted (see the comment inside for why). No-ops when
   * neither the TUS resumable routes nor the direct-upload routes are enabled in config.
   */
  async boot() {
    // Route registration can't happen synchronously in `boot()`: at this point in the AdonisJS
    // lifecycle the HTTP server/router binding may not be resolvable yet (bindings from other
    // providers' `boot()` methods can still be pending), and — critically — the *documented*
    // `@adonisjs/core/services/router` singleton is only assigned once the app's "booted" hooks run
    // (`await app.booted(async () => { router = ... })` inside that service module itself), which
    // fire strictly AFTER every provider's own `boot()`. A provider that imports that singleton and
    // calls `router.get(...)` directly inside `boot()` crashes every entrypoint (serve/ace/tests)
    // that registers it, because `router` is still `undefined` at that point — the same hazard this
    // provider now avoids for `MediaManager` itself (see `../src/services/booted_app.js`).
    //
    // Deferring to `app.booted(...)` runs our route registration as another "booted" hook — the
    // same mechanism the router service uses to become available in the first place — which is
    // guaranteed to fire BEFORE the HTTP server's own `boot()` commits the router (the last point at
    // which routes can still be added; see `Server#boot()` in `@adonisjs/http-server`, which runs
    // inside `app.start()`, strictly after all "booted" hooks). Resolving `router` fresh from the
    // container here (rather than depending on that service singleton) is also the same pattern
    // `@adonisjs/core`'s own `AppServiceProvider` and `@adonis-agora/durable`'s `DashboardProvider`
    // use internally, and is immune to the dual-package hazard for the same reason `booted_app.ts`
    // is: it comes from `this.app` (captured at registration), never from a module-level import.
    await this.app.booted(async () => {
      const router = await this.app.container.make('router');
      this.#registerRoutes(router);
    });
  }

  /**
   * Mount the optional direct-S3 upload routes when `uploads.routes.enabled` is set. These are plain
   * AdonisJS routes (NOT controllers): each resolves the {@link MediaManager} singleton lazily and
   * delegates to its upload methods. The object key is taken from the request body/query — resolve
   * it server-side (per user/tenant) in a real app so a client can't point an upload at another
   * object.
   *
   * Routes (relative to `uploads.routes.prefix`, default `/media/uploads`):
   * - `POST   /direct/initiate`                    → presign multipart parts
   * - `POST   /direct/:uploadId/parts/:partNumber` → presign one (retried) part
   * - `POST   /direct/:uploadId/complete`          → assemble the parts
   * - `DELETE /direct/:uploadId`                   → abort the upload
   * - `PUT    /proxy`                              → stream bytes through the app (proxy mode)
   */
  #registerRoutes(router: HttpRouterService) {
    const config = this.app.config.get<MediaConfig>('media', {});
    this.#mountTusRoutes(router, config);
    this.#mountDirectSessionRoutes(router, config);

    const routes = config.uploads?.routes;
    if (!routes?.enabled) return;

    const prefix = (routes.prefix ?? '/media/uploads').replace(/\/+$/, '');
    const manager = () => this.app.container.make(MediaManager);

    const json = (
      handler: (media: MediaManager, ctx: HttpContext) => Promise<unknown>,
      okStatus = 200,
    ) => {
      return async (ctx: HttpContext) => {
        try {
          const result = await handler(await manager(), ctx);
          return ctx.response.status(okStatus).json(result ?? { ok: true });
        } catch (error) {
          const message = error instanceof Error ? error.message : 'upload error';
          const code = (error as { code?: string }).code;
          return ctx.response
            .status(code === 'E_MEDIA_UPLOAD_NOT_SUPPORTED' ? 400 : 500)
            .json({ error: message, ...(code !== undefined ? { code } : {}) });
        }
      };
    };

    router
      .post(
        `${prefix}/direct/initiate`,
        json(async (media, ctx) => {
          const body = ctx.request.body() as {
            key: string;
            contentType?: string;
            visibility?: 'public' | 'private';
            size?: number;
            partSize?: number;
            disk?: string;
          };
          return media.initiateDirectUpload({
            key: body.key,
            ...(body.contentType !== undefined ? { contentType: body.contentType } : {}),
            ...(body.visibility !== undefined ? { visibility: body.visibility } : {}),
            ...(body.size !== undefined ? { size: body.size } : {}),
            ...(body.partSize !== undefined ? { partSize: body.partSize } : {}),
            ...(body.disk !== undefined ? { disk: body.disk } : {}),
          });
        }),
      )
      .as('media.uploads.direct.initiate');

    router
      .post(
        `${prefix}/direct/:uploadId/parts/:partNumber`,
        json(async (media, ctx) => {
          const key = requireKey(ctx);
          const disk = readDisk(ctx);
          return media.uploads.presignPart({
            key,
            uploadId: String(ctx.params.uploadId),
            partNumber: Number(ctx.params.partNumber),
            ...(disk !== undefined ? { disk } : {}),
          });
        }),
      )
      .as('media.uploads.direct.presignPart');

    router
      .post(
        `${prefix}/direct/:uploadId/complete`,
        json(async (media, ctx) => {
          const body = ctx.request.body() as { key: string; parts: MultipartPart[]; disk?: string };
          return media.completeDirectUpload({
            key: body.key,
            uploadId: String(ctx.params.uploadId),
            parts: body.parts,
            ...(body.disk !== undefined ? { disk: body.disk } : {}),
          });
        }),
      )
      .as('media.uploads.direct.complete');

    router
      .delete(
        `${prefix}/direct/:uploadId`,
        json(async (media, ctx) => {
          const key = requireKey(ctx);
          const disk = readDisk(ctx);
          await media.abortDirectUpload({
            key,
            uploadId: String(ctx.params.uploadId),
            ...(disk !== undefined ? { disk } : {}),
          });
          return { ok: true };
        }),
      )
      .as('media.uploads.direct.abort');

    router
      .put(
        `${prefix}/proxy`,
        json(async (media, ctx) => {
          const key = requireKey(ctx);
          const disk = readDisk(ctx);
          const contentType = ctx.request.header('content-type');
          return media.proxyUpload({
            key,
            // The raw Node request is a Readable — stream it straight to the disk without buffering.
            contents: ctx.request.request,
            ...(contentType !== undefined ? { contentType } : {}),
            ...(disk !== undefined ? { disk } : {}),
          });
        }, 201),
      )
      .as('media.uploads.proxy');
  }

  /**
   * Mount the optional TUS resumable-upload routes when `uploads.resumable.routes.enabled`. Like the
   * direct routes these are plain AdonisJS routes (NOT controllers): each resolves the singleton
   * {@link MediaManager} lazily and drives a framework-agnostic {@link TusUploadHandler} over
   * `media.resumable`. The handler is built once, lazily, from the resolved manager.
   *
   * Routes (relative to `uploads.resumable.routes.prefix`, default `/media/uploads/tus`):
   * - `OPTIONS /`      → protocol discovery (version, extensions, max size)
   * - `POST    /`      → create a session (`Upload-Length` + `Upload-Metadata`) → `201` + `Location`
   * - `HEAD    /:id`   → report `Upload-Offset` (resume point)
   * - `PATCH   /:id`   → append bytes at `Upload-Offset`; auto-completes at the declared length
   * - `DELETE  /:id`   → terminate the upload
   *
   * Set `uploads.resumable.routes.collection` to have the handler enforce that collection's
   * `acceptsMimeTypes` at create time and on the first chunk (`415`), instead of only at attach.
   */
  #mountTusRoutes(router: HttpRouterService, config: MediaConfig) {
    const resumable = config.uploads?.resumable;
    if (!resumable?.routes?.enabled) return;

    const prefix = (resumable.routes.prefix ?? '/media/uploads/tus').replace(/\/+$/, '');
    const routeDisk = resumable.routes.disk;
    const maxSize = resumable.routes.maxSize;
    const collection = resumable.routes.collection;

    // Build the TUS handler once, on first request, from the resolved MediaManager singleton.
    let handler: TusUploadHandler | undefined;
    const getHandler = async (): Promise<TusUploadHandler> => {
      if (!handler) {
        const media = await this.app.container.make(MediaManager);
        handler = new TusUploadHandler({
          manager: media.resumable,
          disk: routeDisk ?? media.storage.defaultDisk,
          basePath: prefix,
          // The collection's `acceptsMimeTypes` is read from the manager's registry, never restated
          // here, so the TUS gate and the attach-time barrier can never disagree.
          collections: media.collections,
          ...(collection !== undefined ? { collection } : {}),
          ...(maxSize !== undefined ? { maxSize } : {}),
        });
      }
      return handler;
    };

    const run = (method: TusRequest['method'], withBody = false) => {
      return async (ctx: HttpContext) => {
        const tus = await getHandler();
        const headers: Record<string, string | undefined> = {};
        for (const [name, value] of Object.entries(ctx.request.headers())) {
          headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value;
        }
        const req: TusRequest = { method, headers };
        if (ctx.params.id !== undefined) req.uploadId = String(ctx.params.id);
        if (withBody) req.body = await readRawBody(ctx);

        const res = await tus.handle(req);
        for (const [name, value] of Object.entries(res.headers)) {
          ctx.response.header(name, value);
        }
        ctx.response.status(res.status);
        return res.body ?? '';
      };
    };

    router.route(prefix, ['OPTIONS'], run('OPTIONS')).as('media.uploads.tus.options');
    router.post(prefix, run('POST')).as('media.uploads.tus.create');
    router.route(`${prefix}/:id`, ['HEAD'], run('HEAD')).as('media.uploads.tus.head');
    router.patch(`${prefix}/:id`, run('PATCH', true)).as('media.uploads.tus.patch');
    router.delete(`${prefix}/:id`, run('DELETE')).as('media.uploads.tus.delete');
  }

  /**
   * Mount the optional session-backed direct upload routes when `uploads.direct.routes.enabled`.
   * Plain AdonisJS routes (NOT controllers), each driving a framework-agnostic
   * {@link DirectUploadHandler} over `media.direct` — mirroring the TUS mount. The client sends a
   * `fileName`, never a key: the key is resolved server-side by the handler's `keyFor`.
   *
   * Routes (relative to `uploads.direct.routes.prefix`, default `/media/uploads/direct/sessions`):
   * - `POST   /`                      → initiate: persist a session, presign every part URL
   * - `GET    /:id`                   → status: confirmed ETags + fresh URLs for pending parts
   * - `POST   /:id/parts/:partNumber` → confirm one uploaded part's ETag
   * - `POST   /:id/complete`          → assemble the parts into the final object
   * - `DELETE /:id`                   → abort
   *
   * Like every built-in route these are UNGUARDED — add your own auth middleware, or leave them off
   * and mount your own routes over the handler/manager.
   */
  #mountDirectSessionRoutes(router: HttpRouterService, config: MediaConfig) {
    const direct = config.uploads?.direct;
    if (!direct?.routes?.enabled) return;

    const prefix = (direct.routes.prefix ?? '/media/uploads/direct/sessions').replace(/\/+$/, '');
    const routeDisk = direct.routes.disk;
    const maxSize = direct.routes.maxSize;
    const collection = direct.routes.collection;
    const policyThunk = direct.routes.policy;
    const routeMiddleware = direct.routes.middleware;

    // Build the handler once, on first request, from the resolved MediaManager singleton. The
    // policy (when configured) is lazy-imported here too, so its module loads only if the routes
    // actually serve a request. `adopt` wires the policy's `complete` path onto the library.
    let handler: DirectUploadHandler | undefined;
    const getHandler = async (): Promise<DirectUploadHandler> => {
      if (!handler) {
        const media = await this.app.container.make(MediaManager);
        const policy = await this.#resolveDirectUploadPolicy(policyThunk);
        handler = new DirectUploadHandler({
          manager: media.direct,
          adopt: media.completeDirectUploadToLibrary.bind(media),
          ...(routeDisk !== undefined ? { disk: routeDisk } : {}),
          ...(collection !== undefined ? { collection } : {}),
          ...(maxSize !== undefined ? { maxSize } : {}),
          ...(policy !== undefined ? { policy } : {}),
        });
      }
      return handler;
    };

    const run = (toRequest: (ctx: HttpContext) => DirectUploadRequest) => {
      return async (ctx: HttpContext) => {
        const direct_ = await getHandler();
        const res = await direct_.handle(toRequest(ctx), ctx);
        ctx.response.status(res.status);
        return res.body ?? '';
      };
    };

    // The five session endpoints, grouped so `routes.middleware` (e.g. `middleware.auth()`) guards
    // them all at once. Paths are relative to the group `prefix`. Empty middleware ⇒ the routes stay
    // UNGUARDED, exactly as before this seam existed.
    router
      .group(() => {
        router
          .post(
            '/',
            run((ctx) => {
              const body = ctx.request.body() as {
                fileName: string;
                size: number;
                contentType?: string;
                metadata?: Record<string, string>;
              };
              return {
                action: 'initiate',
                fileName: body.fileName,
                size: body.size,
                ...(body.contentType !== undefined ? { contentType: body.contentType } : {}),
                ...(body.metadata !== undefined ? { metadata: body.metadata } : {}),
              };
            }),
          )
          .as('media.uploads.direct.sessions.initiate');

        router
          .get(
            '/:id',
            run((ctx) => ({ action: 'status', uploadId: String(ctx.params.id) })),
          )
          .as('media.uploads.direct.sessions.status');

        router
          .post(
            '/:id/parts/:partNumber',
            run((ctx) => {
              const body = ctx.request.body() as { etag: string };
              return {
                action: 'confirm-part',
                uploadId: String(ctx.params.id),
                partNumber: Number(ctx.params.partNumber),
                etag: body.etag,
              };
            }),
          )
          .as('media.uploads.direct.sessions.confirmPart');

        router
          .post(
            '/:id/complete',
            run((ctx) => {
              const body = ctx.request.body() as { parts?: MultipartPart[] };
              return {
                action: 'complete',
                uploadId: String(ctx.params.id),
                ...(body.parts !== undefined ? { parts: body.parts } : {}),
              };
            }),
          )
          .as('media.uploads.direct.sessions.complete');

        router
          .delete(
            '/:id',
            run((ctx) => ({ action: 'abort', uploadId: String(ctx.params.id) })),
          )
          .as('media.uploads.direct.sessions.abort');
      })
      .prefix(prefix)
      .middleware((routeMiddleware ?? []) as (MiddlewareFn | ParsedNamedMiddleware)[]);
  }

  /**
   * Resolve the configured direct-upload {@link DirectUploadPolicy} from its lazy thunk, reading the
   * module's default export. The default export may be a policy CLASS (instantiated here with no
   * arguments) or a ready policy OBJECT (used as-is). Returns `undefined` when no policy is
   * configured, leaving the handler on its built-in key/complete behavior.
   */
  async #resolveDirectUploadPolicy(
    thunk?: () => Promise<{ default: DirectUploadPolicyModule }>,
  ): Promise<DirectUploadPolicy<unknown, unknown> | undefined> {
    if (!thunk) return undefined;
    const policy = (await thunk()).default;
    return typeof policy === 'function' ? new policy() : policy;
  }

  /** A config `imageProcessor` may be a ready instance or a lazy factory thunk. */
  async #resolveImageProcessor(config: MediaConfig): Promise<ImageProcessor | undefined> {
    const ip = config.imageProcessor;
    if (!ip) return undefined;
    if (typeof ip === 'function') return ip();
    return ip;
  }

  /**
   * When `config/media.ts` names no `disk`, fall back to Drive's configured default disk name.
   *
   * `app.config.get('drive')` returns the value `config/drive.ts` EXPORTED, and Drive's
   * `defineConfig()` returns an unresolved `ConfigProvider` — `{ type: 'provider', resolver }`. So the
   * default disk name is not a property of that value at all: reading `.default` off it always yields
   * `undefined` (this method used to, and therefore always returned the literal `'default'`), and so
   * does reading `.config.default` — `{ config: { default, fakes, services } }` is the shape the
   * resolver RETURNS, never the shape of the provider itself.
   *
   * The provider therefore has to be resolved, which is exactly what Drive's own provider does before
   * building its manager (`configProvider.resolve(app, app.config.get('drive'))` →
   * `new DriveManager(resolved.config)`). Asking the manager instead is not possible: flydrive's
   * `DriveManager` keeps that config in a `#private` field and exposes no accessor for the default
   * service name (`use()`/`fake()`/`restore()` only default TO it internally).
   *
   * Resolving here is cheap and side-effect free for our purposes: it builds throwaway driver
   * FACTORIES (no driver is constructed, no credentials read) and returns a fresh `locallyServed`
   * array that we discard, so Drive's own resolution — and the file-serving routes it mounts from it —
   * are untouched. `configProvider` is imported lazily, so a host that names its `disk` explicitly
   * never pays for it.
   *
   * A host may also assign a plain object to `drive` (or have no Drive config at all); both still
   * work, and `'default'` remains the last resort so such an app keeps booting instead of crashing.
   */
  async #resolveDefaultDiskName(): Promise<string> {
    const driveConfig = this.app.config.get<DriveConfigValue>('drive');
    if (driveConfig === undefined || driveConfig === null) return 'default';

    const { configProvider } = await import('@adonisjs/core');
    // Returns `null` when the value is not a ConfigProvider, which is also how we detect the
    // plain-object case — one source of truth for "is this a config provider", the framework's own.
    const resolved = await configProvider.resolve<ResolvedDriveConfig>(this.app, driveConfig);
    if (resolved) return resolved.config?.default ?? resolved.default ?? 'default';

    return (driveConfig as PlainDriveConfig).default ?? 'default';
  }
}

/**
 * The `drive` config value as it ACTUALLY appears in `app.config` — the unresolved
 * `ConfigProvider` Drive's `defineConfig()` returns, or a plain object for a host that hand-rolls it.
 * Deliberately NOT declared as `{ default?: string }`: that annotation is what made the old fallback
 * look correct to every reader and reviewer, because a generic on `config.get()` is an assertion
 * about data TypeScript never sees, not a check.
 */
type PlainDriveConfig = { default?: string };
type DriveConfigValue = { type: 'provider'; resolver: unknown } | PlainDriveConfig;

/**
 * What resolving Drive's config provider yields. `config.default` is the default disk name (Drive
 * feeds `resolved.config` straight into `new DriveManager(...)`); `default` is only read as a
 * tolerance for a differently-shaped provider.
 */
type ResolvedDriveConfig = { config?: { default?: string }; default?: string };

/** Read the object key from the query or JSON body; throw a 400-mappable error when absent. */
function requireKey(ctx: HttpContext): string {
  const fromQuery = ctx.request.input('key');
  const key = typeof fromQuery === 'string' ? fromQuery : undefined;
  if (key) return key;
  throw Object.assign(new Error('key is required'), { code: 'E_MEDIA_UPLOAD_NOT_SUPPORTED' });
}

/** Read an optional disk-name override from the query or JSON body. */
function readDisk(ctx: HttpContext): string | undefined {
  const value = ctx.request.input('disk');
  return typeof value === 'string' ? value : undefined;
}

/**
 * Buffer the raw request body for a TUS `PATCH`. The chunk arrives as
 * `application/offset+octet-stream`, which the AdonisJS bodyparser leaves untouched, so the raw Node
 * request stream still holds the bytes.
 */
async function readRawBody(ctx: HttpContext): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of ctx.request.request) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}
