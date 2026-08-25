import type { Database } from '@adonisjs/lucid/database';
import type { QueryClientContract } from '@adonisjs/lucid/types/database';

/**
 * The media schema for the Lucid store, as standalone functions.
 *
 * By default {@link LucidMediaStore} auto-creates the `media` table on first use
 * (`autoCreateSchema`, the ecosystem convention — a lib owns its own schema, same
 * as `@adonis-agora/authz`'s `createAuthzTables` and `@adonis-agora/durable`'s
 * `createDurableTables`). An app that prefers explicit control sets
 * `autoCreateSchema: false` and calls {@link createMediaTables} from a Lucid
 * migration instead. Both paths run the SAME DDL — the store's `ensureSchema`
 * delegates here — so they never drift.
 */

/** The bindings a Lucid `rawQuery` accepts (mirrors `RawQueryBindings`). */
export type LucidQueryBindings = readonly unknown[] | Record<string, unknown>;

/** The slice of a Lucid query client the schema functions rely on. */
export interface LucidQueryClient {
  rawQuery(sql: string, bindings?: LucidQueryBindings): Promise<unknown>;
}

/** A Lucid `Database` / connection / query client. */
export interface LucidDatabase extends LucidQueryClient {
  dialect?: { name?: string };
  connection?(name?: string): { dialect?: { name?: string } };
}

/** Table-name override (default matches the `media` table). */
export interface MediaTableNames {
  media?: string;
}

/** The default table names for the Lucid store's media schema. */
export const MEDIA_TABLES: Required<MediaTableNames> = {
  media: 'media',
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Reject any table name that is not a bare SQL identifier (these are interpolated, never bound). */
export function assertSafeIdentifier(id: string): string {
  if (!IDENT.test(id))
    throw new Error(`@adonis-agora/media: unsafe SQL identifier: ${JSON.stringify(id)}`);
  return id;
}

export function isPostgres(dialect: string | undefined): boolean {
  return !!dialect && /postgres|pg|redshift/i.test(dialect);
}

export function isMysql(dialect: string | undefined): boolean {
  return !!dialect && /mysql|mariadb/i.test(dialect);
}

/**
 * Best-effort dialect name from a Lucid client; `undefined` when it can't be read.
 */
export function detectDialect(db: LucidDatabase): string | undefined {
  try {
    const direct = db.dialect?.name;
    if (typeof direct === 'string' && direct.length > 0) return direct;
    return db.connection?.()?.dialect?.name;
  } catch {
    return undefined;
  }
}

/** Resolve the effective table name, validating the identifier. */
function resolveTables(options: { table?: string }): Required<MediaTableNames> {
  const t: Required<MediaTableNames> = { ...MEDIA_TABLES };
  if (options.table !== undefined) {
    assertSafeIdentifier(options.table);
    t.media = options.table;
  }
  return t;
}

/**
 * Create the `media` table (idempotent — `CREATE TABLE IF NOT EXISTS`). Safe to call
 * from a Lucid migration `up()` or repeatedly at boot.
 *
 * The shape mirrors the migration published by `node ace configure @adonis-agora/media`:
 * JSON payloads (`custom_properties`, `conversions`) are stored as TEXT — the store
 * (de)serializes them — and timestamps as epoch-ms integers, so the schema is portable
 * across SQLite / Postgres / MySQL.
 *
 * @param db a Lucid `Database` or connection client
 * @param options.table optional table-name override (defaults to {@link MEDIA_TABLES})
 */
export async function createMediaTables(
  db: LucidDatabase,
  options: { table?: string } = {},
): Promise<void> {
  const t = resolveTables(options);
  const run = (sql: string) => db.rawQuery(sql);

  await run(
    `CREATE TABLE IF NOT EXISTS ${t.media} (
      id VARCHAR(255) PRIMARY KEY,
      owner_type VARCHAR(255) NOT NULL,
      owner_id VARCHAR(255) NOT NULL,
      collection VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      file_name VARCHAR(255) NOT NULL,
      mime_type VARCHAR(255) NOT NULL,
      size BIGINT NOT NULL,
      disk VARCHAR(255) NOT NULL,
      path TEXT NOT NULL,
      "order" INTEGER NOT NULL DEFAULT 0,
      custom_properties TEXT,
      conversions TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
  );
  await run(
    `CREATE INDEX IF NOT EXISTS ${t.media}_owner_idx ON ${t.media} (owner_type, owner_id)`,
  );
  await run(
    `CREATE INDEX IF NOT EXISTS ${t.media}_owner_collection_idx ON ${t.media} (owner_type, owner_id, collection)`,
  );
}

/**
 * Drop the `media` table (idempotent — `DROP TABLE IF EXISTS`). For a migration `down()`.
 *
 * @param db a Lucid `Database` or connection client
 * @param options.table optional table-name override (defaults to {@link MEDIA_TABLES})
 */
export async function dropMediaTables(
  db: LucidDatabase,
  options: { table?: string } = {},
): Promise<void> {
  const t = resolveTables(options);
  await db.rawQuery(`DROP TABLE IF EXISTS ${t.media}`);
}
