import type { HttpContext } from '@adonisjs/core/http';
import type {
  AccessDeniedOption as GenericAccessDeniedOption,
  AccessDeniedRenderer as GenericAccessDeniedRenderer,
} from './access_denied_page.js';
import type { ConsoleAuthOptions } from './auth.js';
import type { ObjectInsightProvider } from './object_insights.js';

/**
 * The function form of {@link MediaDashboardConfig.accessDenied}: render (or answer) a refused
 * page navigation yourself. Receives the refusal ({@link AccessDeniedInfo}) and the AdonisJS
 * {@link HttpContext}. Return an HTML string to have it served; answer the request yourself (a
 * redirect, most commonly) and return nothing to make the provider stand down; return nothing
 * WITHOUT answering and the built-in page is served.
 */
export type AccessDeniedRenderer = GenericAccessDeniedRenderer<HttpContext>;

/** `accessDenied` in either form — an options object for the built-in page, or a renderer. */
export type AccessDeniedOption = GenericAccessDeniedOption<HttpContext>;

/** A minimal middleware handler shape (host auth guard) applied to the console routes. */
export type DashboardMiddleware = (ctx: HttpContext, next: () => Promise<void>) => unknown;

/**
 * The access-decision hook gating the console (SPA + JSON API), same shape as the
 * `authorize` hooks of the other `@adonis-agora` dashboards (telescope, durable, agent):
 * return `true` to allow, `false` to deny (the guard answers `401`/`403`). Runs BEFORE any
 * configured `middleware`, and composes with the built-in `auth` session guard (all must
 * pass). Sync or async. Receives the real AdonisJS `HttpContext`, so it can read the
 * session, a bearer token, an IP allow-list, etc.
 */
export type DashboardAuthorize = (ctx: HttpContext) => boolean | Promise<boolean>;

/**
 * Configuration for the `@adonis-agora/media` dashboard, read by `dashboard_provider.ts` from
 * `config/media_dashboard.ts`. Same config KEY (`media_dashboard`) the standalone
 * `@adonis-agora/media-dashboard` package's provider always read, so an existing
 * `config/media_dashboard.ts` keeps working unchanged when a host switches from the standalone
 * provider to this embedded one.
 *
 * The console is a read-only browser by default (`actions: false`); flip `actions` on — and gate the
 * routes with your own `middleware` (an auth guard) — to enable copy/move/delete. Storage, uploads and
 * everything else come from the already-configured `@adonis-agora/media` manager; this config only
 * places the SPA + JSON API and picks which disks are browsable.
 */
export interface MediaDashboardConfig {
  /** Mount the dashboard at all. Default `true`. Set `false` to register the provider (so its config
   *  type stays available) without actually exposing any route — e.g. per-environment. */
  enabled?: boolean;
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
   * Access-decision hook gating the whole console (SPA + API), same shape as the
   * `authorize` hooks of the other `@adonis-agora` dashboards. Runs BEFORE `middleware`
   * and composes with the built-in `auth` session guard (all must pass). A denied request
   * gets `403` (or honors a redirect the hook writes): `{ error: 'Forbidden' }` JSON on the
   * API, the {@link accessDenied} page on a page navigation. Default: allow when not in
   * production.
   */
  authorize?: DashboardAuthorize;
  /**
   * What a BROWSER sees when `authorize` refuses a page navigation — the SPA shell or its assets.
   * API requests are unaffected: they keep getting `403 { error: 'Forbidden' }` JSON. Omit it for
   * the built-in page — a dark card in the console's own visual language with the same `403`, a
   * sentence explaining the refusal and a "Back to app" link. Pass an
   * object to tweak that page (`brand`, `title`, `message`, `homeHref`, `accent`, …), or a function
   * to render/answer it yourself — see {@link AccessDeniedRenderer}. A redirect written by
   * `authorize` still wins: the provider never overwrites a `location` header.
   */
  accessDenied?: AccessDeniedOption;
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
