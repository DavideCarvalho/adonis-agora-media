import app from '@adonisjs/core/services/app';
import { MediaManager } from '../media_manager.js';

/**
 * Service-singleton for the {@link MediaManager}, resolved from the container once the app has
 * booted. Import it for a ready-to-use manager instead of resolving the binding by hand:
 *
 * ```ts
 * import media from '@adonis-agora/media/services/main'
 *
 * await media.library.attach({ ownerType: 'Post', ownerId: '1', collection: 'gallery', ... })
 * ```
 *
 * Same pattern as `@adonisjs/lucid/services/db`, `@adonisjs/drive/services/main` and
 * `@adonisjs/queue/services/main`: read the app from `@adonisjs/core/services/app` (whose binding is
 * set by `bin/server`/`bin/console` before any command/route module is imported) and capture the
 * manager inside `app.booted(...)`. This makes importing this module safe at ANY time — including
 * the ace command loader reading command metadata before the app boots.
 *
 * (Historical note: this module used a provider-captured `getBootedApp()` instead, because under a
 * duplicated `@adonisjs/core` tree (pnpm dual-package hazard) `services/app`'s binding could resolve
 * to a non-booted copy and stay `undefined`. That hazard is solved at the app level — the Lumen
 * workspace pins `@adonisjs/core` to a single copy via `pnpm.overrides` — and the ecosystem-standard
 * `services/app` pattern is what `lucid`/`drive`/`queue` use, so we align with it.)
 */
let media: MediaManager;

await app.booted(async () => {
  media = await app.container.make(MediaManager);
});

export { media as default };
