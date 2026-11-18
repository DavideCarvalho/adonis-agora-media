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

/** The capability {@link authorizeAgoraCaller} asks of a calling app by default. */
export const MEDIA_OBJECTS_READ = 'media:objects:read';

/** Options for {@link authorizeAgoraCaller}. */
export interface AuthorizeAgoraCallerOptions {
  /** The calling apps let in, by name (the token's partition, e.g. `agora-hub`). Omit for any. */
  apps?: string[] | undefined;
  /** What the caller must hold on this app. Default {@link MEDIA_OBJECTS_READ}. */
  capability?: string | undefined;
}

/** The route {@link authorizeAgoraCaller} opens: the console's object bytes. */
const RAW_ROUTE = 'media.dashboard.object.raw';

/**
 * An `authorize` check for another app's federated console fetching this console's object bytes
 * (its `proxyObjects`): allows `GET <apiBase>/object/raw` when the request comes from an Agora app
 * holding `media:objects:read` on this app, and nothing else. The caller is read from
 * `ctx.agora.caller`, which `@adonis-agora/authkit-client` sets from a verified service token
 * (`service.name` in config/authkit_client.ts). Combine it with the viewer check:
 *
 * ```ts
 * authorize: anyAuthorize(authorizeAgoraCaller({ apps: ['agora-hub'] }), adminsOnly),
 * ```
 *
 * A caller sees every tenant's objects of THIS app, never those of the other apps this console
 * federates (`apps`). Needs `@adonis-agora/authkit-client` 1.0.0-rc.9 or later (calls between
 * apps). Without a caller it answers `401`; a caller without the
 * capability, or on any other route, gets `403`.
 */
export function authorizeAgoraCaller(options: AuthorizeAgoraCallerOptions = {}): ConsoleAuthorize {
  const capability = options.capability ?? MEDIA_OBJECTS_READ;
  const apps = options.apps ? new Set(options.apps) : undefined;
  return (ctx: HttpContext): ConsoleAuthorizeResult => {
    const caller = (
      ctx as unknown as { agora?: { caller?: { app?: unknown; capabilities?: unknown } } }
    ).agora?.caller;
    if (!caller || typeof caller.app !== 'string') {
      return { allowed: false, reason: 'unauthenticated' };
    }
    const route = (ctx as unknown as { route?: { name?: unknown } }).route?.name;
    const granted = Array.isArray(caller.capabilities) ? caller.capabilities : [];
    if (
      ctx.request.method() === 'GET' &&
      route === RAW_ROUTE &&
      (apps === undefined || apps.has(caller.app)) &&
      granted.some((g) => typeof g === 'string' && capabilityAllows(g, capability))
    ) {
      // `apps: []`: only this app's own objects, never the other apps this console federates.
      return { allowed: true, tenants: '*', apps: [] };
    }
    return { allowed: false, reason: 'forbidden' };
  };
}
