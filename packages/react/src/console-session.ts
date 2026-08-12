/**
 * Headless client for opening the `@adonis-agora/media-dashboard` console from YOUR app. Ported from
 * the NestJS sibling console's `src/react/console-session.ts` so both ecosystems expose the same
 * "open console" building block.
 *
 * The console SPA is served at a literal path and knows nothing about your app's auth, so a plain
 * browser navigation to it carries no identity. This closes that gap: an XHR from inside your app —
 * which DOES carry your auth — posts to the console's `/session` route, the host's `session` hook
 * (configured via `config/media_dashboard.ts`'s `auth.session`) decides, and the dashboard answers
 * with its own signed cookie. The navigation that follows rides it.
 *
 * No UI here on purpose: you own the button, the page and the copy. This module owns the two things a
 * host would otherwise have to rediscover — where the session endpoint actually lives, and how to call
 * it without the failure mode below.
 */

/** Matches `MediaDashboardProvider`'s own `basePath` default. */
const DEFAULT_BASE_PATH = '/media/dashboard';
/** Matches `MediaDashboardProvider`'s own `apiBasePath` default of `<basePath>/api`. */
const DEFAULT_API_BASE_PATH = '/media/dashboard/api';

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * Where `POST` mints the console session cookie.
 *
 * Derives from `apiBasePath`, NOT `basePath`: the auth routes are mounted with the console's JSON
 * API, which the provider mounts separately from the SPA. Deriving it here rather than at the call
 * site means a host cannot get that split wrong.
 */
export function mediaDashboardSessionUrl(apiBasePath: string = DEFAULT_API_BASE_PATH): string {
  return `${normalizeBasePath(apiBasePath)}/session`;
}

/** Where the console SPA itself is served. */
export function mediaDashboardUrl(basePath: string = DEFAULT_BASE_PATH): string {
  return normalizeBasePath(basePath) || '/';
}

export interface OpenConsoleOptions {
  /** Where the console SPA is mounted. MUST match `config/media_dashboard.ts`'s `basePath`. */
  basePath?: string;
  /**
   * Where the console's JSON API — and with it the session endpoint — is mounted. MUST match
   * `config/media_dashboard.ts`'s `apiBasePath`. Defaults to `<basePath>/api`, the same defaulting
   * the provider itself does, so a host that set neither can pass neither.
   */
  apiBasePath?: string;
  /**
   * Headers for the mint request — in practice your app's `Authorization` header. A function (sync or
   * async) is accepted so a token can be read at call time rather than captured at wiring time, which
   * is what a refreshing token needs.
   */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  /** Injected for tests and non-browser callers. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  /**
   * Performs the navigation after a successful mint. Defaults to `location.assign`. Override to route
   * through your own router, or to open in a new tab.
   */
  navigate?: (url: string) => void;
}

/** Thrown when the session could not be minted. Never thrown after a successful mint. */
export class ConsoleSessionError extends Error {
  constructor(
    message: string,
    readonly url: string,
    /** The HTTP status, or `undefined` when the request never produced one (network error). */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ConsoleSessionError';
  }
}

/**
 * Mirror the provider's own defaulting: an explicit `apiBasePath` wins, otherwise it hangs off
 * `basePath`, so a host that only customised the SPA mount still hits the right session endpoint.
 */
function resolveApiBasePath(options: OpenConsoleOptions): string {
  if (options.apiBasePath !== undefined) return options.apiBasePath;
  if (options.basePath !== undefined) return `${normalizeBasePath(options.basePath)}/api`;
  return DEFAULT_API_BASE_PATH;
}

async function resolveHeaders(headers: OpenConsoleOptions['headers']): Promise<HeadersInit> {
  if (headers === undefined) return {};
  return typeof headers === 'function' ? await headers() : headers;
}

/**
 * Mint the console session cookie. Resolves on success; throws {@link ConsoleSessionError} on
 * refusal. Use this directly when you want to mint without navigating (a pre-flight check, or a link
 * the user opens later).
 */
export async function mintMediaDashboardSession(options: OpenConsoleOptions = {}): Promise<void> {
  const url = mediaDashboardSessionUrl(resolveApiBasePath(options));
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new ConsoleSessionError('No `fetch` available; pass one via `options.fetch`.', url);
  }

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      // The whole point: the response's Set-Cookie must stick, and the cookie must ride the
      // navigation that follows.
      credentials: 'include',
      headers: await resolveHeaders(options.headers),
      // Load-bearing, and the reason this helper exists rather than three lines at the call site.
      // `fetch` FOLLOWS redirects by default, so an app whose auth layer rewrites a 401 into a
      // "go to /signin" redirect makes this request resolve 200 against the sign-in HTML —
      // `response.ok` reads true, the caller navigates, and the user lands in a console with no
      // session, which looks exactly like a permissions bug. Handling the redirect explicitly turns
      // that into a clear error instead of a silent false success.
      redirect: 'manual',
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new ConsoleSessionError(
      `Could not reach the dashboard session endpoint at ${url}: ${String(cause)}`,
      url,
    );
  }

  // `redirect: 'manual'` surfaces differently per runtime: browsers give an opaque response
  // (`type: 'opaqueredirect'`, status 0), Node/undici gives the real 3xx. Both mean the same thing.
  const redirected =
    response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400);
  if (redirected) {
    throw new ConsoleSessionError(
      `The dashboard session endpoint at ${url} answered with a redirect instead of minting a session. Something in front of it — usually an auth middleware that rewrites 401s into a sign-in redirect — is intercepting the response. Exempt this path from that rewrite so the real status reaches this caller.`,
      url,
      response.status || undefined,
    );
  }

  if (!response.ok) {
    throw new ConsoleSessionError(
      `The dashboard refused to open (HTTP ${response.status}).`,
      url,
      response.status,
    );
  }
}

/**
 * Mint the session, then navigate to the console. Throws without navigating when the mint is
 * refused, so a denied user gets a real error instead of landing on the console's login screen —
 * which reads as a bug rather than a permission decision.
 */
export async function openMediaDashboard(options: OpenConsoleOptions = {}): Promise<void> {
  await mintMediaDashboardSession(options);
  const target = mediaDashboardUrl(options.basePath);
  const navigate = options.navigate ?? ((url: string) => globalThis.location?.assign(url));
  navigate(target);
}
