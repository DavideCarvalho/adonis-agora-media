/**
 * What media runs on, for telescope's Architecture page ("media: media files → S3 hub-avatars").
 * Telescope walks `app.config.get('media')` after boot and reads, on every object or function it
 * meets, the uses stored under the global symbol {@link STACK_DESCRIPTOR}. Media does not depend on
 * telescope: the symbol is global, and the helper below is all there is to it.
 *
 * Never put a key, a secret or a URL with credentials in a `label`; `host` is hashed, never sent.
 */
import type { MediaConfig } from './define_config.js';

/** The symbol telescope reads a factory's {@link StackUse} list from. */
export const STACK_DESCRIPTOR = Symbol.for('@adonis-agora/stack');

/** One thing media uses: a database, a Redis server, a bucket, a Drive disk. */
export interface StackUse {
  /** `postgres`, `redis`, `s3`, `r2`, `gcs`, `minio`, `drive`, … */
  tech: string;
  /** The Lucid or Redis connection it goes through. */
  connection?: string;
  /** What it is for, in a few words. */
  purpose?: string;
  /** For a bucket or a disk: its name. */
  label?: string;
  /** Tells two buckets of the same name apart (hashed by telescope, never sent). */
  host?: string;
}

/** Attach `use` to `target` (non-enumerable). A frozen target is left as is. Returns `target`. */
export function describeStackUse<T extends object>(target: T, use: StackUse | StackUse[]): T {
  try {
    Object.defineProperty(target, STACK_DESCRIPTOR, {
      value: Array.isArray(use) ? use : [use],
      enumerable: false,
      configurable: true,
    });
  } catch {
    // A frozen object: nothing to describe.
  }
  return target;
}

/** The uses already on `target`, if any. */
export function readStackUses(target: unknown): StackUse[] {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return [];
  const uses = (target as Record<symbol, unknown>)[STACK_DESCRIPTOR];
  return Array.isArray(uses) ? (uses as StackUse[]) : [];
}

/**
 * Marks a `stores.lucid()` / `uploadSessions.lucid()` factory with its connection. Not the stack
 * symbol itself: an unselected store must not show up, so the provider describes only the
 * selected one, at boot, filling in the default connection.
 */
export const LUCID_STORE = Symbol.for('@adonis-agora/media:lucid-store');

/** Tag a Lucid store factory (see {@link LUCID_STORE}). */
export function markLucidStore<T extends object>(target: T, connection: string | undefined): T {
  try {
    Object.defineProperty(target, LUCID_STORE, {
      value: { connection },
      enumerable: false,
      configurable: true,
    });
  } catch {
    // frozen
  }
  return target;
}

function lucidStoreOf(factory: unknown): { connection?: string } | undefined {
  if (typeof factory !== 'function' && (typeof factory !== 'object' || factory === null)) {
    return undefined;
  }
  const marked = (factory as Record<symbol, unknown>)[LUCID_STORE];
  return marked !== null && typeof marked === 'object'
    ? (marked as { connection?: string })
    : undefined;
}

/**
 * The tech of an S3-compatible endpoint: `r2`, `gcs`, `minio`, or `s3` (AWS, or anything else
 * speaking the S3 API).
 */
export function s3EndpointTech(endpoint: string | undefined): string {
  const host = endpointHost(endpoint) ?? '';
  if (host.endsWith('.r2.cloudflarestorage.com')) return 'r2';
  if (host === 'storage.googleapis.com' || host.endsWith('.storage.googleapis.com')) return 'gcs';
  if (host.includes('minio')) return 'minio';
  return 's3';
}

/** The hostname of an endpoint URL, without credentials, port or path. */
export function endpointHost(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  try {
    return new URL(endpoint).hostname || undefined;
  } catch {
    return undefined;
  }
}

const SQL_TECH: Record<string, string> = {
  pg: 'postgres',
  postgres: 'postgres',
  postgresql: 'postgres',
  mysql: 'mysql',
  mysql2: 'mysql',
  'better-sqlite3': 'sqlite',
  sqlite3: 'sqlite',
  libsql: 'sqlite',
  mssql: 'mssql',
};

/** What the provider knows at boot that the config file does not say. */
export interface MediaStackContext {
  /** The disk media writes to when `config.disk` is unset (Drive's default). */
  defaultDisk?: string;
  /** `database.connection`: the Lucid connection a store without `connection` uses. */
  defaultDbConnection?: string;
  /** Lucid connection name → its `client` (`pg`, `mysql2`, …), to name the tech. */
  dbClients?: Record<string, string>;
  /** `redis.connection`: the Redis connection `consoleCommands` uses without one. */
  defaultRedisConnection?: string;
}

/**
 * Everything `config/media.ts` selects, as stack uses: the Drive disks media writes to (a disk
 * from `config.disks` describes itself on its factory), the selected Lucid stores and the Redis
 * connection of `consoleCommands`.
 */
export function mediaStackUses(config: MediaConfig, ctx: MediaStackContext = {}): StackUse[] {
  const uses: StackUse[] = [];
  const add = (use: StackUse) => {
    const same = uses.some(
      (u) =>
        u.tech === use.tech &&
        u.label === use.label &&
        u.connection === use.connection &&
        u.purpose === use.purpose,
    );
    if (!same) uses.push(use);
  };

  // A tenant uses no disk or table of its own: its media lives on the control plane.
  if (config.topology === 'tenant' && config.tenant) {
    const url = typeof config.tenant.url === 'string' ? config.tenant.url : undefined;
    const host = endpointHost(url);
    add({
      tech: 'control-plane',
      label: host ?? 'urn:agora:media',
      ...(host ? { host } : {}),
      purpose: 'media files',
    });
    return uses;
  }

  const disk = (name: string | undefined, purpose: string) => {
    if (!name || config.disks?.[name] !== undefined) return;
    add({ tech: 'drive', label: name, purpose });
  };
  disk(config.disk ?? ctx.defaultDisk, 'media files');
  for (const collection of config.collections ?? []) disk(collection.disk, 'media files');
  disk(config.uploads?.resumable?.routes?.disk, 'uploads');
  disk(config.uploads?.direct?.routes?.disk, 'uploads');

  const sql = (
    selected: { store?: string; stores?: Record<string, unknown> } | undefined,
    purpose: string,
  ) => {
    if (!selected?.store) return;
    const lucid = lucidStoreOf(selected.stores?.[selected.store]);
    if (!lucid) return;
    const connection = lucid.connection ?? ctx.defaultDbConnection;
    if (!connection) return;
    add({ tech: SQL_TECH[ctx.dbClients?.[connection] ?? ''] ?? 'sql', connection, purpose });
  };
  sql(config, 'media records');
  sql(config.uploads?.resumable, 'upload sessions');
  sql(config.uploads?.direct, 'upload sessions');

  if (config.consoleCommands) {
    const connection = config.consoleCommands.connection ?? ctx.defaultRedisConnection;
    if (connection) add({ tech: 'redis', connection, purpose: 'console commands' });
  }
  return uses;
}

/** Put {@link mediaStackUses} on the `media` config object itself, where telescope reads it. */
export function describeMediaConfig(config: MediaConfig, ctx: MediaStackContext = {}): void {
  const uses = mediaStackUses(config, ctx);
  if (uses.length > 0) describeStackUse(config, uses);
}
