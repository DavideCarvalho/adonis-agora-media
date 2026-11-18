import { createHash, timingSafeEqual } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';

/**
 * What a console `authorize` check may answer. The same shape is accepted by every
 * `@adonis-agora` console (durable, telescope, media, payments, agent, the authkit admin), so one
 * authorizer works for all of them.
 *
 * - `true` / `{ allowed: true }` let the request through.
 * - `false` / `{ allowed: false }` deny it with `403`; `reason: 'unauthenticated'` makes it a `401`.
 * - `{ redirectTo }` sends a page navigation to that path (`302`); an API call gets `401` JSON.
 */
export type ConsoleAuthorizeResult =
  | boolean
  | {
      allowed: true;
      /**
       * With tenancy on: the tenants (organizations) this viewer may see in the console, or `'*'`
       * for every tenant plus files with no tenant. Omit for the viewer's own active tenant.
       */
      tenants?: '*' | string[];
      /**
       * The federated console: which of the other apps in `apps` (config/media_dashboard.ts) this
       * viewer may pick, by key, or `'*'` for all of them. Omit for all. This app is always shown.
       */
      apps?: '*' | string[];
    }
  | { allowed: false; reason?: 'unauthenticated' | 'forbidden' }
  | { redirectTo: string };

/** A class form, for an authorizer in its own file (`@inject()` works). */
export interface ConsoleAuthorizer {
  authorize(ctx: HttpContext): ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;
}

// biome-ignore lint/suspicious/noExplicitAny: a constructor of any arity, resolved through the container
export type ConsoleAuthorizerClass = new (...args: any[]) => ConsoleAuthorizer;

/**
 * The console `authorize` option, in three forms:
 *
 * ```ts
 * authorize: (ctx) => ctx.auth.user?.isAdmin === true,   // inline function
 * authorize: ConsoleAccess,                              // a ConsoleAuthorizer class
 * authorize: () => import('#policies/console_access'),   // lazy import of one
 * ```
 *
 * Classes are built through the AdonisJS container, so `@inject()` constructor dependencies work.
 * A check that throws denies the request (`403`).
 */
export type ConsoleAuthorize =
  | ((ctx: HttpContext) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>)
  | ConsoleAuthorizerClass
  | (() => Promise<{ default: ConsoleAuthorizerClass }>);

/** The outcome of a console `authorize` check, normalized. */
export type ConsoleAuthorizeDecision =
  | { allowed: true; tenants?: '*' | string[]; apps?: '*' | string[] }
  | { allowed: false; status: 401 | 403; reason: 'unauthenticated' | 'forbidden' }
  | { allowed: false; status: 401; reason: 'unauthenticated'; redirectTo: string };

type ContainerResolverLike = { make(target: unknown): unknown };

function isAuthorizerClass(value: unknown): value is ConsoleAuthorizerClass {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === 'function'
  );
}

function lazyModuleClass(value: unknown): ConsoleAuthorizerClass | undefined {
  if (typeof value !== 'object' || value === null || !('default' in value)) return undefined;
  const candidate = (value as { default: unknown }).default;
  return isAuthorizerClass(candidate) ? candidate : undefined;
}

async function runClass(Class: ConsoleAuthorizerClass, ctx: HttpContext): Promise<unknown> {
  const resolver = (ctx as unknown as { containerResolver?: ContainerResolverLike })
    .containerResolver;
  const instance = (resolver ? await resolver.make(Class) : new Class()) as ConsoleAuthorizer;
  return instance.authorize(ctx);
}

const FORBIDDEN = { allowed: false, status: 403, reason: 'forbidden' } as const;

/** A `'*'` or a list of ids (trimmed, deduplicated), or `undefined` for anything else. */
function grantList(value: unknown): '*' | string[] | undefined {
  if (value === '*') return '*';
  if (!Array.isArray(value)) return undefined;
  const ids = value
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t !== '');
  return [...new Set(ids)];
}

/** Normalize an `authorize` answer. Anything that is not an explicit allow denies. */
export function normalizeConsoleAuthorizeResult(result: unknown): ConsoleAuthorizeDecision {
  if (result === true) return { allowed: true };
  if (typeof result !== 'object' || result === null) return FORBIDDEN;
  const record = result as {
    allowed?: unknown;
    reason?: unknown;
    redirectTo?: unknown;
    tenants?: unknown;
    apps?: unknown;
  };
  if (record.allowed === true) {
    const tenants = grantList(record.tenants);
    const apps = grantList(record.apps);
    return {
      allowed: true,
      ...(tenants !== undefined ? { tenants } : {}),
      ...(apps !== undefined ? { apps } : {}),
    };
  }
  if (typeof record.redirectTo === 'string' && record.redirectTo !== '') {
    return {
      allowed: false,
      status: 401,
      reason: 'unauthenticated',
      redirectTo: record.redirectTo,
    };
  }
  if (record.reason === 'unauthenticated') {
    return { allowed: false, status: 401, reason: 'unauthenticated' };
  }
  return FORBIDDEN;
}

/**
 * Turn a {@link ConsoleAuthorize} option into a check that runs per request. A class is built
 * through `ctx.containerResolver`; a lazy import is loaded once and remembered. A throw denies.
 */
export function resolveConsoleAuthorize(
  authorize: ConsoleAuthorize,
): (ctx: HttpContext) => Promise<ConsoleAuthorizeDecision> {
  let lazyClass: ConsoleAuthorizerClass | undefined;

  return async (ctx) => {
    try {
      if (isAuthorizerClass(authorize)) {
        return normalizeConsoleAuthorizeResult(await runClass(authorize, ctx));
      }
      if (lazyClass) return normalizeConsoleAuthorizeResult(await runClass(lazyClass, ctx));

      // An inline function and a lazy import look alike: call it and inspect the answer. A module
      // whose `default` is an authorizer class was a lazy import; remember the class so the import
      // runs only once.
      const result: unknown = await (authorize as (ctx: HttpContext) => unknown)(ctx);
      const loaded = lazyModuleClass(result);
      if (loaded) {
        lazyClass = loaded;
        return normalizeConsoleAuthorizeResult(await runClass(loaded, ctx));
      }
      return normalizeConsoleAuthorizeResult(result);
    } catch {
      return FORBIDDEN;
    }
  };
}

/** Options for {@link authorizeByToken}. */
export interface AuthorizeByTokenOptions {
  /** The shared secret callers send as `Authorization: Bearer <token>`. */
  token: string | undefined;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * An `authorize` check for machine access: allows a request whose `Authorization` header is
 * `Bearer <token>`, and answers `{ allowed: false, reason: 'unauthenticated' }` (`401`) otherwise.
 *
 * ```ts
 * authorize: authorizeByToken({ token: env.get('CONSOLE_TOKEN') }),
 * ```
 *
 * Throws at config time when `token` is empty or undefined.
 */
export function authorizeByToken(options: AuthorizeByTokenOptions): ConsoleAuthorize {
  const token = options?.token;
  if (typeof token !== 'string' || token === '') {
    throw new Error('authorizeByToken: `token` must be a non-empty string');
  }
  const expected = digest(token);
  return (ctx: HttpContext): ConsoleAuthorizeResult => {
    const header = ctx.request.header('authorization');
    const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim()) : null;
    if (match?.[1] && timingSafeEqual(digest(match[1]), expected)) return { allowed: true };
    return { allowed: false, reason: 'unauthenticated' };
  };
}

/**
 * An `authorize` that allows a request when ANY of `authorizers` allows it, tried in order — e.g. a
 * machine token for MCP clients OR a signed-in admin for the browser:
 *
 * ```ts
 * authorize: anyAuthorize(
 *   authorizeByToken({ token: env.get('CONSOLE_TOKEN') }),
 *   (ctx) => ctx.auth.user?.isAdmin === true,
 * ),
 * ```
 *
 * When none allows: a redirect if one asked for it, `401` if any said "unauthenticated", `403`
 * otherwise. A throwing authorizer counts as a `403` and the next one is still tried.
 */
export function anyAuthorize(
  ...authorizers: ConsoleAuthorize[]
): (ctx: HttpContext) => Promise<ConsoleAuthorizeResult> {
  if (authorizers.length === 0) {
    throw new Error('anyAuthorize: pass at least one authorize');
  }
  const resolved = authorizers.map((authorize) => resolveConsoleAuthorize(authorize));
  return async (ctx: HttpContext): Promise<ConsoleAuthorizeResult> => {
    let unauthenticated = false;
    let redirectTo: string | undefined;
    for (const authorize of resolved) {
      const decision = await authorize(ctx);
      if (decision.allowed) {
        return {
          allowed: true,
          ...(decision.tenants !== undefined ? { tenants: decision.tenants } : {}),
          ...(decision.apps !== undefined ? { apps: decision.apps } : {}),
        };
      }
      if (decision.reason !== 'unauthenticated') continue;
      unauthenticated = true;
      if ('redirectTo' in decision && redirectTo === undefined) redirectTo = decision.redirectTo;
    }
    if (redirectTo !== undefined) return { redirectTo };
    if (unauthenticated) return { allowed: false, reason: 'unauthenticated' };
    return { allowed: false, reason: 'forbidden' };
  };
}

/**
 * `true` when the granted capability `granted` covers `required` (the Agora-wide rule): segments
 * split on `:`, a `*` segment matches exactly one segment, and a LAST `*` matches zero or more
 * further segments (`media:*` covers `media` and `media:objects:read`; `*` covers everything).
 */
export function capabilityAllows(granted: string, required: string): boolean {
  const have = granted.split(':');
  const want = required.split(':');
  for (let i = 0; i < have.length; i++) {
    const segment = have[i];
    if (segment === '*' && i === have.length - 1) return true;
    if (i >= want.length) return false;
    if (segment !== '*' && segment !== want[i]) return false;
  }
  return have.length === want.length;
}

/** The capability {@link authorizeAgoraCaller} asks of a calling app to read object bytes. */
export const MEDIA_OBJECTS_READ = 'media:objects:read';

/** The capability {@link authorizeAgoraCaller} asks of a calling app to run actions (`actions`). */
export const MEDIA_OBJECTS_WRITE = 'media:objects:write';

/** Who is calling this console from another app, as an {@link IdentifyAppCaller} found it. */
export interface AppCaller {
  /** The calling app's name. */
  app: string;
  /** Whatever the identification carried (a token's capabilities, a client row…), for `permit`. */
  claims?: Record<string, unknown> | undefined;
}

/**
 * WHO is calling: the app, or `undefined` when the request does not come from one (a `401`). Read a
 * verified token, a client certificate, a shared secret, a row of your own `api_keys` table…
 */
export type IdentifyAppCaller = (
  ctx: HttpContext,
) => AppCaller | undefined | null | Promise<AppCaller | undefined | null>;

/** CAN that app do this: `permission` is `media:objects:read` or `media:objects:write` (by default). */
export type PermitAppCaller = (
  caller: AppCaller,
  permission: string,
  ctx: HttpContext,
) => boolean | Promise<boolean>;

/** Options for {@link authorizeAppCaller}. */
export interface AuthorizeAppCallerOptions {
  /** Who is calling: {@link identifyAgoraCaller}, {@link identifySharedSecret}, or your own. */
  identify: IdentifyAppCaller;
  /** What it may do: {@link permitTokenCapabilities}, {@link permitAll}, or your own. */
  permit: PermitAppCaller;
  /** The calling apps let in, by name. Omit for any `identify` finds. */
  apps?: string[] | undefined;
  /** The permission asked to read object bytes. Default {@link MEDIA_OBJECTS_READ}. */
  read?: string | undefined;
  /**
   * The permission asked to run actions ({@link MEDIA_ACTION_ROUTES}), or `false` to open no action
   * at all. Default {@link MEDIA_OBJECTS_WRITE}.
   */
  write?: string | false | undefined;
}

/** The app each request was let in for by {@link authorizeAppCaller}. */
const LET_IN = new WeakMap<object, AppCaller>();

/** The app {@link authorizeAppCaller} let this request in for, or `undefined` (a viewer, or none). */
export function appCallerOf(ctx: HttpContext): AppCaller | undefined {
  return LET_IN.get(ctx);
}

/** The route an app caller may read: the console's object bytes. */
const RAW_ROUTE = 'media.dashboard.object.raw';

/**
 * The console's action routes, by name, that an app caller may run with the write permission: what
 * a federated console sends (`proxyActions`). Uploading and the Organization switch are not among
 * them.
 */
export const MEDIA_ACTION_ROUTES: readonly string[] = Object.freeze([
  'media.dashboard.uploads.abort',
  'media.dashboard.media_record.delete',
  'media.dashboard.copy',
  'media.dashboard.move',
  'media.dashboard.delete',
  'media.dashboard.folder.create',
  'media.dashboard.folder.delete',
  'media.dashboard.folder.copy',
  'media.dashboard.folder.move',
]);
const ACTION_ROUTES: ReadonlySet<string> = new Set(MEDIA_ACTION_ROUTES);

/**
 * An `authorize` check for another app's federated console calling this console. `identify` says
 * who is calling, `permit` whether it may; the routes are fixed:
 *
 * - `GET <apiBase>/object/raw` (its `proxyObjects`) with the `read` permission;
 * - `POST` on the action routes ({@link MEDIA_ACTION_ROUTES}, its `proxyActions`) with `write`;
 * - nothing else.
 *
 * A caller sees and acts on every tenant's media of THIS app, never that of the other apps this
 * console federates (`apps`). Nobody identified: `401`; an app not let in, not permitted, or on any
 * other route: `403`. Combine it with the viewer check through {@link anyAuthorize}.
 *
 * ```ts
 * authorize: anyAuthorize(
 *   authorizeAppCaller({ identify: identifySharedSecret({ apps: { hub: env.get('MEDIA_HUB_SECRET') } }), permit: permitAll() }),
 *   adminsOnly,
 * ),
 * ```
 */
export function authorizeAppCaller(options: AuthorizeAppCallerOptions): ConsoleAuthorize {
  if (typeof options?.identify !== 'function') {
    throw new Error('authorizeAppCaller: `identify` must be a function');
  }
  if (typeof options.permit !== 'function') {
    throw new Error('authorizeAppCaller: `permit` must be a function');
  }
  const read = options.read ?? MEDIA_OBJECTS_READ;
  const write = options.write === undefined ? MEDIA_OBJECTS_WRITE : options.write;
  const apps = options.apps ? new Set(options.apps) : undefined;
  return async (ctx: HttpContext): Promise<ConsoleAuthorizeResult> => {
    const caller = await options.identify(ctx);
    if (!caller || typeof caller.app !== 'string' || caller.app === '') {
      return { allowed: false, reason: 'unauthenticated' };
    }
    if (apps !== undefined && !apps.has(caller.app)) return { allowed: false, reason: 'forbidden' };
    const route = (ctx as unknown as { route?: { name?: unknown } }).route?.name;
    const method = ctx.request.method();
    let permission: string | undefined;
    if (method === 'GET' && route === RAW_ROUTE) permission = read;
    else if (
      write !== false &&
      method === 'POST' &&
      typeof route === 'string' &&
      ACTION_ROUTES.has(route)
    ) {
      permission = write;
    }
    if (permission !== undefined && (await options.permit(caller, permission, ctx)) === true) {
      LET_IN.set(ctx, caller);
      // `apps: []`: only this app's own media, never the other apps this console federates.
      return { allowed: true, tenants: '*', apps: [] };
    }
    return { allowed: false, reason: 'forbidden' };
  };
}

/**
 * {@link IdentifyAppCaller} for Agora apps signed in through `@adonis-agora/authkit`: the caller is
 * `ctx.agora.caller`, which `@adonis-agora/authkit-client` (1.0.0-rc.9 or later) sets from a
 * verified service token (`service.name` in config/authkit_client.ts). Its `claims.capabilities` are
 * the capabilities granted to it on this app (`authkit:client grant-app`).
 */
export function identifyAgoraCaller(): IdentifyAppCaller {
  return (ctx) => {
    const caller = (
      ctx as unknown as { agora?: { caller?: { app?: unknown; capabilities?: unknown } } }
    ).agora?.caller;
    if (!caller || typeof caller.app !== 'string') return undefined;
    const capabilities = Array.isArray(caller.capabilities)
      ? caller.capabilities.filter((c): c is string => typeof c === 'string')
      : [];
    return { app: caller.app, claims: { capabilities } };
  };
}

/** Options for {@link identifySharedSecret}. */
export interface IdentifySharedSecretOptions {
  /** The calling apps, by name, each with the secret it sends. Long and random; one per app. */
  apps: Record<string, string | undefined>;
  /**
   * The request header carrying the secret. Default `authorization`, as `Bearer <secret>`; any
   * other header carries the secret as is.
   */
  header?: string | undefined;
}

/**
 * {@link IdentifyAppCaller} without an identity provider: each calling app sends its own secret
 * (`Authorization: Bearer <secret>` by default), compared in constant time. A missing or wrong
 * secret identifies nobody (`401`). Throws at config time on an app with an empty secret.
 */
export function identifySharedSecret(options: IdentifySharedSecretOptions): IdentifyAppCaller {
  const header = (options?.header ?? 'authorization').toLowerCase();
  const entries = Object.entries(options?.apps ?? {}).map(([app, secret]) => {
    if (typeof secret !== 'string' || secret === '') {
      throw new Error(`identifySharedSecret: apps["${app}"] must be a non-empty secret`);
    }
    return { app, digest: digest(secret) };
  });
  if (entries.length === 0) throw new Error('identifySharedSecret: name at least one app');
  return (ctx) => {
    const raw = ctx.request.header(header);
    if (typeof raw !== 'string' || raw.trim() === '') return undefined;
    let sent = raw.trim();
    if (header === 'authorization') {
      const match = /^Bearer\s+(.+)$/i.exec(sent);
      if (!match?.[1]) return undefined;
      sent = match[1];
    }
    const presented = digest(sent);
    // Every secret is compared, so the time taken does not say which app matched.
    let found: string | undefined;
    for (const entry of entries) {
      if (timingSafeEqual(presented, entry.digest) && found === undefined) found = entry.app;
    }
    return found === undefined ? undefined : { app: found };
  };
}

/**
 * {@link PermitAppCaller} reading the capabilities the caller's token carries
 * (`claims.capabilities`, set by {@link identifyAgoraCaller}), with the Agora wildcard rule
 * ({@link capabilityAllows}).
 */
export function permitTokenCapabilities(): PermitAppCaller {
  return (caller, permission) => {
    const granted = caller.claims?.capabilities;
    return (
      Array.isArray(granted) &&
      granted.some((g) => typeof g === 'string' && capabilityAllows(g, permission))
    );
  };
}

/** {@link PermitAppCaller} for trusted callers: every identified app may read and act. */
export function permitAll(): PermitAppCaller {
  return () => true;
}

/** Options for {@link authorizeAgoraCaller}. */
export interface AuthorizeAgoraCallerOptions {
  /** The calling apps let in, by name (the token's partition, e.g. `agora-hub`). Omit for any. */
  apps?: string[] | undefined;
  /** What the caller must hold to read object bytes. Default {@link MEDIA_OBJECTS_READ}. */
  capability?: string | undefined;
  /**
   * Also let a caller run the console's actions ({@link MEDIA_ACTION_ROUTES}): another app's
   * federated console with `proxyActions`. Default `false`: object bytes only.
   */
  actions?: boolean | undefined;
  /** What the caller must hold to run actions. Default {@link MEDIA_OBJECTS_WRITE}. */
  actionsCapability?: string | undefined;
}

/**
 * {@link authorizeAppCaller} with {@link identifyAgoraCaller} and {@link permitTokenCapabilities}:
 * an Agora app calling with an authkit service token may read object bytes with
 * `media:objects:read` and, with `actions: true`, run actions with `media:objects:write`.
 *
 * ```ts
 * authorize: anyAuthorize(authorizeAgoraCaller({ apps: ['agora-hub'], actions: true }), adminsOnly),
 * ```
 */
export function authorizeAgoraCaller(options: AuthorizeAgoraCallerOptions = {}): ConsoleAuthorize {
  return authorizeAppCaller({
    identify: identifyAgoraCaller(),
    permit: permitTokenCapabilities(),
    ...(options.apps !== undefined ? { apps: options.apps } : {}),
    ...(options.capability !== undefined ? { read: options.capability } : {}),
    write: options.actions === true ? (options.actionsCapability ?? MEDIA_OBJECTS_WRITE) : false,
  });
}

/** Options for {@link mediaCallerCsrfExceptions}. */
export interface MediaCallerCsrfOptions {
  /** Where the console's API is mounted (its `apiBasePath`). Default `/media/dashboard/api`. */
  apiBase?: string | undefined;
  /**
   * The header the calling app proves itself with. Default `authorization` (a `Bearer` token); the
   * `header` of {@link identifySharedSecret} when it uses another one.
   */
  header?: string | undefined;
}

/**
 * For `@adonisjs/shield`'s `csrf.exceptRoutes`: `true` for a request another app's federated
 * console sends this console's API (`proxyActions`), so the CSRF check does not refuse it. Such a
 * request carries `Authorization: Bearer` (or the `header` you name) and no cookie: a browser cannot
 * send it from another site without a CORS preflight, and without a cookie it carries no viewer
 * session, so `authorize` can only let it in through the app's credential. Everything else keeps
 * its check.
 *
 * ```ts
 * csrf: { enabled: true, exceptRoutes: (ctx) => mediaCallerCsrfExceptions(ctx, { apiBase: '/media/api' }) },
 * ```
 */
export function mediaCallerCsrfExceptions(
  ctx: HttpContext,
  options: MediaCallerCsrfOptions = {},
): boolean {
  const base = (options.apiBase ?? '/media/dashboard/api').replace(/\/+$/, '');
  const url = ctx.request.url();
  if (!url.startsWith(`${base}/`)) return false;
  const header = (options.header ?? 'authorization').toLowerCase();
  const credential = ctx.request.header(header);
  if (typeof credential !== 'string' || credential.trim() === '') return false;
  if (header === 'authorization' && !/^Bearer\s+\S/i.test(credential)) return false;
  const cookie = ctx.request.header('cookie');
  return cookie === undefined || cookie === null || cookie === '';
}
