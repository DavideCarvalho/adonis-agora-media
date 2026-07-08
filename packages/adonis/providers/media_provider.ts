import type { ApplicationService } from '@adonisjs/core/types';
import type { MediaConfig } from '../src/define_config.js';
import type { ImageProcessor } from '../src/image_processor.js';
import { MediaManager } from '../src/media_manager.js';
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

      // Resolve disks from Drive without a hard dependency: import its service lazily. The Drive
      // disk satisfies our structural `Disk` (getBytes/put/getUrl/...); cast via `unknown` because
      // Drive's full surface is wider than the subset we use.
      const drive = (await import('@adonisjs/drive/services/main'))
        .default as unknown as DriveManagerLike;
      const resolve: DiskResolver = (name) => drive.use(name);
      const defaultDisk = config.disk ?? (await this.#resolveDefaultDiskName());

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
      });
    });
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
