import { readFile } from 'node:fs/promises';
import { basename, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediaManager } from '@adonis-agora/media';
import type { HttpContext } from '@adonisjs/core/http';
import router from '@adonisjs/core/services/router';
import type { ApplicationService } from '@adonisjs/core/types';
import type { MediaDashboardConfig } from '../define_config.js';
import { DashboardError, DashboardService } from '../server/service.js';
import { contentTypeFor, normalizePath, renderIndexHtml } from './serve.js';

/** Directory of the built SPA (`dist/spa`), relative to this compiled provider (`dist/provider`). */
const SPA_DIR = fileURLToPath(new URL('../spa/', import.meta.url));

/**
 * Mounts the media-management console: a React SPA plus a JSON API, both under a configurable path and
 * an optional host auth guard. The API delegates to the already-bound {@link MediaManager} singleton
 * (bound by `@adonis-agora/media`'s provider) via a pure {@link DashboardService} — disk
 * `list`/`stat`/`copy`/`move`/`deleteMany` and the resumable session store. Nothing about storage is
 * reimplemented here.
 *
 * Add to `adonisrc.ts` after the media provider, and (optionally) a `config/media_dashboard.ts`:
 * ```ts
 * providers: [
 *   () => import('@adonis-agora/media/media_provider'),
 *   () => import('@adonis-agora/media-dashboard/media_dashboard_provider'),
 * ]
 * ```
 */
export default class MediaDashboardProvider {
  constructor(protected app: ApplicationService) {}

  boot() {
    const config = this.app.config.get<MediaDashboardConfig>('mediaDashboard', {});

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

    const service = async () =>
      new DashboardService(await this.app.container.make(MediaManager), { diskNames, actions });

    this.#mountApi(apiBase, service, actions, middleware);
    this.#mountSpa(basePath, { apiBase, uploadsBase, tusBase, actions }, middleware);
  }

  #mountApi(
    apiBase: string,
    service: () => Promise<DashboardService>,
    actions: boolean,
    middleware: unknown[],
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

      if (actions) {
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
      }
    });
    group.prefix(apiBase);
    applyMiddleware(group, middleware);
  }

  #mountSpa(
    basePath: string,
    bootstrap: { apiBase: string; uploadsBase: string; tusBase: string; actions: boolean },
    middleware: unknown[],
  ) {
    const serveIndex = async (ctx: HttpContext) => {
      let html: string;
      try {
        html = await readFile(resolvePath(SPA_DIR, 'index.html'), 'utf8');
      } catch {
        return ctx.response
          .status(404)
          .send('media dashboard SPA is not built (run the package build to emit dist/spa)');
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
          const path = resolvePath(SPA_DIR, 'assets', file);
          if (!path.startsWith(resolvePath(SPA_DIR, 'assets')))
            return ctx.response.status(404).send('');
          let bytes: Buffer;
          try {
            bytes = await readFile(path);
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

/** Apply host middleware to a route group without depending on Adonis's exact middleware typings. */
function applyMiddleware(group: ReturnType<typeof router.group>, middleware: unknown[]): void {
  if (middleware.length === 0) return;
  (group.use as (m: unknown) => unknown)(middleware);
}
