import { type MediaDashboardOptions, mediaDashboard } from './dashboard.js';
import {
  mediaActiveUploadsProvider,
  mediaAttachmentActivityProvider,
  mediaConversionsOverTimeProvider,
  mediaRecentConversionsProvider,
  mediaRecentUploadsProvider,
  mediaStorageOpsOverTimeProvider,
  mediaUploadSuccessRateProvider,
  mediaUploadsOverTimeProvider,
  mediaUploadThroughputProvider,
} from './data-providers.js';
import type { TelescopeExtension } from './telescope-sdk.js';

/**
 * The first-class `@adonis-agora/telescope` extension for `@adonis-agora/media` (the "MediaWatcher"): a
 * "Media" overview dashboard surfacing recent uploads, storage operations and image conversions, plus
 * the data providers the panels bind to. Wire it into `config/telescope.ts`:
 *
 * ```ts
 * import { defineConfig } from '@adonis-agora/telescope'
 * import { mediaTelescopeExtension } from '@adonis-agora/media/telescope'
 *
 * export default defineConfig({ extensions: [mediaTelescopeExtension()] })
 * ```
 *
 * No watcher is contributed — `@adonis-agora/media` already publishes `agora:media:*` lifecycle events
 * onto the diagnostics bus (`src/diagnostics.ts`), and Telescope's generic diagnostics watcher records
 * them as `type: 'diagnostic'`, `tag: 'lib:media'`; the entry-backed providers read those recorded
 * entries. `@adonis-agora/telescope` stays an OPTIONAL, never-imported peer — see `telescope-sdk.ts`
 * for why the returned object structurally (not nominally) satisfies its `TelescopeExtension` contract.
 *
 * No `entryTypes` are contributed: media events are recorded under the generic `diagnostic` entry type
 * (`tag: 'lib:media'`), so there is no dedicated `media` entry type to navigate to — the "Media"
 * dashboard is the entry point. (Same reasoning as `@adonis-agora/durable/telescope`.)
 */
export function mediaTelescopeExtension(opts: MediaDashboardOptions = {}): TelescopeExtension {
  return {
    name: 'media',
    dashboards: () => [mediaDashboard(opts)],
    dataProviders: () => [
      mediaActiveUploadsProvider(),
      mediaUploadSuccessRateProvider(),
      mediaUploadThroughputProvider(),
      mediaUploadsOverTimeProvider(),
      mediaRecentUploadsProvider(),
      mediaStorageOpsOverTimeProvider(),
      mediaAttachmentActivityProvider(),
      mediaConversionsOverTimeProvider(),
      mediaRecentConversionsProvider(),
    ],
  };
}
