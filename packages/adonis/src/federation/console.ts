import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import {
  DashboardError,
  DashboardService,
  type MediaManagerLike,
  toMediaEntry,
} from '../dashboard/service.js';
import type {
  CollectionFilter,
  CollectionListResponse,
  CollectionsSummaryResponse,
  CursorParams,
  DiskListResponse,
  MediaDetailResponse,
  MediaEntry,
  ObjectDetailResponse,
  ObjectInsightsResponse,
  ObjectListResponse,
  Topology,
  UploadDetailResponse,
  UploadFilter,
  UploadListResponse,
} from '../dashboard/types.js';
import type { MediaConversion } from '../media_record.js';
import type { MediaStore } from '../media_store.js';
import type { UploadSessionStore } from '../resumable_upload.js';
import type { StoreFactory } from '../stores/factory.js';
import type { UploadSessionStoreFactory } from '../upload_sessions/factory.js';
import {
  APP_UNREACHABLE,
  type MediaConsoleCommand,
  RedisConsoleChannel,
  resolveRedisConnection,
} from './redis_channel.js';

/**
 * The federated media console: one app's media console also shows the media of other apps, each of
 * which keeps its own database tables, its own disks and its own credentials. The console reads an
 * app's records and upload sessions straight from that app's tables, and asks the app itself (over
 * Redis) for what needs its disks: listing them, signing URLs, and the actions.
 */

/** One other app shown in this console (`config/media_dashboard.ts` → `apps`). */
export interface FederatedConsoleApp {
  /** The name shown in the app selector. Defaults to the key. */
  label?: string | undefined;
  /**
   * That app's media store: `stores.lucid({ connection, schema })` naming where ITS `media` table
   * is. Only read (never created or altered): give the connection's role `SELECT` on it.
   */
  store: StoreFactory | MediaStore;
  /**
   * That app's resumable upload sessions: `uploadSessions.lucid({ connection, schema })`. Omit and
   * the Uploads page shows nothing for that app. Only read.
   */
  uploadSessions?: UploadSessionStoreFactory | UploadSessionStore | undefined;
  /**
   * Where that app answers (its `consoleCommands` in `config/media.ts`): the `@adonisjs/redis`
   * connection to publish on and the app's `prefix`.
   */
  controlPlane: { connection?: string | undefined; prefix: string } | RedisConsoleChannel;
  /**
   * That app's public origin (`https://app.example.com`). An app whose console serves its objects
   * through itself (`objectUrls: 'proxy'`) hands back paths, and they are opened on this origin
   * (where the viewer must be signed in to that app). Not needed when the app signs URLs straight
   * to its storage.
   */
  origin?: string | undefined;
  /**
   * Serve that app's object bytes from THIS console (same origin) instead of sending the browser
   * to the app. The console asks the app for the object's URL as usual, then fetches it itself: a
   * path on {@link origin} (an app with `objectUrls: 'proxy'`) with `headers`, a signed URL as is.
   * Previews, thumbnails and "Open" then work for a viewer with no session in that app, and under a
   * CSP that only allows this origin's images.
   *
   * `headers` is what that app needs to accept the request, e.g. a service token its console's
   * `authorize` takes (`authorizeAgoraCaller` in `@adonis-agora/media/dashboard`). They are sent only to `origin`.
   *
   * ```ts
   * proxyObjects: { headers: async () => ({ authorization: `Bearer ${await token()}` }) },
   * ```
   *
   * `true` fetches with no extra headers (an outbound interceptor may add them). Default: off, the
   * browser is sent to the app's URL.
   */
  proxyObjects?: boolean | FederatedObjectProxy | undefined;
  /**
   * Send this console's actions on that app's media (delete, copy, move, folders, delete record,
   * cancel upload) to the app's own console API over HTTP, at {@link origin}. The app runs each one
   * with its own store and disks, as if from its own console. Needs `origin`.
   *
   * The app's console must let this console in for those routes: `authorizeAgoraCaller({ actions:
   * true })` there, the `media:objects:write` capability for this console's service token, and
   * `actions: true` in its config/media_dashboard.ts.
   *
   * ```ts
   * proxyActions: { apiPath: '/media/api' },
   * ```
   *
   * `true` uses the defaults. `headers` defaults to `proxyObjects.headers`. Turns actions on for
   * this app whatever this console's own `actions` says; `actions: false` on the entry turns them
   * off again. Without it, actions go over {@link controlPlane} (when this console has `actions` on
   * and the app answers them, `consoleCommands.actions`).
   */
  proxyActions?: boolean | FederatedActionProxy | undefined;
  /**
   * Whether this console runs actions on that app's media. Default: on with `proxyActions`,
   * otherwise this console's own `actions`.
   */
  actions?: boolean | undefined;
  /** How long a command waits for the app to answer, in ms. Default 15 000. */
  timeoutMs?: number | undefined;
}

/** {@link FederatedConsoleApp.proxyActions} as an object. */
export interface FederatedActionProxy {
  /**
   * Request headers for the app's own origin (a service token). Asked on every action. Default:
   * `proxyObjects.headers`.
   */
  headers?: (() => Record<string, string> | Promise<Record<string, string>>) | undefined;
  /** Where the app's console API is mounted on its origin. Default `/media/dashboard/api`. */
  apiPath?: string | undefined;
  /** How long to wait for the app to answer an action, in ms. Default 30 000. */
  timeoutMs?: number | undefined;
}

/** Whether a console runs actions on the app `entry` (its `actions`, else on with `proxyActions`). */
export function federatedAppActions(entry: FederatedConsoleApp, consoleActions: boolean): boolean {
  if (typeof entry.actions === 'boolean') return entry.actions;
  if (entry.proxyActions) return true;
  return consoleActions;
}

/** {@link FederatedConsoleApp.proxyObjects} as an object. */
export interface FederatedObjectProxy {
  /** Extra request headers for the app's own origin (a service token). Asked on every fetch. */
  headers?: (() => Record<string, string> | Promise<Record<string, string>>) | undefined;
  /** How long to wait for the app to start answering, in ms. Default 30 000. */
  timeoutMs?: number | undefined;
}

/** What a federated app's key may look like (it travels in the URL as `?app=`). */
export const FEDERATED_APP_KEY = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Checks one `apps` entry at boot, so a misconfigured app fails the boot instead of the first
 * request that picks it. `redisConnections` are the names in `config/redis.ts` (`undefined`: no
 * Redis config to check against).
 */
export function validateFederatedConsoleApp(
  key: string,
  entry: FederatedConsoleApp,
  redisConnections: { names: string[]; default: string | undefined } | undefined,
): void {
  const fail = (message: string): never => {
    throw new Error(`[@adonis-agora/media] media_dashboard.apps["${key}"]: ${message}`);
  };
  if (!entry || typeof entry !== 'object') fail('must be an object');
  if (!entry.store) fail('`store` is required');
  const plane = entry.controlPlane;
  if (!(plane instanceof RedisConsoleChannel)) {
    if (!plane || typeof plane !== 'object') {
      fail('`controlPlane` is required ({ connection, prefix })');
    }
    if (typeof plane.prefix !== 'string' || plane.prefix.trim() === '') {
      fail("`controlPlane.prefix` must be the other app's `consoleCommands.prefix` (not empty)");
    }
    if (
      plane.connection !== undefined &&
      (typeof plane.connection !== 'string' || plane.connection === '')
    ) {
      fail('`controlPlane.connection` must be a connection name of config/redis.ts');
    }
    if (!redisConnections) {
      fail('the federated console needs @adonisjs/redis (no config/redis.ts found)');
    } else {
      const name = plane.connection ?? redisConnections.default;
      if (name === undefined || !redisConnections.names.includes(name)) {
        fail(
          `\`controlPlane.connection\` "${name ?? '(default)'}" is not a connection of config/redis.ts (${redisConnections.names.join(', ') || 'none'})`,
        );
      }
    }
  }
  if (
    entry.timeoutMs !== undefined &&
    (typeof entry.timeoutMs !== 'number' ||
      !Number.isFinite(entry.timeoutMs) ||
      entry.timeoutMs <= 0)
  ) {
    fail('`timeoutMs` must be a positive number of milliseconds');
  }
  for (const name of ['proxyObjects', 'proxyActions'] as const) {
    const proxy = entry[name];
    if (proxy === undefined || typeof proxy === 'boolean') continue;
    if (!proxy || typeof proxy !== 'object') fail(`\`${name}\` must be a boolean or an object`);
    if (proxy.headers !== undefined && typeof proxy.headers !== 'function') {
      fail(`\`${name}.headers\` must be a function returning the headers`);
    }
    if (
      proxy.timeoutMs !== undefined &&
      (typeof proxy.timeoutMs !== 'number' ||
        !Number.isFinite(proxy.timeoutMs) ||
        proxy.timeoutMs <= 0)
    ) {
      fail(`\`${name}.timeoutMs\` must be a positive number of milliseconds`);
    }
  }
  const actionProxy = entry.proxyActions;
  if (actionProxy && typeof actionProxy === 'object' && actionProxy.apiPath !== undefined) {
    const path = actionProxy.apiPath;
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[?#\\]/.test(path)
    ) {
      fail('`proxyActions.apiPath` must be a path like /media/api (no query, no host)');
    }
  }
  if (entry.proxyActions && entry.origin === undefined) {
    fail("`proxyActions` needs `origin`: the app's console API is called there");
  }
  if (entry.actions !== undefined && typeof entry.actions !== 'boolean') {
    fail('`actions` must be a boolean');
  }
  if (entry.origin !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(entry.origin);
    } catch {
      url = undefined;
    }
    if (
      !url ||
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.pathname.replace(/\/+$/, '') !== '' ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      fail(
        `\`origin\` must be an http(s) origin like https://app.example.com (got "${entry.origin}")`,
      );
    }
  }
}

/** The commands that only read. */
export const READ_VERBS = [
  'topology',
  'disks',
  'objects',
  'object',
  'objectInsights',
  'objectUrls',
] as const;

/** The commands that change something: run only when the owning app sets `actions: true`. */
export const ACTION_VERBS = [
  'deleteMediaRecord',
  'abortUpload',
  'remove',
  'copy',
  'move',
  'createFolder',
  'deleteFolder',
  'copyFolder',
  'moveFolder',
] as const;

export type MediaConsoleVerb = (typeof READ_VERBS)[number] | (typeof ACTION_VERBS)[number];

/** The action verbs, as the app's console API takes them (`proxyActions`): `POST <apiPath><path>`. */
type ActionVerb = (typeof ACTION_VERBS)[number];

/** Each action as a request on the app's console API: the path and the JSON body. */
export function federatedActionRequest(
  verb: ActionVerb,
  args: unknown[],
): { path: string; body: Record<string, unknown> } {
  const [first] = args;
  const body = (first && typeof first === 'object' ? first : {}) as Record<string, unknown>;
  switch (verb) {
    case 'abortUpload':
      return { path: `/uploads/${encodeURIComponent(String(first))}/abort`, body: {} };
    case 'deleteMediaRecord':
      return { path: '/media-record/delete', body: { id: String(first) } };
    case 'remove':
      return { path: '/delete', body };
    case 'copy':
      return { path: '/copy', body };
    case 'move':
      return { path: '/move', body };
    case 'createFolder':
      return { path: '/folder', body };
    case 'deleteFolder':
      return { path: '/folder/delete', body };
    case 'copyFolder':
      return { path: '/folder/copy', body };
    case 'moveFolder':
      return { path: '/folder/move', body };
  }
}

/** The header a forwarded action names who asked for it in (the app logs it). */
export const ACTOR_HEADER = 'x-agora-actor';

/**
 * A viewer name fit for a header and a log line: control characters (CR/LF…) become spaces,
 * anything outside printable ASCII is percent-encoded, at most 200 characters.
 */
export function sanitizeActor(actor: unknown): string | undefined {
  if (typeof actor !== 'string') return undefined;
  const clean = actor
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/[^\x20-\x7e]/gu, (c) => {
      try {
        return encodeURIComponent(c);
      } catch {
        return '?'; // a lone surrogate
      }
    })
    .trim()
    .slice(0, 200);
  return clean === '' ? undefined : clean;
}

/**
 * The statuses of the app's own answer to an action that reach the viewer as they are, with the
 * app's message: what the viewer can act on. Any other refusal is a `502`.
 */
export const RELAYED_ACTION_STATUSES: ReadonlySet<number> = new Set([
  400, 404, 409, 413, 415, 422, 429,
]);

/** `<apiPath><route>` with exactly one `/` between them (`/`, `/media/api/`, `/media//api`). */
export function joinApiPath(apiPath: string, route: string): string {
  const base = apiPath.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  return `${base}/${route.replace(/^\/+/, '')}`;
}

const READS: ReadonlySet<string> = new Set(READ_VERBS);
const ACTIONS: ReadonlySet<string> = new Set(ACTION_VERBS);

/** A command this app does not answer (unknown verb). Answered `501` by the console. */
export const UNSUPPORTED = 'unsupported-request';

/**
 * Run the commands another app's federated console sends this app, against this app's own console
 * service (`service()` builds it with every tenant in view). Mutating verbs run only with
 * `actions`; mutating commands are logged with who sent them.
 */
export function mediaConsoleCommandHandler(options: {
  service: () => Promise<DashboardService>;
  actions: boolean;
  log?: ((line: string) => void) | undefined;
}): (command: MediaConsoleCommand) => Promise<unknown> {
  return async (command) => {
    const { verb, args } = command;
    if (!READS.has(verb) && !ACTIONS.has(verb)) {
      throw Object.assign(new Error(`this app does not answer the media console command ${verb}`), {
        code: UNSUPPORTED,
      });
    }
    if (ACTIONS.has(verb)) {
      if (!options.actions) {
        throw new DashboardError(
          'this app does not take actions from another console (consoleCommands.actions is off)',
          403,
        );
      }
      const target = sanitizeActor(args[0]);
      options.log?.(
        `[media] federated console: ${verb}${target ? ` ${target}` : ''} by ${sanitizeActor(command.actor) ?? 'unknown'}`,
      );
    }
    const svc = await options.service();
    if (verb === 'objectUrls') {
      const items = Array.isArray(args[0])
        ? (args[0] as Array<{ disk?: unknown; key?: unknown }>)
        : [];
      return Promise.all(
        items.map(async (item) =>
          typeof item?.disk === 'string' && typeof item.key === 'string'
            ? svc.objectUrlFor(item.disk, item.key).catch(() => null)
            : null,
        ),
      );
    }
    const fn = (svc as unknown as Record<string, unknown>)[verb];
    if (typeof fn !== 'function') {
      throw Object.assign(new Error(`this app does not answer the media console command ${verb}`), {
        code: UNSUPPORTED,
      });
    }
    return (fn as (...a: unknown[]) => unknown).apply(svc, args);
  };
}

/** Another app as the console sees it: its stores and its command channel. Built once per app. */
export class FederatedApp {
  readonly id: string;
  readonly label: string;
  readonly store: MediaStore;
  readonly sessions: UploadSessionStore | undefined;
  readonly channel: RedisConsoleChannel;
  readonly origin: string | undefined;
  readonly timeoutMs: number | undefined;
  /** Set when this console serves the app's object bytes itself (`proxyObjects`). */
  readonly proxy: FederatedObjectProxy | undefined;
  /** Set when this console sends its actions to the app's console API (`proxyActions`). */
  readonly actionProxy:
    | (Omit<FederatedActionProxy, 'apiPath' | 'timeoutMs'> & { apiPath: string; timeoutMs: number })
    | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: {
    id: string;
    label?: string | undefined;
    store: MediaStore;
    sessions?: UploadSessionStore | undefined;
    channel: RedisConsoleChannel;
    origin?: string | undefined;
    timeoutMs?: number | undefined;
    proxyObjects?: boolean | FederatedObjectProxy | undefined;
    proxyActions?: boolean | FederatedActionProxy | undefined;
    /** For tests. Default: the global `fetch`. */
    fetch?: typeof fetch | undefined;
  }) {
    this.id = options.id;
    this.label = options.label ?? options.id;
    this.store = options.store;
    this.sessions = options.sessions;
    this.channel = options.channel;
    this.origin = options.origin?.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    const proxy = options.proxyObjects;
    this.proxy = proxy === true ? {} : proxy ? proxy : undefined;
    const actions = options.proxyActions;
    if (actions) {
      const spec = actions === true ? {} : actions;
      const headers =
        spec.headers ?? (typeof proxy === 'object' && proxy ? proxy.headers : undefined);
      this.actionProxy = {
        apiPath: spec.apiPath ?? '/media/dashboard/api',
        timeoutMs: spec.timeoutMs ?? 30_000,
        ...(headers ? { headers } : {}),
      };
    }
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Send `verb` to the app and return its answer; errors become the console's HTTP answers. */
  async send(verb: MediaConsoleVerb, args: unknown[], actor?: string): Promise<unknown> {
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    let reply: Awaited<ReturnType<RedisConsoleChannel['send']>>;
    try {
      reply = await this.channel.send(
        { id: randomUUID(), verb, args, ...(actor !== undefined ? { actor } : {}) },
        this.timeoutMs !== undefined ? { timeoutMs: this.timeoutMs } : {},
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FederatedAppError(`${this.label}: ${message}`, 503);
    }
    if (reply.ok) return reply.data;
    const { message, code, status } = reply.error;
    if (code === APP_UNREACHABLE) throw new FederatedAppError(`${this.label}: ${message}`, 503);
    if (code === UNSUPPORTED) throw new FederatedAppError(message, 501);
    // The app's own answer to a bad request (unknown record, bad key, actions off…) stands.
    if (typeof status === 'number' && status >= 400 && status < 500) {
      throw new DashboardError(message, status);
    }
    throw new FederatedAppError(`the ${this.label} app answered with an error`, 502, message);
  }

  /** `url` as the browser can open it: absolute as is, a path on the app's {@link origin}. */
  absolute(url: unknown): string | null {
    if (typeof url !== 'string' || url === '') return null;
    if (/^https?:\/\//i.test(url)) return url;
    if (url.startsWith('/') && !url.startsWith('//') && this.origin) return `${this.origin}${url}`;
    return null;
  }

  /**
   * Fetch the bytes at `url` (what the app answered for an object) for this console to serve. A
   * path goes to the app's {@link origin} with the `proxyObjects` headers; a signed URL is fetched
   * as is, with none. The app's `404` stays a `404`; any other refusal is a `502` (cause logged).
   */
  async fetchBytes(url: string): Promise<{ stream: Readable; contentType: string; size: number }> {
    const target = this.absolute(url);
    if (!target) {
      throw new DashboardError(
        `the ${this.label} app serves its objects through itself: set \`origin\` on its entry in \`apps\``,
        501,
      );
    }
    const own = this.origin !== undefined && new URL(target).origin === new URL(this.origin).origin;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.proxy?.timeoutMs ?? 30_000);
    let response: Response;
    try {
      // Inside the `try`: a token provider that fails is a 503 with its cause logged.
      const headers = new Headers(
        own && this.proxy?.headers ? await this.proxy.headers() : undefined,
      );
      // `manual`: a redirect would carry the service token to wherever it points.
      response = await this.#fetch(target, {
        headers,
        redirect: own ? 'manual' : 'follow',
        signal: controller.signal,
      });
    } catch (error) {
      throw new FederatedAppError(
        `${this.label}: the object could not be fetched`,
        503,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404) throw new DashboardError('not found', 404);
      throw new FederatedAppError(
        `the ${this.label} app did not hand over the object`,
        502,
        `GET ${new URL(target).origin}${new URL(target).pathname} answered HTTP ${response.status}${
          response.status === 401 || response.status === 403
            ? " (does its console `authorize` accept this console's request?)"
            : ''
        }`,
      );
    }
    const length = Number(response.headers.get('content-length'));
    return {
      stream: Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      size: response.headers.has('content-length') && Number.isFinite(length) ? length : Number.NaN,
    };
  }

  /**
   * Run an action in the app through its console API (`proxyActions`): `POST` on its {@link origin}
   * with the headers, `redirect: 'manual'`. The app's `404` and its answers to a bad request stand;
   * a refusal (`401`/`403`), a redirect or a failure is a `502` (cause logged); no answer is a `503`.
   */
  async forwardAction(verb: ActionVerb, args: unknown[], actor?: string): Promise<void> {
    const spec = this.actionProxy;
    if (!spec || !this.origin) {
      throw new DashboardError(`${this.label}: actions are not sent to this app over HTTP`, 501);
    }
    const { path, body } = federatedActionRequest(verb, args);
    const route = joinApiPath(spec.apiPath, path);
    const target = `${this.origin}${route}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs);
    let response: Response;
    try {
      // Inside the `try`: a token provider that fails is a 503 with its cause logged.
      const headers = new Headers(spec.headers ? await spec.headers() : undefined);
      headers.set('content-type', 'application/json');
      headers.set('accept', 'application/json');
      const named = sanitizeActor(actor);
      if (named !== undefined) headers.set(ACTOR_HEADER, named);
      // `manual`: a redirect would carry the service token to wherever it points.
      response = await this.#fetch(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (error) {
      throw new FederatedAppError(
        `${this.label}: the action could not be sent`,
        503,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      clearTimeout(timer);
    }
    const answer = await response.text().catch(() => '');
    if (response.ok) return;
    let message: string | undefined;
    try {
      const parsed = JSON.parse(answer) as { error?: unknown };
      if (typeof parsed.error === 'string') message = parsed.error.slice(0, 500);
    } catch {
      message = undefined;
    }
    const status = response.status;
    if (status === 404) throw new DashboardError(message ?? 'not found', 404);
    // The app's own answer the viewer can act on (a missing field, a conflict, too large…) stands.
    if (RELAYED_ACTION_STATUSES.has(status)) {
      throw new DashboardError(message ?? `the ${this.label} app refused the action`, status);
    }
    throw new FederatedAppError(
      `the ${this.label} app did not run the action`,
      502,
      `POST ${this.origin}${route} answered HTTP ${status}${message ? ` (${message})` : ''}${
        status === 401 || status === 403
          ? " (does its console `authorize` accept this console's actions, e.g. authorizeAgoraCaller({ actions: true }), and does it have `actions: true`?)"
          : ''
      }`,
    );
  }

  async close(): Promise<void> {
    await this.channel.close();
  }
}

/** An error the owning app could not be asked about (`503`), refused (`501`) or failed (`502`). */
export class FederatedAppError extends DashboardError {
  /** The owning app's own message, for this app's log (a `502` does not show it to the browser). */
  readonly detail: string | undefined;
  constructor(message: string, status: 501 | 502 | 503, detail?: string) {
    super(message, status);
    this.name = 'FederatedAppError';
    this.detail = detail;
  }
}

/** Build one configured app: its stores (read-only) and its command channel. */
export async function buildFederatedMediaApp(
  id: string,
  config: FederatedConsoleApp,
  app: { container: { make(binding: string): Promise<unknown> } },
): Promise<FederatedApp> {
  const ctx = { app: app as never, readOnly: true };
  const store = typeof config.store === 'function' ? await config.store(ctx) : config.store;
  const sessions =
    config.uploadSessions === undefined
      ? undefined
      : typeof config.uploadSessions === 'function'
        ? await config.uploadSessions(ctx)
        : config.uploadSessions;
  const channel =
    config.controlPlane instanceof RedisConsoleChannel
      ? config.controlPlane
      : new RedisConsoleChannel({
          client: await resolveRedisConnection(app.container, config.controlPlane.connection),
          prefix: config.controlPlane.prefix,
        });
  return new FederatedApp({
    id,
    ...(config.label !== undefined ? { label: config.label } : {}),
    store,
    ...(sessions !== undefined ? { sessions } : {}),
    channel,
    ...(config.origin !== undefined ? { origin: config.origin } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.proxyObjects !== undefined ? { proxyObjects: config.proxyObjects } : {}),
    ...(config.proxyActions !== undefined ? { proxyActions: config.proxyActions } : {}),
  });
}

const NO_DISKS: MediaManagerLike['storage'] = {
  defaultDisk: '',
  disk(): never {
    throw new DashboardError('the disks of another app are read through that app', 501);
  },
};

/**
 * The console's service over another app: the same surface as {@link DashboardService}. Records,
 * collections and upload sessions come from that app's tables; disks, object URLs and every action
 * go to that app (over Redis, or its console API with `proxyActions`). `actions` is THIS console's
 * switch for that app: an action this console has off never leaves.
 */
export class FederatedConsoleService {
  readonly #app: FederatedApp;
  readonly #actions: boolean;
  readonly #actor: string | undefined;
  readonly #rawUrl: ((disk: string, key: string) => string) | undefined;
  /** Reads that need nothing but the tables, done the way the app's own console does them. */
  readonly #local: DashboardService;

  constructor(
    app: FederatedApp,
    options: {
      actions: boolean;
      actor?: string | undefined;
      /**
       * This console's own byte route for the app's object (`<apiBase>/object/raw?app=…`). With it
       * and the app's `proxyObjects`, the URLs handed to the browser point here.
       */
      rawUrl?: ((disk: string, key: string) => string) | undefined;
    },
  ) {
    this.#app = app;
    this.#actions = options.actions;
    this.#actor = options.actor;
    this.#rawUrl = app.proxy ? options.rawUrl : undefined;
    const sessions = app.sessions;
    const store = app.store;
    this.#local = new DashboardService(
      {
        storage: NO_DISKS,
        hasResumable: sessions !== undefined,
        resumable: {
          list: async (filter) => (await sessions?.list?.(filter)) ?? [],
          abort: () => Promise.reject(new DashboardError('not here', 501)),
          listParts: async (id) => (await sessions?.listParts?.(id)) ?? [],
        },
        store: {
          list: (options) => store.list(options),
          find: (id) => store.find(id),
          delete: () => Promise.reject(new DashboardError('not here', 501)),
          ...(typeof store.collectionTotals === 'function'
            ? { collectionTotals: () => store.collectionTotals!() }
            : {}),
        },
      },
      { diskNames: [], actions: options.actions },
    );
  }

  #send(verb: MediaConsoleVerb, ...args: unknown[]): Promise<unknown> {
    return this.#app.send(verb, args, this.#actor);
  }

  async #act(verb: ActionVerb, ...args: unknown[]): Promise<void> {
    if (!this.#actions) throw new DashboardError('actions are disabled on this console', 403);
    while (args.length > 0 && args[args.length - 1] === undefined) args.pop();
    if (this.#app.actionProxy) {
      await this.#app.forwardAction(verb, args, this.#actor);
      return;
    }
    await this.#send(verb, ...args);
  }

  /** The app's disks count (`0` while it does not answer), uploads and this console's actions. */
  async topology(): Promise<Topology> {
    const disks = await this.disks().then(
      (list) => list.data.length,
      () => 0,
    );
    return {
      disks,
      hasUploads: this.#app.sessions !== undefined,
      actions: this.#actions,
      // The other app answers for its own storage; its disk list says what there is.
      storage: true,
      app: this.#app.id,
    };
  }

  disks(): Promise<DiskListResponse> {
    return this.#send('disks') as Promise<DiskListResponse>;
  }

  objects(
    disk: string,
    params: CursorParams & { prefix?: string } = {},
  ): Promise<ObjectListResponse> {
    return this.#send('objects', disk, params) as Promise<ObjectListResponse>;
  }

  /** `true` when this console serves the app's bytes itself ({@link objectStream}). */
  get servesBytes(): boolean {
    return this.#app.proxy !== undefined;
  }

  async object(disk: string, key: string): Promise<ObjectDetailResponse> {
    const detail = (await this.#send('object', disk, key)) as ObjectDetailResponse;
    if (this.#rawUrl && detail.url) return { ...detail, url: this.#rawUrl(disk, key) };
    return { ...detail, url: this.#app.absolute(detail.url) ?? '' };
  }

  /** Where the browser opens the object's bytes: the app's URL for it (absolute), or a `501`. */
  async objectRedirect(disk: string, key: string): Promise<string> {
    const [url] = (await this.#send('objectUrls', [{ disk, key }])) as Array<string | null>;
    const absolute = this.#app.absolute(url);
    if (absolute) return absolute;
    if (url === null || url === undefined) throw new DashboardError('not found', 404);
    throw new DashboardError(
      `the ${this.#app.label} app serves its objects through itself: set \`origin\` on its entry in \`apps\` to open them from here`,
      501,
    );
  }

  /** The object's bytes, fetched from the app (`proxyObjects`); a `501` without it. */
  async objectStream(
    disk: string,
    key: string,
  ): Promise<{ stream: Readable; contentType: string; size: number }> {
    if (!this.#app.proxy) throw new DashboardError('read through the app that owns it', 501);
    const [url] = (await this.#send('objectUrls', [{ disk, key }])) as Array<string | null>;
    if (url === null || url === undefined) throw new DashboardError('not found', 404);
    return this.#app.fetchBytes(url);
  }

  objectInsights(disk: string, key: string): Promise<ObjectInsightsResponse> {
    return this.#send('objectInsights', disk, key) as Promise<ObjectInsightsResponse>;
  }

  putObject(): Promise<void> {
    return Promise.reject(
      new DashboardError('uploading into another app is not available from this console', 501),
    );
  }

  uploads(filter: UploadFilter & { order?: 'asc' | 'desc' } = {}): Promise<UploadListResponse> {
    return this.#local.uploads(filter);
  }

  uploadDetail(id: string): Promise<UploadDetailResponse> {
    return this.#local.uploadDetail(id);
  }

  abortUpload(id: string): Promise<void> {
    return this.#act('abortUpload', id);
  }

  collections(params: CollectionFilter & CursorParams = {}): Promise<CollectionListResponse> {
    return this.#local.collections(params);
  }

  collectionsSummary(): Promise<CollectionsSummaryResponse> {
    return this.#local.collectionsSummary();
  }

  mediaEntry(id: string): Promise<MediaEntry> {
    return this.#local.mediaEntry(id);
  }

  /**
   * One record from the app's table, with a URL per conversion asked of the app. While the app does
   * not answer, the record still shows, without them.
   */
  async mediaRecord(id: string): Promise<MediaDetailResponse> {
    const record = await this.#app.store.find(id);
    if (!record) throw new DashboardError(`unknown media record: ${id}`, 404);
    const linkable = Object.entries(record.conversions).filter(
      (entry): entry is [string, MediaConversion & { disk: string; path: string }] =>
        typeof entry[1].disk === 'string' && typeof entry[1].path === 'string',
    );
    const rawUrl = this.#rawUrl;
    if (rawUrl) {
      const variants = linkable.map(([name, c]) => ({ name, url: rawUrl(c.disk, c.path) }));
      return { record: toMediaEntry(record), variants };
    }
    let urls: Array<string | null> = [];
    if (linkable.length > 0) {
      urls = (await this.#send(
        'objectUrls',
        linkable.map(([, c]) => ({ disk: c.disk, key: c.path })),
      ).catch(() => [])) as Array<string | null>;
    }
    const variants = linkable.flatMap(([name], i) => {
      const url = this.#app.absolute(urls[i]);
      return url ? [{ name, url }] : [];
    });
    return { record: toMediaEntry(record), variants };
  }

  deleteMediaRecord(id: string): Promise<void> {
    return this.#act('deleteMediaRecord', id);
  }

  copy(body: { disk: string; from: string; to: string; toDisk?: string }): Promise<void> {
    return this.#act('copy', body);
  }

  move(body: { disk: string; from: string; to: string; toDisk?: string }): Promise<void> {
    return this.#act('move', body);
  }

  remove(body: { disk: string; keys: string[] }): Promise<void> {
    return this.#act('remove', body);
  }

  createFolder(body: { disk: string; prefix: string }): Promise<void> {
    return this.#act('createFolder', body);
  }

  deleteFolder(body: { disk: string; prefix: string }): Promise<void> {
    return this.#act('deleteFolder', body);
  }

  copyFolder(body: { disk: string; from: string; to: string; toDisk?: string }): Promise<void> {
    return this.#act('copyFolder', body);
  }

  moveFolder(body: { disk: string; from: string; to: string; toDisk?: string }): Promise<void> {
    return this.#act('moveFolder', body);
  }
}
