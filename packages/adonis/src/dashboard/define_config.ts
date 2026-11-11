import type { HttpContext } from '@adonisjs/core/http';
import type {
  AccessDeniedOption as GenericAccessDeniedOption,
  AccessDeniedRenderer as GenericAccessDeniedRenderer,
} from './access_denied_page.js';
import type { ConsoleAuthOptions } from './auth.js';
import type { ConsoleAuthorize } from './console_authorize.js';
import type { ObjectInsightProvider } from './object_insights.js';
import type { ObjectUrlStrategy } from './object_urls.js';

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
 * Configuration for the `@adonis-agora/media` dashboard, read by `dashboard_provider.ts` from
 * `config/media_dashboard.ts` (config key `media_dashboard`).
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
   * Who may open the console (SPA + API). Same contract as every other `@adonis-agora` console —
   * see {@link ConsoleAuthorize}: an inline function, a `ConsoleAuthorizer` class (built through
   * the container, so `@inject()` works), or a lazy import of one.
   *
   * Answer `true` / `{ allowed: true }` to allow; `false` / `{ allowed: false }` for `403`;
   * `{ allowed: false, reason: 'unauthenticated' }` for `401`; `{ redirectTo: '/login' }` to send
   * a page navigation there (API calls get `401`). A check that throws is a `403`. Runs before
   * `middleware` and composes with the built-in `auth` login (all must pass). API refusals answer
   * `{ error: 'Forbidden' }` / `{ error: 'Unauthorized' }` JSON; page navigations get the
   * {@link accessDenied} page with the same status.
   *
   * Omitted: the console is open outside production and refuses every request (`403`) in
   * production, with a warning at boot. Set `authorize: () => true` to keep it open in production
   * when `middleware` or `auth` already guard it.
   */
  authorize?: ConsoleAuthorize;
  /**
   * What a BROWSER sees when `authorize` refuses a page navigation — the SPA shell or its assets.
   * API requests are unaffected: they keep getting `{ error: 'Forbidden' }` (`403`) or
   * `{ error: 'Unauthorized' }` (`401`) JSON. Omit it for the built-in page — a dark card in the
   * console's own visual language with the same status as the API, a
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
  /**
   * Where the `url` the console reports for an object's bytes points — the "Open ↗" link and the
   * `src` of the image/video/audio previews. `'auto'` signs a URL straight to the object store;
   * `'proxy'` routes it through this server's own `<apiBase>/object/raw`, for a deployment whose
   * browsers cannot reach the store at all (private bucket on an internal network, no CORS grant).
   * See {@link ObjectUrlStrategy}.
   *
   * Set `'proxy'` whenever the store is not internet-reachable — with `'auto'` the console mints a
   * URL signed for the INTERNAL endpoint, which resolves nowhere in a browser.
   *
   * When unset, the console follows the core media config: `delivery.mode: 'proxy'` in
   * `config/media.ts` implies `'proxy'` here (a host already streaming every read through the app
   * has declared its store unreachable from a browser); anything else keeps `'auto'`. An explicit
   * value always wins.
   */
  objectUrls?: ObjectUrlStrategy;
}

/** Identity helper for authoring a typed `config/media_dashboard.ts`. */
export function defineConfig(config: MediaDashboardConfig = {}): MediaDashboardConfig {
  return config;
}
