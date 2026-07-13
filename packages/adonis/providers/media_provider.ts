import type { HttpContext } from '@adonisjs/core/http';
import router from '@adonisjs/core/services/router';
import type { ApplicationService } from '@adonisjs/core/types';
import type { MediaConfig } from '../src/define_config.js';
import { resolveConfiguredDisks } from '../src/disks/factory.js';
import type { ImageProcessor } from '../src/image_processor.js';
import { MediaManager } from '../src/media_manager.js';
import type { MultipartPart } from '../src/types.js';
import { resolveStore } from '../src/stores/factory.js';
import type { StoreContext } from '../src/stores/factory.js';
import type { Disk, DiskResolver } from '../src/types.js';

/** The minimal Drive manager surface we use: `use(name)` returns a disk. */
interface DriveManagerLike {
  use(name?: string): Disk;
}

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
    this.app.container.singleton(MediaManager, async () => {
      const config = this.app.config.get<MediaConfig>('media', {});

      // Validate + build the store from config first, so a misconfigured `store` fails fast (before
      // we touch Drive) rather than silently booting on a non-durable in-memory fallback.
      const ctx: StoreContext = { app: this.app };
      const store = await resolveStore(config, ctx);
      const imageProcessor = await this.#resolveImageProcessor(config);

      // Build any disks declared in `config.disks` (e.g. the bundled `disks.s3()` driver). Each
      // factory lazily loads its peer (the AWS SDK), so nothing is imported unless an S3 disk is
      // actually configured.
      const configuredDisks = await resolveConfiguredDisks(config.disks);

      // Resolve disks from Drive without a hard dependency: import its service lazily. The Drive
      // disk satisfies our structural `Disk` (getBytes/put/getUrl/...); cast via `unknown` because
      // Drive's full surface is wider than the subset we use.
      const drive = (await import('@adonisjs/drive/services/main'))
        .default as unknown as DriveManagerLike;
      const defaultDisk = config.disk ?? (await this.#resolveDefaultDiskName());

      // A disk named in `config.disks` wins over a Drive disk of the same name; otherwise fall
      // through to Drive so existing Drive disks keep working unchanged.
      const resolve: DiskResolver = (name) => {
        const key = name ?? defaultDisk;
        return configuredDisks[key] ?? drive.use(name);
      };

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
      });
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
  boot() {
    const config = this.app.config.get<MediaConfig>('media', {});
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
      .post(`${prefix}/direct/initiate`, json(async (media, ctx) => {
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
      }))
      .as('media.uploads.direct.initiate');

    router
      .post(`${prefix}/direct/:uploadId/parts/:partNumber`, json(async (media, ctx) => {
        const key = requireKey(ctx);
        const disk = readDisk(ctx);
        return media.uploads.presignPart({
          key,
          uploadId: String(ctx.params.uploadId),
          partNumber: Number(ctx.params.partNumber),
          ...(disk !== undefined ? { disk } : {}),
        });
      }))
      .as('media.uploads.direct.presignPart');

    router
      .post(`${prefix}/direct/:uploadId/complete`, json(async (media, ctx) => {
        const body = ctx.request.body() as { key: string; parts: MultipartPart[]; disk?: string };
        return media.completeDirectUpload({
          key: body.key,
          uploadId: String(ctx.params.uploadId),
          parts: body.parts,
          ...(body.disk !== undefined ? { disk: body.disk } : {}),
        });
      }))
      .as('media.uploads.direct.complete');

    router
      .delete(`${prefix}/direct/:uploadId`, json(async (media, ctx) => {
        const key = requireKey(ctx);
        const disk = readDisk(ctx);
        await media.abortDirectUpload({
          key,
          uploadId: String(ctx.params.uploadId),
          ...(disk !== undefined ? { disk } : {}),
        });
        return { ok: true };
      }))
      .as('media.uploads.direct.abort');

    router
      .put(`${prefix}/proxy`, json(async (media, ctx) => {
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
      }, 201))
      .as('media.uploads.proxy');
  }

  /** A config `imageProcessor` may be a ready instance or a lazy factory thunk. */
  async #resolveImageProcessor(config: MediaConfig): Promise<ImageProcessor | undefined> {
    const ip = config.imageProcessor;
    if (!ip) return undefined;
    if (typeof ip === 'function') return ip();
    return ip;
  }

  /** When the config doesn't name a disk, fall back to Drive's configured default disk name. */
  async #resolveDefaultDiskName(): Promise<string> {
    const driveConfig = this.app.config.get<{ default?: string }>('drive', {});
    return driveConfig.default ?? 'default';
  }
}

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
