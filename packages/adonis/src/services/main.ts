import { MediaManager } from '../media_manager.js';
import { getBootedApp } from './booted_app.js';

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
 * The app is read from the provider-captured booted instance ({@link getBootedApp}) rather than
 * `@adonisjs/core/services/app` — see `./booted_app.js` for why that import is unreliable under a
 * duplicated `@adonisjs/core` tree (pnpm dual-package hazard).
 *
 * This module's top-level `await` runs at import time, so importing it requires
 * `MediaProvider.register()` to already have run. In the previous `@adonisjs/core/services/app`
 * import this "just worked" in a single-copy tree (that module's `app` binding is set very early,
 * long before any provider registers) but threw an opaque `Cannot read properties of undefined
 * (reading 'booted')` in a duplicated-`@adonisjs/core` tree — the exact class of crash this file
 * exists to fix. Importing this module before `MediaProvider.register()` has run now throws the same
 * clear, actionable error {@link getBootedApp} gives everywhere else in this package.
 */
let media: MediaManager;

await getBootedApp().booted(async () => {
  media = await getBootedApp().container.make(MediaManager);
});

export { media as default };
