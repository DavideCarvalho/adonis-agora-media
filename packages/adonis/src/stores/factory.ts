import type { ApplicationService } from '@adonisjs/core/types';
import { StoreNotConfiguredError } from '../errors.js';
import type { MediaStore } from '../media_store.js';

/**
 * Runtime context a {@link StoreFactory} thunk receives when the media provider builds the
 * configured store at boot. Carries the booted application so a driver can resolve a peer's
 * service (the Lucid `db`) if it needs to.
 */
export interface StoreContext {
  app: ApplicationService;
}

/**
 * A configured media store: a thunk the media provider calls at boot to build the {@link MediaStore}.
 * Each factory lazily imports its peer dependency (`@adonisjs/lucid`) inside the thunk, so the driver
 * is only loaded when it is actually selected — keeping that package optional.
 */
export type StoreFactory = (ctx: StoreContext) => Promise<MediaStore>;

/** Options for the Lucid-backed media store. */
export interface LucidStoreConfig {
  /** Lucid connection name to use. Defaults to the `Database` default connection. */
  connection?: string;
  /** Table name. Default `media`. */
  table?: string;
}

/**
 * The store factory namespace used in `config/media.ts`:
 *
 * ```ts
 * import { defineConfig, stores } from '@adonis-agora/media'
 *
 * export default defineConfig({
 *   store: 'lucid',
 *   stores: {
 *     memory: stores.memory(),
 *     lucid: stores.lucid({ connection: 'pg' }),
 *   },
 * })
 * ```
 *
 * Each factory returns a {@link StoreFactory} — a lazy thunk. Calling it in the config file costs
 * nothing; the peer dependency is only imported when the provider builds the selected store at boot.
 */
export const stores = {
  /** In-memory store — single-process, non-durable. Handy for tests and scratch apps. */
  memory(): StoreFactory {
    return async () => {
      const { InMemoryMediaStore } = await import('../testing/in_memory_media_store.js');
      return new InMemoryMediaStore();
    };
  },

  /** Persist media records in SQL via `@adonisjs/lucid`. */
  lucid(config: LucidStoreConfig = {}): StoreFactory {
    return async () => {
      const db = (await import('@adonisjs/lucid/services/db')).default;
      const { LucidMediaStore } = await import('./lucid.js');
      return new LucidMediaStore(db, {
        ...(config.connection !== undefined ? { connectionName: config.connection } : {}),
        ...(config.table !== undefined ? { table: config.table } : {}),
      });
    };
  },
};

/**
 * Build the media store selected by `config.store` from the `config.stores` map. When a store IS
 * named but has no matching factory (a typo or a missing `stores` entry), this THROWS a
 * {@link StoreNotConfiguredError} rather than silently falling back to the in-memory store — a
 * non-durable fallback would lose data on restart. Only the zero-config path (no `store` named at
 * all) resolves to the in-memory store.
 */
export async function resolveStore(
  config: { store?: string; stores?: Record<string, StoreFactory> },
  ctx: StoreContext,
): Promise<MediaStore> {
  const name = config.store;
  if (name) {
    const factory = config.stores?.[name];
    if (!factory) throw new StoreNotConfiguredError(name);
    return factory(ctx);
  }
  const { InMemoryMediaStore } = await import('../testing/in_memory_media_store.js');
  return new InMemoryMediaStore();
}
