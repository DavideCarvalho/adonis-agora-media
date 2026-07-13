import type { ApplicationService } from '@adonisjs/core/types';
import { UploadSessionStoreNotConfiguredError } from '../errors.js';
import type { UploadSessionStore } from '../resumable_upload.js';

/**
 * Runtime context an {@link UploadSessionStoreFactory} thunk receives when the media provider builds
 * the configured session store at boot. Carries the booted application so a driver can resolve a
 * peer's service (the Lucid `db`).
 */
export interface UploadSessionStoreContext {
  app: ApplicationService;
}

/**
 * A configured resumable session store: a lazy thunk the media provider calls at boot to build the
 * {@link UploadSessionStore}. Each factory imports its peer (`@adonisjs/lucid`) inside the thunk, so
 * the driver only loads when actually selected — keeping that package optional.
 */
export type UploadSessionStoreFactory = (
  ctx: UploadSessionStoreContext,
) => Promise<UploadSessionStore>;

/** Options for the Lucid-backed resumable session store. */
export interface LucidUploadSessionStoreConfig {
  /** Lucid connection name to use. Defaults to the `Database` default connection. */
  connection?: string;
  /** Sessions table name. Default `media_upload_sessions`. */
  table?: string;
  /** Parts side-index table name. Default `media_upload_parts`. */
  partsTable?: string;
}

/**
 * The resumable session-store factory namespace used in `config/media.ts` (mirrors {@link stores}):
 *
 * ```ts
 * import { defineConfig, uploadSessions } from '@adonis-agora/media'
 *
 * export default defineConfig({
 *   uploads: {
 *     resumable: {
 *       store: 'lucid',
 *       stores: {
 *         memory: uploadSessions.memory(),
 *         lucid: uploadSessions.lucid({ connection: 'pg' }),
 *       },
 *       routes: { enabled: true },
 *     },
 *   },
 * })
 * ```
 */
export const uploadSessions = {
  /** In-memory session store — single-process, non-durable. Handy for tests and scratch apps. */
  memory(): UploadSessionStoreFactory {
    return async () => {
      const { InMemoryUploadSessionStore } = await import(
        '../testing/in_memory_upload_session_store.js'
      );
      return new InMemoryUploadSessionStore();
    };
  },

  /** Persist resumable sessions in SQL via `@adonisjs/lucid`. */
  lucid(config: LucidUploadSessionStoreConfig = {}): UploadSessionStoreFactory {
    return async () => {
      const db = (await import('@adonisjs/lucid/services/db')).default;
      const { LucidUploadSessionStore } = await import('./lucid.js');
      return new LucidUploadSessionStore(db, {
        ...(config.connection !== undefined ? { connectionName: config.connection } : {}),
        ...(config.table !== undefined ? { table: config.table } : {}),
        ...(config.partsTable !== undefined ? { partsTable: config.partsTable } : {}),
      });
    };
  },
};

/**
 * Build the resumable session store selected by `config.store` from the `config.stores` map. A named
 * store with no matching factory THROWS {@link UploadSessionStoreNotConfiguredError} (a non-durable
 * fallback would silently lose resumable state); only the zero-config path (no `store` named)
 * resolves to the in-memory store.
 */
export async function resolveUploadSessionStore(
  config: { store?: string; stores?: Record<string, UploadSessionStoreFactory> },
  ctx: UploadSessionStoreContext,
): Promise<UploadSessionStore> {
  const name = config.store;
  if (name) {
    const factory = config.stores?.[name];
    if (!factory) throw new UploadSessionStoreNotConfiguredError(name);
    return factory(ctx);
  }
  const { InMemoryUploadSessionStore } = await import(
    '../testing/in_memory_upload_session_store.js'
  );
  return new InMemoryUploadSessionStore();
}
