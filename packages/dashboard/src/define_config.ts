import type { HttpContext } from '@adonisjs/core/http';
import type { ConsoleAuthOptions } from './server/auth.js';
import type { ObjectInsightProvider } from './server/object_insights.js';

/** A minimal middleware handler shape (host auth guard) applied to the console routes. */
export type DashboardMiddleware = (ctx: HttpContext, next: () => Promise<void>) => unknown;

/**
 * Configuration for `@adonis-agora/media-dashboard`, read by the provider from `config/media_dashboard.ts`.
 *
 * The console is a read-only browser by default (`actions: false`); flip `actions` on — and gate the
 * routes with your own `middleware` (an auth guard) — to enable copy/move/delete. Storage, uploads and
 * everything else come from the already-configured `@adonis-agora/media` manager; this config only
 * places the SPA + JSON API and picks which disks are browsable.
 */
export interface MediaDashboardConfig {
  /** Where the SPA is mounted. Default `/media/dashboard`. */
  basePath?: string;
  /** Where the JSON API is mounted. Default `<basePath>/api`. */
  apiBasePath?: string;
  /** Enable mutating actions (copy/move/delete). Default `false`. */
  actions?: boolean;
  /**
   * Disk names the console may browse/act on. When omitted, the provider derives them from the media
   * config (`disks` keys plus the default disk).
   */
  disks?: string[];
  /** Prefix of the core direct-S3 upload routes, matched to `media.uploads.routes.prefix`. Default `/media/uploads`. */
  uploadsPrefix?: string;
  /** Prefix of the core TUS routes, matched to `media.uploads.resumable.routes.prefix`. Default `/media/uploads/tus`. */
  tusPrefix?: string;
  /** Host middleware (auth) applied to the whole console — SPA and API. */
  middleware?: DashboardMiddleware | DashboardMiddleware[];
  /**
   * Gate the console's JSON API behind a built-in session-cookie login, mirroring the NestJS sibling
   * console. Omit to leave the API open (front it with your own `middleware`). When set, the SPA
   * renders a login screen until a valid cookie exists; supply a `login(username, password)` and/or
   * `session(request)` hook that returns a session user (or `null` to deny) — see
   * {@link ConsoleAuthOptions}. Independent of, and composable with, `middleware`.
   */
  auth?: ConsoleAuthOptions;
  /**
   * Host-supplied context about a disk object, rendered in the console's preview — see
   * {@link ObjectInsightProvider}. The console can only describe a file as storage sees it; this is
   * how it learns what the file *means* to your app. Omit for no annotation (the default).
   */
  objectInsights?: ObjectInsightProvider[];
}

/** Identity helper for authoring a typed `config/media_dashboard.ts`. */
export function defineConfig(config: MediaDashboardConfig = {}): MediaDashboardConfig {
  return config;
}
