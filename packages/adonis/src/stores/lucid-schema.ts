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

/** Options the schema functions take. */
export interface MediaSchemaOptions {
  /** Table-name override (defaults to {@link MEDIA_TABLES}). */
  table?: string;
  /**
   * Database schema the table lives in (a Postgres schema, a MySQL database). Every statement
   * names it. Default: the connection's current schema.
   */
  schema?: string;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCHEMA_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_SCHEMA_LENGTH = 63;

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

/** Whether `dialect` has no schemas to put a table in (SQLite and its drivers). */
function isSchemaless(dialect: string | undefined): boolean {
  return !!dialect && /sqlite|libsql/i.test(dialect);
}

/**
 * Validate a `schema` option: `undefined` passes through; anything else must be a plain identifier
 * (letters, digits, `_`, `$`, at most 63 characters) on a dialect that has schemas. SQLite fails.
 */
export function assertSchema(
  schema: string | undefined,
  dialect: string | undefined,
  where: string,
): string | undefined {
  if (schema === undefined) return undefined;
  if (
    typeof schema !== 'string' ||
    !SCHEMA_IDENT.test(schema) ||
    schema.length > MAX_SCHEMA_LENGTH
  ) {
    throw new Error(
      `@adonis-agora/media: ${where} \`schema\` must be a plain identifier (letters, digits, _ and $, not starting with a digit, at most ${MAX_SCHEMA_LENGTH} characters); got ${JSON.stringify(schema)}.`,
    );
  }
  if (isSchemaless(dialect)) {
    throw new Error(
      `@adonis-agora/media: ${where} sets \`schema: "${schema}"\`, but the connection is ${dialect}, which has no schemas. Remove \`schema\` or use a Postgres or MySQL connection.`,
    );
  }
  return schema;
}

/**
 * A table name for Lucid's query builder: `schema.table` (knex quotes the two parts separately,
 * `"schema"."table"`), or the bare table without a schema.
 */
export function qualifiedTable(table: string, schema: string | undefined): string {
  return schema === undefined ? table : `${schema}.${table}`;
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

/** Identifier quoting and table references for raw SQL on one dialect, in one schema. */
interface Sql {
  /** Quote one identifier. */
  q(identifier: string): string;
  /** A table for raw SQL: `"schema"."table"` or `"table"`. */
  table(name: string): string;
  mysql: boolean;
}

function sqlFor(db: LucidDatabase, schema: string | undefined, where: string): Sql {
  const dialect = detectDialect(db);
  const valid = assertSchema(schema, dialect, where);
  const mysql = isMysql(dialect);
  const q = (identifier: string) => (mysql ? `\`${identifier}\`` : `"${identifier}"`);
  return {
    q,
    table: (name) => (valid === undefined ? q(name) : `${q(valid)}.${q(name)}`),
    mysql,
  };
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

/** Whether `error` is "this index already exists" (MySQL has no `CREATE INDEX IF NOT EXISTS`). */
function isDuplicateIndex(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
  return (
    code === 'ER_DUP_KEYNAME' ||
    code === '42P07' ||
    errno === 1061 ||
    /already exists|duplicate/i.test(String((error as Error)?.message ?? error))
  );
}

/** Whether `error` is a missing privilege (Postgres 42501, MySQL 1044 / 1142 / 1227). */
function isPermissionDenied(error: unknown): boolean {
  const { code, errno } = (error ?? {}) as { code?: unknown; errno?: unknown };
  return (
    code === '42501' ||
    code === 'ER_DBACCESS_DENIED_ERROR' ||
    code === 'ER_TABLEACCESS_DENIED_ERROR' ||
    code === 'ER_SPECIFIC_ACCESS_DENIED_ERROR' ||
    errno === 1044 ||
    errno === 1142 ||
    errno === 1227
  );
}

/** The rows of a Lucid `rawQuery` result, whatever the driver returned. */
export function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    // mysql2 resolves `[rows, fields]`; sqlite resolves the rows themselves.
    return (Array.isArray(result[0]) ? result[0] : result) as Record<string, unknown>[];
  }
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

/** Whether `schema` exists, read from `information_schema` (Postgres and MySQL). */
export async function mediaSchemaExists(db: LucidQueryClient, schema: string): Promise<boolean> {
  const rows = rowsOf(
    await db.rawQuery('SELECT 1 AS found FROM information_schema.schemata WHERE schema_name = ?', [
      schema,
    ]),
  );
  return rows.length > 0;
}

/** What {@link inspectSchemaTables} reports for `agora:doctor`. */
export interface MediaSchemaInspection {
  schema: string;
  /** Whether the schema exists (and this connection can see it). */
  exists: boolean;
  /** The tables not found in the schema. */
  missingTables: string[];
  /** Why a no-op write failed, or `null` when it went through. */
  writeError: string | null;
}

/**
 * Whether `schema` exists, which of `tables` are missing from it, and whether this connection may
 * write to each one present (a no-op `INSERT … SELECT … WHERE 1 = 0` and `DELETE … WHERE 1 = 0`, which
 * change nothing but need the privileges).
 */
export async function inspectSchemaTables(
  db: LucidQueryClient,
  schema: string,
  tables: readonly string[],
): Promise<MediaSchemaInspection> {
  if (!(await mediaSchemaExists(db, schema))) {
    return { schema, exists: false, missingTables: [], writeError: null };
  }
  const found = rowsOf(
    await db.rawQuery(
      `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? AND table_name IN (${tables.map(() => '?').join(', ')})`,
      [schema, ...tables],
    ),
  ).map((row) => String(row.name ?? row.NAME ?? row.TABLE_NAME));
  const missingTables = tables.filter((table) => !found.includes(table));
  let writeError: string | null = null;
  for (const table of tables) {
    if (missingTables.includes(table)) continue;
    const qualified = qualifiedTable(table, schema);
    try {
      await db.rawQuery('INSERT INTO ?? SELECT * FROM ?? WHERE 1 = 0', [qualified, qualified]);
      await db.rawQuery('DELETE FROM ?? WHERE 1 = 0', [qualified]);
    } catch (error) {
      writeError = `${table}: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
  }
  return { schema, exists: true, missingTables, writeError };
}

/**
 * Create `schema` when it is missing: `CREATE SCHEMA IF NOT EXISTS` (Postgres) or
 * `CREATE DATABASE IF NOT EXISTS` (MySQL). The catalog is read first, so a role that may use an
 * existing schema but not create one is fine. When the role cannot create it, the error names the
 * schema and the grant it needs.
 */
async function ensureDatabaseSchema(db: LucidDatabase, schema: string, sql: Sql): Promise<void> {
  if (await mediaSchemaExists(db, schema)) return;
  try {
    await db.rawQuery(
      `${sql.mysql ? 'CREATE DATABASE' : 'CREATE SCHEMA'} IF NOT EXISTS ${sql.q(schema)}`,
    );
  } catch (error) {
    if (!isPermissionDenied(error)) throw error;
    const grant = sql.mysql
      ? `GRANT ALL ON \`${schema}\`.* TO <app user>`
      : `GRANT CREATE ON DATABASE <database> TO <app role> (or create it once: CREATE SCHEMA "${schema}" AUTHORIZATION <app role>)`;
    throw new Error(
      `@adonis-agora/media: cannot create the ${sql.mysql ? 'database' : 'schema'} "${schema}": the connection's role is not allowed to. Create it beforehand or grant the role: ${grant}.`,
      { cause: error },
    );
  }
}

/** `CREATE INDEX` that is a no-op when the index exists, on every dialect. */
async function createIndex(
  db: LucidDatabase,
  sql: Sql,
  name: string,
  table: string,
  columns: string[],
): Promise<void> {
  const statement = `CREATE INDEX ${sql.mysql ? '' : 'IF NOT EXISTS '}${sql.q(name)} ON ${sql.table(table)} (${columns.map(sql.q).join(', ')})`;
  try {
    await db.rawQuery(statement);
  } catch (error) {
    // MySQL reports an existing index; Postgres may lose a concurrent `IF NOT EXISTS` race.
    if (!isDuplicateIndex(error)) throw error;
  }
}

/**
 * Create the `media` table (idempotent — `CREATE TABLE IF NOT EXISTS`). Safe to call
 * from a Lucid migration `up()` or repeatedly at boot.
 *
 * The shape mirrors the migration published by `node ace configure @adonis-agora/media`:
 * JSON payloads (`custom_properties`, `conversions`) are stored as TEXT — the store
 * (de)serializes them — and timestamps as epoch-ms integers, so the schema is portable
 * across SQLite / Postgres / MySQL. With `options.schema`, the schema is created when missing
 * and the table lives in it.
 *
 * @param db a Lucid `Database` or connection client
 * @param options.table optional table-name override (defaults to {@link MEDIA_TABLES})
 * @param options.schema optional database schema (a MySQL database)
 */
export async function createMediaTables(
  db: LucidDatabase,
  options: MediaSchemaOptions = {},
): Promise<void> {
  const t = resolveTables(options);
  const sql = sqlFor(db, options.schema, 'createMediaTables()');
  const { q } = sql;
  if (options.schema !== undefined) await ensureDatabaseSchema(db, options.schema, sql);

  await db.rawQuery(
    `CREATE TABLE IF NOT EXISTS ${sql.table(t.media)} (
      ${q('id')} VARCHAR(255) PRIMARY KEY,
      ${q('owner_type')} VARCHAR(255) NOT NULL,
      ${q('owner_id')} VARCHAR(255) NOT NULL,
      ${q('collection')} VARCHAR(255) NOT NULL,
      ${q('name')} VARCHAR(255) NOT NULL,
      ${q('file_name')} VARCHAR(255) NOT NULL,
      ${q('mime_type')} VARCHAR(255) NOT NULL,
      ${q('size')} BIGINT NOT NULL,
      ${q('disk')} VARCHAR(255) NOT NULL,
      ${q('path')} TEXT NOT NULL,
      ${q('order')} INTEGER NOT NULL DEFAULT 0,
      ${q('custom_properties')} TEXT,
      ${q('conversions')} TEXT,
      ${q('created_at')} BIGINT NOT NULL,
      ${q('updated_at')} BIGINT NOT NULL
    )`,
  );
  // `(owner_type, owner_id)` lookups use the leftmost prefix of the owner+collection index.
  // Index names are never schema-qualified: they live in their table's schema.
  await createIndex(db, sql, `${t.media}_owner_collection_idx`, t.media, [
    'owner_type',
    'owner_id',
    'collection',
  ]);
  // The newest-first keyset `list()` pages on, unfiltered and per collection.
  await createIndex(db, sql, `${t.media}_created_idx`, t.media, ['created_at', 'id']);
  await createIndex(db, sql, `${t.media}_collection_created_idx`, t.media, [
    'collection',
    'created_at',
    'id',
  ]);
}

/**
 * Drop the `media` table (idempotent — `DROP TABLE IF EXISTS`). For a migration `down()`.
 *
 * @param db a Lucid `Database` or connection client
 * @param options.table optional table-name override (defaults to {@link MEDIA_TABLES})
 * @param options.schema optional database schema (a MySQL database)
 */
export async function dropMediaTables(
  db: LucidDatabase,
  options: MediaSchemaOptions = {},
): Promise<void> {
  const t = resolveTables(options);
  const sql = sqlFor(db, options.schema, 'dropMediaTables()');
  await db.rawQuery(`DROP TABLE IF EXISTS ${sql.table(t.media)}`);
}

/**
 * Whether the `media` table has the `tenant_id` column tenancy needs (a zero-row probe query).
 *
 * @param db a Lucid `Database` or connection client
 * @param options.table optional table-name override (defaults to {@link MEDIA_TABLES})
 * @param options.schema optional database schema (a MySQL database)
 */
export async function hasMediaTenantColumn(
  db: LucidDatabase,
  options: MediaSchemaOptions = {},
): Promise<boolean> {
  const t = resolveTables(options);
  const sql = sqlFor(db, options.schema, 'hasMediaTenantColumn()');
  try {
    await db.rawQuery(`SELECT ${sql.q('tenant_id')} FROM ${sql.table(t.media)} WHERE 1 = 0`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Add the nullable `tenant_id` column and its `(tenant_id, owner_type, owner_id, collection)` index
 * to the `media` table when missing (idempotent). Tenancy (organizations as tenants) stamps new
 * files with it; existing rows stay `NULL`. Same DDL as the migration
 * `node ace media:publish-migration tenancy` publishes.
 *
 * @param db a Lucid `Database` or connection client
 * @param options.table optional table-name override (defaults to {@link MEDIA_TABLES})
 * @param options.schema optional database schema (a MySQL database)
 */
export async function ensureMediaTenantColumn(
  db: LucidDatabase,
  options: MediaSchemaOptions = {},
): Promise<void> {
  const t = resolveTables(options);
  const sql = sqlFor(db, options.schema, 'ensureMediaTenantColumn()');
  if (!(await hasMediaTenantColumn(db, options))) {
    await db.rawQuery(
      `ALTER TABLE ${sql.table(t.media)} ADD COLUMN ${sql.q('tenant_id')} VARCHAR(255) NULL`,
    );
  }
  await createIndex(db, sql, `${t.media}_tenant_owner_idx`, t.media, [
    'tenant_id',
    'owner_type',
    'owner_id',
    'collection',
  ]);
}
