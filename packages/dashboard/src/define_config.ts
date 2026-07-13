import type { HttpContext } from '@adonisjs/core/http';

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
}

/** Identity helper for authoring a typed `config/media_dashboard.ts`. */
export function defineConfig(config: MediaDashboardConfig = {}): MediaDashboardConfig {
  return config;
}
