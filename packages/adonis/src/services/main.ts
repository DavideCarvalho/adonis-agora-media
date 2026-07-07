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
 */
let media: MediaManager;

await app.booted(async () => {
  media = await app.container.make(MediaManager);
});

export { media as default };
