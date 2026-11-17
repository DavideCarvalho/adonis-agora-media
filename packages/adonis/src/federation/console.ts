import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
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
  /** How long a command waits for the app to answer, in ms. Default 15 000. */
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
      const target = typeof args[0] === 'string' ? ` ${args[0]}` : '';
      options.log?.(`[media] federated console: ${verb}${target} by ${command.actor ?? 'unknown'}`);
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

  constructor(options: {
    id: string;
    label?: string | undefined;
    store: MediaStore;
    sessions?: UploadSessionStore | undefined;
    channel: RedisConsoleChannel;
    origin?: string | undefined;
    timeoutMs?: number | undefined;
  }) {
    this.id = options.id;
    this.label = options.label ?? options.id;
    this.store = options.store;
    this.sessions = options.sessions;
    this.channel = options.channel;
    this.origin = options.origin?.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
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
 * go to that app. `actions` is THIS console's switch: an action this console has off never leaves.
 */
export class FederatedConsoleService {
  readonly #app: FederatedApp;
  readonly #actions: boolean;
  readonly #actor: string | undefined;
  /** Reads that need nothing but the tables, done the way the app's own console does them. */
  readonly #local: DashboardService;

  constructor(app: FederatedApp, options: { actions: boolean; actor?: string | undefined }) {
    this.#app = app;
    this.#actions = options.actions;
    this.#actor = options.actor;
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

  async #act(verb: MediaConsoleVerb, ...args: unknown[]): Promise<void> {
    if (!this.#actions) throw new DashboardError('actions are disabled on this console', 403);
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

  async object(disk: string, key: string): Promise<ObjectDetailResponse> {
    const detail = (await this.#send('object', disk, key)) as ObjectDetailResponse;
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

  objectStream(): Promise<{ stream: Readable; contentType: string; size: number }> {
    return Promise.reject(new DashboardError('read through the app that owns it', 501));
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
