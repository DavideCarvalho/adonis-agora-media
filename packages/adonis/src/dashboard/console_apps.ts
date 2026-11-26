import { createHash, timingSafeEqual } from 'node:crypto';
import type { HttpContext } from '@adonisjs/core/http';
import {
  type ConsoleAuthorize,
  type ConsoleAuthorizeDecision,
  type ConsoleAuthorizeResult,
} from './console_authorize.js';
import { type ConsoleCapabilityTable, consoleCapabilityAllows } from './console_capabilities.js';

/**
 * What media adds on top of the canonical console access contract (`console_authorize.ts`, kept
 * byte-identical across the Agora libs): the capability rules, media's console capabilities, and
 * the checks for another app calling this console (`authorizeAgoraCaller` and friends).
 */

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** The capability {@link authorizeAgoraCaller} asks of a calling app to read object bytes. */
export const MEDIA_OBJECTS_READ = 'media:objects:read';

/** The capability {@link authorizeAgoraCaller} asks of a calling app to run actions (`actions`). */
export const MEDIA_OBJECTS_WRITE = 'media:objects:write';

/** Media's console capabilities, each a read or a write (for {@link consoleCapabilityAllows}). */
export const MEDIA_CONSOLE_CAPABILITIES: ConsoleCapabilityTable = Object.freeze({
  [MEDIA_OBJECTS_READ]: 'read',
  [MEDIA_OBJECTS_WRITE]: 'write',
});

/**
 * Whether `granted` (a token's or a viewer's capabilities) allows the console capability
 * `required`: the shared matcher (`console_capabilities.ts`) with media's table. `*`, `media:*`,
 * `media:console:*`, `media:console:write` (reads and writes), `media:console:read` (reads), the
 * exact name, or a hierarchical grant like `media:objects:*`. A `*` anywhere else grants nothing.
 */
export function capabilitiesAllow(granted: readonly unknown[], required: string): boolean {
  return consoleCapabilityAllows(granted, required, MEDIA_CONSOLE_CAPABILITIES);
}

/**
 * One granted capability against `required`, by the same rules as {@link capabilitiesAllow}.
 * @deprecated Use {@link capabilitiesAllow} (a list of grants).
 */
export function capabilityAllows(granted: string, required: string): boolean {
  return capabilitiesAllow([granted], required);
}

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
    throw new Error('[@adonis-agora/media] authorizeAppCaller: `identify` must be a function');
  }
  if (typeof options.permit !== 'function') {
    throw new Error('[@adonis-agora/media] authorizeAppCaller: `permit` must be a function');
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
      throw new Error(
        `[@adonis-agora/media] identifySharedSecret: apps["${app}"] must be a non-empty secret`,
      );
    }
    return { app, digest: digest(secret) };
  });
  if (entries.length === 0)
    throw new Error('[@adonis-agora/media] identifySharedSecret: name at least one app');
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
      // Alias-aware: `media:console:*` (and read/write) count, as on the Redis channel.
      capabilitiesAllow(granted, permission)
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

/**
 * The capabilities a viewer's `authorize` decision grants on media's console (§4b): only the ones
 * that reach media's console set (`media:objects:read`, `media:objects:write`), all of them when
 * the decision says nothing, and no write with `access: 'read'`.
 */
export function viewerConsoleCapabilities(
  decision:
    | Pick<Extract<ConsoleAuthorizeDecision, { allowed: true }>, 'capabilities' | 'access'>
    | undefined,
): string[] {
  const granted = decision?.capabilities;
  const all = [MEDIA_OBJECTS_READ, MEDIA_OBJECTS_WRITE];
  const reach = granted === undefined ? all : all.filter((c) => capabilitiesAllow(granted, c));
  return decision?.access === 'read' ? reach.filter((c) => c !== MEDIA_OBJECTS_WRITE) : reach;
}
