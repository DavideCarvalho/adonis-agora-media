import { readFile } from 'node:fs/promises';
import { basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HttpContext } from '@adonisjs/core/http';
import type { ApplicationService, HttpRouterService } from '@adonisjs/core/types';
import {
  SESSION_COOKIE_NAME,
  parseCookieHeader,
  serializeSetCookie,
} from '../src/dashboard/cookie.js';
import type { MediaDashboardConfig } from '../src/dashboard/define_config.js';
import {
  type ConsoleSession,
  type ConsoleSessionUser,
  DashboardError,
  DashboardService,
  type LoginBody,
  type MeResponse,
  type ResolvedConsoleAuth,
  resolveConsoleAuth,
  signSessionCookie,
  verifySessionCookie,
} from '../src/dashboard/index.js';
import { contentTypeFor, normalizePath, renderIndexHtml } from '../src/dashboard/spa.js';
import { MediaManager } from '../src/media_manager.js';

/**
 * Directory of the built SPA (`dist/spa`, copied in by `copy:stubs` — see `package.json` — from
 * `@adonis-agora/media-dashboard`'s own build), relative to this compiled provider
 * (`dist/providers`). Resolved lazily (not at module scope): `fileURLToPath` throws on any
 * non-`file:` `import.meta.url`, which would make this provider unimportable under a test runner
 * that doesn't use real file URLs.
 */
let spaDir: string | undefined;
function spaDirectory(): string {
  spaDir ??= fileURLToPath(new URL('../assets/spa/', import.meta.url));
  return spaDir;
}

/** Cookie `Path` for the built-in session — deliberately `/`, not scoped to `apiBase`: the SPA's
 *  `basePath` and its `apiBase` are independently configurable and can live at unrelated paths, and a
 *  cookie scoped to just one would be withheld on a full-page navigation to the other. The cookie is
 *  HttpOnly + HMAC-signed + short-lived, so the broader scope is a reasonable trade. Matches the
 *  NestJS sibling console's own `cookiePath: '/'` for the identical reason. */
const SESSION_COOKIE_PATH = '/';

/**
 * Mounts the media-management console INTO `@adonis-agora/media` itself: a React SPA plus a JSON
 * API, both under a configurable path and an optional host auth guard. The API delegates to the
 * already-bound {@link MediaManager} singleton (bound by this same package's `MediaProvider`) via a
 * pure {@link DashboardService} — disk `list`/`stat`/`copy`/`move`/`deleteMany` and the resumable
 * session store. Nothing about storage is reimplemented here.
 *
 * Registering this provider is all a consuming app needs to do to get the dashboard — no separate
 * `@adonis-agora/media-dashboard` install (its provider still exists, standalone, for hosts that
 * prefer it — see `packages/dashboard`):
 * ```ts
 * providers: [
 *   () => import('@adonis-agora/media/media_provider'),
 *   () => import('@adonis-agora/media/dashboard_provider'),
 * ]
 * ```
 *
 * Route registration is deferred to `app.booted(...)` — same reason `MediaProvider#boot()` defers
 * (see its long comment): the router service isn't safely resolvable synchronously inside a
 * provider's own `boot()`.
 */
export default class MediaDashboardProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    const config = this.app.config.get<MediaDashboardConfig>('media_dashboard', {});
    if (config.enabled === false) return;

    await this.app.booted(async () => {
      const router = await this.app.container.make('router');
      this.#registerRoutes(router, config);
    });
  }

  #registerRoutes(router: HttpRouterService, config: MediaDashboardConfig): void {
    const basePath = normalizePath(config.basePath ?? '/media/dashboard');
    const apiBase = normalizePath(config.apiBasePath ?? `${basePath}/api`);
    const uploadsBase = normalizePath(config.uploadsPrefix ?? '/media/uploads');
    const tusBase = normalizePath(config.tusPrefix ?? '/media/uploads/tus');
    const actions = config.actions ?? false;
    const diskNames = this.#resolveDiskNames(config);
    const middleware = config.middleware
      ? Array.isArray(config.middleware)
        ? config.middleware
        : [config.middleware]
      : [];
    // Access-decision hook (same shape as the other @adonis-agora dashboards). Runs BEFORE
    // `middleware` and composes with the built-in `auth` session guard (all must pass).
    // A denied request gets 401/403 — or honors a redirect the hook wrote (like the telescope
    // guard, we check for a `location` header so a hook can send visitors to the app login).
    const authorizeGate = config.authorize
      ? [
          async (ctx: HttpContext, next: () => Promise<void>) => {
            let allowed: boolean;
            try {
              allowed = await config.authorize!(ctx);
            } catch {
              allowed = false;
            }
            if (allowed) return next();
            if (ctx.response.getHeader('location')) return next();
            ctx.response.status(401).send({ error: 'Unauthorized' });
          },
        ]
      : [];
    // Built-in session-cookie login (Mode A/B), independent of `middleware` — see
    // `src/dashboard/auth.ts`. `null` when unconfigured, in which case every gate below is a no-op
    // and the API stays open.
    const auth = resolveConsoleAuth(config.auth);
    const objectInsights = config.objectInsights ?? [];

    const service = async () =>
      new DashboardService(
        await this.app.container.make(MediaManager),
        { diskNames, actions },
        objectInsights,
      );

    const composedMiddleware = [...authorizeGate, ...middleware];

    this.#mountAuthRoutes(router, apiBase, auth);
    this.#mountApi(router, apiBase, service, composedMiddleware, auth);
    this.#mountSpa(
      router,
      basePath,
      { apiBase, uploadsBase, tusBase, actions },
      composedMiddleware,
    );
  }

  /**
   * Mints/clears the console session cookie: `GET /me`, `POST /login`, `POST /session`,
   * `POST /logout`. Deliberately NOT gated by `middleware` NOR the session guard below — these
   * routes CREATE the session the guard checks for (mirroring the NestJS sibling console's
   * `MediaConsoleAuthController`, which is likewise excluded from both its own session guard and any
   * host-supplied `guards`). A host `session` hook reads its OWN auth directly off the raw request,
   * so it needs no help from `middleware` here. When `auth` is unset, `/me` reports
   * `authRequired: false` and login/session/logout 404 (nothing to mint or clear).
   */
  #mountAuthRoutes(router: HttpRouterService, apiBase: string, auth: ResolvedConsoleAuth | null) {
    const group = router.group(() => {
      router
        .get('/me', async (ctx: HttpContext) => {
          if (!auth) {
            const body: MeResponse = { authRequired: false };
            return ctx.response.status(200).json(body);
          }
          const session = sessionFromRequest(ctx, auth);
          // The UNauthenticated SPA learns which login mode(s) to offer from this 401 body.
          if (!session) return ctx.response.status(401).json({ auth: { modes: auth.modes } });
          const body: MeResponse = { user: userInfoFromSession(session) };
          return ctx.response.status(200).json(body);
        })
        .as('media.dashboard.me');

      router
        .post('/login', async (ctx: HttpContext) => {
          if (!auth || !auth.login) return ctx.response.status(404).send('');
          const raw = ctx.request.body() as Partial<LoginBody>;
          if (typeof raw.username !== 'string' || typeof raw.password !== 'string') {
            return ctx.response
              .status(400)
              .json({ error: 'body must include string username and password' });
          }
          const user = await runAuthHook(() =>
            auth.login?.(raw.username as string, raw.password as string),
          );
          // Uniform 401 for unknown user / bad password — no user-enumeration.
          if (!user) return ctx.response.status(401).json({ error: 'invalid credentials' });
          issueSessionCookie(ctx, user, auth);
          const body: MeResponse = { user: userInfoFromUser(user) };
          return ctx.response.status(200).json(body);
        })
        .as('media.dashboard.login');

      router
        .post('/session', async (ctx: HttpContext) => {
          if (!auth || !auth.session) return ctx.response.status(404).send('');
          const user = await runAuthHook(() => auth.session?.(ctx.request.request));
          if (!user) return ctx.response.status(401).json({ error: 'unauthorized' });
          issueSessionCookie(ctx, user, auth);
          const body: MeResponse = { user: userInfoFromUser(user) };
          return ctx.response.status(200).json(body);
        })
        .as('media.dashboard.session');

      router
        .post('/logout', async (ctx: HttpContext) => {
          // Best-effort: even without auth configured, clearing is harmless.
          clearSessionCookie(ctx);
          return ctx.response.status(204).send('');
        })
        .as('media.dashboard.logout');
    });
    group.prefix(apiBase);
  }

  #mountApi(
    router: HttpRouterService,
    apiBase: string,
    service: () => Promise<DashboardService>,
    middleware: unknown[],
    auth: ResolvedConsoleAuth | null,
  ) {
    const json = (
      handler: (svc: DashboardService, ctx: HttpContext) => Promise<unknown>,
      okStatus = 200,
    ) => {
      return async (ctx: HttpContext) => {
        try {
          const result = await handler(await service(), ctx);
          if (result === undefined) return ctx.response.status(204).send('');
          return ctx.response.status(okStatus).json(result);
        } catch (error) {
          const status = error instanceof DashboardError ? error.status : 500;
          const message = error instanceof Error ? error.message : 'dashboard error';
          return ctx.response.status(status).json({ error: message });
        }
      };
    };

    const group = router.group(() => {
      router
        .get(
          '/topology',
          json(async (svc) => svc.topology()),
        )
        .as('media.dashboard.topology');
      router
        .get(
          '/disks',
          json(async (svc) => svc.disks()),
        )
        .as('media.dashboard.disks');
      router
        .get(
          '/objects',
          json(async (svc, ctx) => {
            const disk = str(ctx, 'disk');
            if (!disk) throw new DashboardError('disk is required', 400);
            const prefix = str(ctx, 'prefix');
            const cursor = str(ctx, 'cursor');
            const limit = ctx.request.input('limit');
            return svc.objects(disk, {
              ...(prefix !== undefined ? { prefix } : {}),
              ...(cursor !== undefined ? { cursor } : {}),
              ...(limit !== undefined ? { limit: Number(limit) } : {}),
            });
          }),
        )
        .as('media.dashboard.objects');
      router
        .get(
          '/object',
          json(async (svc, ctx) => {
            const disk = str(ctx, 'disk');
            const key = str(ctx, 'key');
            if (!disk) throw new DashboardError('disk is required', 400);
            return svc.object(disk, key ?? '');
          }),
        )
        .as('media.dashboard.object');
      router
        .post('/object', async (ctx: HttpContext) => {
          // Raw bytes as `application/octet-stream` so the host's JSON/urlencoded body parsers never
          // consume the stream; `ctx.request.request` is still the untouched Node request stream for
          // any content type the app's bodyparser wasn't configured to parse. The real MIME rides as
          // the `type` query param and becomes the stored object's Content-Type.
          try {
            const disk = str(ctx, 'disk');
            const key = str(ctx, 'key');
            const type = str(ctx, 'type');
            if (!disk) throw new DashboardError('disk is required', 400);
            if (!key) throw new DashboardError('key is required', 400);
            await (await service()).putObject(disk, key, ctx.request.request, type);
            return ctx.response.status(204).send('');
          } catch (error) {
            const status = error instanceof DashboardError ? error.status : 500;
            const message = error instanceof Error ? error.message : 'dashboard error';
            return ctx.response.status(status).json({ error: message });
          }
        })
        .as('media.dashboard.object.upload');
      router
        .get('/object/raw', async (ctx: HttpContext) => {
          try {
            const disk = str(ctx, 'disk');
            const key = str(ctx, 'key');
            if (!disk) throw new DashboardError('disk is required', 400);
            const { stream, contentType, size } = await (await service()).objectStream(
              disk,
              key ?? '',
            );
            ctx.response.header('content-type', contentType);
            ctx.response.header('content-disposition', 'inline');
            if (Number.isFinite(size)) ctx.response.header('content-length', String(size));
            return ctx.response.stream(stream);
          } catch (error) {
            const status = error instanceof DashboardError ? error.status : 500;
            const message = error instanceof Error ? error.message : 'dashboard error';
            return ctx.response.status(status).json({ error: message });
          }
        })
        .as('media.dashboard.object.raw');
      router
        .get(
          '/object/insights',
          json(async (svc, ctx) => {
            const disk = str(ctx, 'disk');
            const key = str(ctx, 'key');
            if (!disk) throw new DashboardError('disk is required', 400);
            return svc.objectInsights(disk, key ?? '');
          }),
        )
        .as('media.dashboard.object.insights');
      router
        .get(
          '/uploads',
          json(async (svc, ctx) => {
            const disk = str(ctx, 'disk');
            const prefix = str(ctx, 'prefix');
            return svc.uploads({
              ...(disk !== undefined ? { disk } : {}),
              ...(prefix !== undefined ? { prefix } : {}),
            });
          }),
        )
        .as('media.dashboard.uploads');
      router
        .get(
          '/uploads/:id',
          json(async (svc, ctx) => svc.uploadDetail(String(ctx.params.id))),
        )
        .as('media.dashboard.uploads.show');
      router
        .post(
          '/uploads/:id/abort',
          json(async (svc, ctx) => {
            await svc.abortUpload(String(ctx.params.id));
          }),
        )
        .as('media.dashboard.uploads.abort');
      router
        .get(
          '/collections',
          json(async (svc, ctx) => {
            const collection = str(ctx, 'collection');
            const ownerType = str(ctx, 'ownerType');
            const ownerId = str(ctx, 'ownerId');
            const prefix = str(ctx, 'prefix');
            const cursor = str(ctx, 'cursor');
            const limit = ctx.request.input('limit');
            return svc.collections({
              ...(collection !== undefined ? { collection } : {}),
              ...(ownerType !== undefined ? { ownerType } : {}),
              ...(ownerId !== undefined ? { ownerId } : {}),
              ...(prefix !== undefined ? { prefix } : {}),
              ...(cursor !== undefined ? { cursor } : {}),
              ...(limit !== undefined ? { limit: Number(limit) } : {}),
            });
          }),
        )
        .as('media.dashboard.collections');
      router
        .get(
          '/collections/summary',
          json(async (svc) => svc.collectionsSummary()),
        )
        .as('media.dashboard.collections.summary');
      router
        .get(
          '/media-record',
          json(async (svc, ctx) => {
            const id = str(ctx, 'id');
            if (!id) throw new DashboardError('id is required', 400);
            return svc.mediaRecord(id);
          }),
        )
        .as('media.dashboard.media_record');
      router
        .post(
          '/media-record/delete',
          json(async (svc, ctx) => {
            const body = ctx.request.body() as { id?: string };
            if (!body.id) throw new DashboardError('id is required', 400);
            await svc.deleteMediaRecord(body.id);
          }),
        )
        .as('media.dashboard.media_record.delete');

      router
        .post(
          '/copy',
          json(async (svc, ctx) => {
            await svc.copy(copyMoveBody(ctx));
          }),
        )
        .as('media.dashboard.copy');
      router
        .post(
          '/move',
          json(async (svc, ctx) => {
            await svc.move(copyMoveBody(ctx));
          }),
        )
        .as('media.dashboard.move');
      router
        .post(
          '/delete',
          json(async (svc, ctx) => {
            const body = ctx.request.body() as { disk?: string; keys?: string[] };
            if (!body.disk) throw new DashboardError('disk is required', 400);
            await svc.remove({
              disk: body.disk,
              keys: Array.isArray(body.keys) ? body.keys : [],
            });
          }),
        )
        .as('media.dashboard.delete');
      router
        .post(
          '/folder',
          json(async (svc, ctx) => {
            await svc.createFolder(folderBody(ctx));
          }),
        )
        .as('media.dashboard.folder.create');
      router
        .post(
          '/folder/delete',
          json(async (svc, ctx) => {
            await svc.deleteFolder(folderBody(ctx));
          }),
        )
        .as('media.dashboard.folder.delete');
      router
        .post(
          '/folder/copy',
          json(async (svc, ctx) => {
            await svc.copyFolder(copyMoveBody(ctx));
          }),
        )
        .as('media.dashboard.folder.copy');
      router
        .post(
          '/folder/move',
          json(async (svc, ctx) => {
            await svc.moveFolder(copyMoveBody(ctx));
          }),
        )
        .as('media.dashboard.folder.move');
    });
    group.prefix(apiBase);
    // Host `middleware` first (e.g. an admin check), then the built-in session guard (when `auth` is
    // configured) — a request must pass both. The mutating routes above are further gated at the
    // service layer by `actions` (unconditionally mounted; `DashboardService` 403s when disabled), so
    // read-only hosts can leave them mounted without enabling `actions`.
    applyMiddleware(group, auth ? [...middleware, sessionGuardMiddleware(auth)] : middleware);
  }

  #mountSpa(
    router: HttpRouterService,
    basePath: string,
    bootstrap: { apiBase: string; uploadsBase: string; tusBase: string; actions: boolean },
    middleware: unknown[],
  ) {
    const serveIndex = async (ctx: HttpContext) => {
      let html: string;
      try {
        html = await readFile(resolvePath(spaDirectory(), 'index.html'), 'utf8');
      } catch {
        return ctx.response
          .status(404)
          .send('media dashboard SPA is not built (run the package build to emit dist/assets/spa)');
      }
      return ctx.response
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'no-store, must-revalidate')
        .send(renderIndexHtml(html, basePath, bootstrap));
    };

    const group = router.group(() => {
      router.get('/', serveIndex).as('media.dashboard.index');
      router
        .get('/assets/:file', async (ctx: HttpContext) => {
          const file = basename(String(ctx.params.file));
          const root = resolvePath(spaDirectory(), 'assets');
          const assetPath = resolvePath(root, file);
          if (!assetPath.startsWith(root)) return ctx.response.status(404).send('');
          let bytes: Buffer;
          try {
            bytes = await readFile(assetPath);
          } catch {
            return ctx.response.status(404).send('');
          }
          return ctx.response
            .header('content-type', contentTypeFor(file))
            .header('cache-control', 'public, max-age=31536000, immutable')
            .send(bytes);
        })
        .as('media.dashboard.assets');
    });
    group.prefix(basePath);
    applyMiddleware(group, middleware);
  }

  /** Derive browsable disk names from the media config when the console config does not list them. */
  #resolveDiskNames(config: MediaDashboardConfig): string[] {
    if (config.disks && config.disks.length > 0) return config.disks;
    const media = this.app.config.get<{ disk?: string; disks?: Record<string, unknown> }>(
      'media',
      {},
    );
    const drive = this.app.config.get<{ default?: string }>('drive', {});
    const defaultName = media.disk ?? drive.default ?? 'default';
    const configured = media.disks ? Object.keys(media.disks) : [];
    return Array.from(new Set([defaultName, ...configured]));
  }
}

function str(ctx: HttpContext, key: string): string | undefined {
  const value = ctx.request.input(key);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function copyMoveBody(ctx: HttpContext): {
  disk: string;
  from: string;
  to: string;
  toDisk?: string;
} {
  const body = ctx.request.body() as { disk?: string; from?: string; to?: string; toDisk?: string };
  if (!body.disk) throw new DashboardError('disk is required', 400);
  return {
    disk: body.disk,
    from: body.from ?? '',
    to: body.to ?? '',
    ...(body.toDisk !== undefined ? { toDisk: body.toDisk } : {}),
  };
}

/** Body for the folder create/delete actions — a disk and the folder prefix. */
function folderBody(ctx: HttpContext): { disk: string; prefix: string } {
  const body = ctx.request.body() as { disk?: string; prefix?: string };
  if (!body.disk) throw new DashboardError('disk is required', 400);
  return { disk: body.disk, prefix: body.prefix ?? '' };
}

/** Apply host middleware to a route group without depending on Adonis's exact middleware typings. */
function applyMiddleware(
  group: ReturnType<HttpRouterService['group']>,
  middleware: unknown[],
): void {
  if (middleware.length === 0) return;
  (group.use as (m: unknown) => unknown)(middleware);
}

/* Session-cookie helpers ---------------------------------------------------------------------- */

/** Run a host hook (login/session) defensively: a throw is a denial (null), never a 500. */
async function runAuthHook(
  run: () => Promise<ConsoleSessionUser | null> | ConsoleSessionUser | null | undefined,
): Promise<ConsoleSessionUser | null> {
  try {
    return (await run()) ?? null;
  } catch {
    return null;
  }
}

function sessionFromRequest(ctx: HttpContext, auth: ResolvedConsoleAuth): ConsoleSession | null {
  const cookieValue = parseCookieHeader(ctx.request.header('cookie'))[SESSION_COOKIE_NAME];
  if (cookieValue === undefined) return null;
  return verifySessionCookie(cookieValue, { secret: auth.secret });
}

function userInfoFromSession(session: ConsoleSession): {
  id: string;
  name?: string;
  roles: string[];
} {
  return {
    id: session.sub,
    ...(session.name !== undefined ? { name: session.name } : {}),
    roles: session.roles,
  };
}

function userInfoFromUser(user: ConsoleSessionUser): {
  id: string;
  name?: string;
  roles: string[];
} {
  return {
    id: user.id,
    ...(user.name !== undefined ? { name: user.name } : {}),
    roles: user.roles ?? [],
  };
}

function issueSessionCookie(
  ctx: HttpContext,
  user: ConsoleSessionUser,
  auth: ResolvedConsoleAuth,
  now?: number,
): void {
  const value = signSessionCookie(user, {
    secret: auth.secret,
    ttlMs: auth.ttlMs,
    ...(now !== undefined ? { now } : {}),
  });
  ctx.response.append(
    'set-cookie',
    serializeSetCookie(SESSION_COOKIE_NAME, value, {
      path: SESSION_COOKIE_PATH,
      maxAgeSeconds: Math.floor(auth.ttlMs / 1000),
      secure: ctx.request.secure(),
    }),
  );
}

function clearSessionCookie(ctx: HttpContext): void {
  ctx.response.append(
    'set-cookie',
    serializeSetCookie(SESSION_COOKIE_NAME, '', {
      path: SESSION_COOKIE_PATH,
      maxAgeSeconds: 0,
      secure: ctx.request.secure(),
      clear: true,
    }),
  );
}

/**
 * Gates a route group on a valid session cookie. Sliding renewal + revalidation mirrors the NestJS
 * sibling console's `MediaConsoleGuard`: past half the TTL, the host's `revalidate` hook (if any)
 * re-checks the user before a fresh cookie is issued, so a deactivated operator loses access instead
 * of riding a self-renewing cookie.
 */
function sessionGuardMiddleware(auth: ResolvedConsoleAuth) {
  return async (ctx: HttpContext, next: () => Promise<void>) => {
    const session = sessionFromRequest(ctx, auth);
    // Absent/invalid/expired cookie => 401 with the login modes, same shape as `/me`'s refusal.
    if (!session) return ctx.response.status(401).json({ auth: { modes: auth.modes } });
    const now = Date.now();
    if (now - session.iat > auth.ttlMs / 2) {
      const user = userInfoFromSession(session);
      if (auth.revalidate) {
        const allowed = await runAuthHookBoolean(() => auth.revalidate?.(user));
        if (!allowed) {
          clearSessionCookie(ctx);
          return ctx.response.status(401).json({ auth: { modes: auth.modes } });
        }
      }
      issueSessionCookie(ctx, user, auth, now);
    }
    return next();
  };
}

async function runAuthHookBoolean(
  run: () => Promise<boolean> | boolean | undefined,
): Promise<boolean> {
  try {
    return (await run()) ?? false;
  } catch {
    return false; // Fail closed.
  }
}
