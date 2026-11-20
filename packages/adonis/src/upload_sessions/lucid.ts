import type { Database } from '@adonisjs/lucid/database';
import type { QueryClientContract } from '@adonisjs/lucid/types/database';
import type {
  UploadSession,
  UploadSessionListFilter,
  UploadSessionStore,
} from '../resumable_upload.js';
import {
  assertSafeIdentifier,
  assertSchema,
  detectDialect,
  inspectSchemaTables,
  type LucidDatabase,
  type MediaSchemaInspection,
  qualifiedTable,
} from '../stores/lucid-schema.js';
import type { MultipartPart } from '../types.js';

export interface LucidUploadSessionStoreOptions {
  /** Lucid connection name. Defaults to the `Database` default connection. */
  connectionName?: string;
  /** Sessions table name. Default `media_upload_sessions`. */
  table?: string;
  /** Parts side-index table name. Default `media_upload_parts`. */
  partsTable?: string;
  /**
   * Database schema both tables live in (a Postgres schema, a MySQL database). Every query names
   * it. Not supported on SQLite (the constructor throws). Default: the connection's current schema.
   */
  schema?: string;
  /**
   * Read and write the sessions' `tenant_id` column (media's `tenancy` is on). Off by default: the
   * column is then never touched.
   */
  tenantColumn?: boolean;
}

/**
 * Physical row shape of the `media_upload_sessions` table. Timestamps are epoch-ms integers.
 * `updated_at` is nullable and may be missing from tables created before it existed.
 */
interface SessionRow {
  id: string;
  disk: string;
  key: string;
  content_type: string | null;
  size: number | null;
  offset: number;
  parts: number;
  multipart_upload_id: string | null;
  metadata: string | null;
  created_at: number;
  updated_at?: number | null;
  expires_at: number | null;
  tenant_id?: string | null;
}

/** Physical row shape of the `media_upload_parts` side-index table. */
interface PartRow {
  session_id: string;
  part_number: number;
  etag: string;
}

/**
 * Lucid-backed {@link UploadSessionStore}. Persists resumable upload sessions in
 * `media_upload_sessions` and, for multipart-capable disks, the per-part ETags in
 * `media_upload_parts`, via `@adonisjs/lucid`'s query builder (Knex) — so it works across
 * SQLite / Postgres / MySQL. JSON `metadata` is stored as TEXT and timestamps as epoch-ms integers,
 * keeping the schema portable, exactly like {@link LucidMediaStore}. Publish the migration with
 * `node ace configure @adonis-agora/media`.
 */
/** How long a "no `updated_at` column" answer is trusted before probing again. */
const UPDATED_AT_REPROBE_MS = 60_000;

export class LucidUploadSessionStore implements UploadSessionStore {
  private readonly table: string;
  private readonly partsTable: string;
  /** The configured database schema, or `undefined` for the connection's current one. */
  readonly schema: string | undefined;
  /** The unqualified sessions and parts table names. */
  private readonly tableNames: [string, string];
  private readonly connectionName: string | undefined;
  private readonly tenantColumn: boolean;
  /** The last `updated_at` probe and when it ran (see {@link hasUpdatedAtColumn}). */
  #updatedAtProbe: { found: Promise<boolean>; at: number; missing: boolean } | undefined;

  constructor(
    private readonly db: Database,
    options: LucidUploadSessionStoreOptions = {},
  ) {
    this.connectionName = options.connectionName;
    this.tenantColumn = options.tenantColumn === true;
    this.schema =
      options.schema === undefined
        ? undefined
        : assertSchema(options.schema, this.dialect(), 'uploadSessions.lucid()');
    // Both names as the query builder takes them: `schema.table` when a schema is set.
    this.tableNames = [
      options.table ?? 'media_upload_sessions',
      options.partsTable ?? 'media_upload_parts',
    ];
    // With a schema the tables must be bare names: `a.b` would make a three-part reference.
    if (this.schema !== undefined) for (const name of this.tableNames) assertSafeIdentifier(name);
    this.table = qualifiedTable(this.tableNames[0], this.schema);
    this.partsTable = qualifiedTable(this.tableNames[1], this.schema);
  }

  /**
   * Where the configured {@link schema} stands, for `agora:doctor`: whether it exists, whether both
   * tables are in it, and whether this connection may write there. `null` without a schema.
   */
  async inspectSchema(): Promise<MediaSchemaInspection | null> {
    if (this.schema === undefined) return null;
    return inspectSchemaTables(this.client(), this.schema, this.tableNames);
  }

  /** The connection's dialect name, when it can be read without a query. */
  private dialect(): string | undefined {
    try {
      return detectDialect(this.client() as unknown as LucidDatabase);
    } catch {
      return undefined;
    }
  }

  private client(): QueryClientContract {
    return this.connectionName ? this.db.connection(this.connectionName) : this.db.connection();
  }

  /**
   * Whether the sessions table has its `updated_at` column (a zero-row probe). Tables created before
   * the column existed keep working without it: the store then neither writes nor reads
   * `updatedAt`. Add it with `node ace media:publish-migration timestamps`. A found column is
   * remembered; a missing one (or table) is probed again at most once a minute, so a migration run
   * under a live process is picked up.
   */
  hasUpdatedAtColumn(): Promise<boolean> {
    const now = Date.now();
    const last = this.#updatedAtProbe;
    if (last === undefined || (last.missing && now - last.at >= UPDATED_AT_REPROBE_MS)) {
      const probe = { found: this.#probeUpdatedAt(), at: now, missing: false };
      probe.found = probe.found.then((found) => {
        probe.missing = !found;
        return found;
      });
      this.#updatedAtProbe = probe;
    }
    return (this.#updatedAtProbe as { found: Promise<boolean> }).found;
  }

  async #probeUpdatedAt(): Promise<boolean> {
    try {
      await this.client().from(this.table).select('updated_at').whereRaw('1 = 0');
      return true;
    } catch {
      return false;
    }
  }

  async create(session: UploadSession): Promise<UploadSession> {
    const createdAt = session.createdAt ?? new Date();
    const { updatedAt: _updatedAt, ...rest } = session;
    const stored: UploadSession = { ...rest, createdAt };
    // Only what get/list can read back: no `updatedAt` on a table without the column.
    if (await this.hasUpdatedAtColumn()) stored.updatedAt = session.updatedAt ?? createdAt;
    await this.#upsert(stored, false);
    return { ...stored };
  }

  async get(id: string): Promise<UploadSession | null> {
    const row = (await this.client().from(this.table).where('id', id).first()) as SessionRow | null;
    return row ? fromRow(row) : null;
  }

  async update(session: UploadSession): Promise<UploadSession> {
    const { updatedAt: _updatedAt, ...rest } = session;
    const stored: UploadSession = rest;
    if (await this.hasUpdatedAtColumn()) stored.updatedAt = new Date();
    await this.#upsert(stored, true);
    // `created_at` never moves; a caller's copy without it gets the stored one back.
    if (stored.createdAt === undefined) {
      const row = (await this.client()
        .from(this.table)
        .where('id', session.id)
        .select('created_at')
        .first()) as Pick<SessionRow, 'created_at'> | null;
      if (row) stored.createdAt = new Date(Number(row.created_at));
    }
    return { ...stored };
  }

  /**
   * Insert or overwrite one session row. With `keepCreated`, an existing row keeps its `created_at`
   * (an update never moves it).
   */
  async #upsert(session: UploadSession, keepCreated: boolean): Promise<void> {
    const row = toRow(session, this.tenantColumn, await this.hasUpdatedAtColumn());
    const { created_at: _createdAt, ...changed } = row;
    await this.client()
      .table(this.table)
      .insert(row)
      .onConflict('id')
      .merge(keepCreated ? changed : row);
  }

  async delete(id: string): Promise<void> {
    await this.client().from(this.table).where('id', id).delete();
    await this.client().from(this.partsTable).where('session_id', id).delete();
  }

  async addPart(id: string, part: MultipartPart): Promise<void> {
    // Upsert by (session_id, part_number) so a retried part overwrites rather than duplicates.
    await this.client()
      .table(this.partsTable)
      .insert({ session_id: id, part_number: part.partNumber, etag: part.etag })
      .onConflict(['session_id', 'part_number'])
      .merge();
  }

  async listParts(id: string): Promise<MultipartPart[]> {
    const rows = (await this.client()
      .from(this.partsTable)
      .where('session_id', id)
      .orderBy('part_number', 'asc')) as PartRow[];
    return rows.map((r) => ({ partNumber: Number(r.part_number), etag: r.etag }));
  }

  async list(filter: UploadSessionListFilter = {}): Promise<UploadSession[]> {
    let q = this.client().from(this.table);
    if (filter.disk !== undefined) q = q.where('disk', filter.disk);
    if (filter.keyPrefix !== undefined) q = q.where('key', 'like', `${filter.keyPrefix}%`);
    if (this.tenantColumn && filter.tenantIds !== undefined) {
      const ids = filter.tenantIds.filter((id): id is string => id !== null);
      const withNull = filter.tenantIds.includes(null);
      q = q.where((builder) => {
        if (ids.length === 0 && !withNull) builder.whereRaw('1 = 0');
        if (ids.length > 0) builder.whereIn('tenant_id', ids);
        if (withNull) builder.orWhereNull('tenant_id');
      });
    }
    const rows = (await q.orderBy('created_at', 'asc')) as SessionRow[];
    return rows.map(fromRow);
  }
}

function toRow(session: UploadSession, tenantColumn: boolean, updatedAt: boolean): SessionRow {
  return {
    ...(tenantColumn ? { tenant_id: session.tenantId ?? null } : {}),
    ...(updatedAt ? { updated_at: (session.updatedAt ?? new Date()).getTime() } : {}),
    id: session.id,
    disk: session.disk,
    key: session.key,
    content_type: session.contentType ?? null,
    size: session.size ?? null,
    offset: session.offset,
    parts: session.parts,
    multipart_upload_id: session.multipartUploadId ?? null,
    metadata: session.metadata ? JSON.stringify(session.metadata) : null,
    created_at: (session.createdAt ?? new Date()).getTime(),
    expires_at: session.expiresAt ? session.expiresAt.getTime() : null,
  };
}

function fromRow(row: SessionRow): UploadSession {
  const session: UploadSession = {
    id: row.id,
    disk: row.disk,
    key: row.key,
    contentType: row.content_type ?? undefined,
    size: row.size === null ? undefined : Number(row.size),
    offset: Number(row.offset),
    parts: Number(row.parts),
    createdAt: new Date(Number(row.created_at)),
  };
  if (row.tenant_id !== undefined) session.tenantId = row.tenant_id;
  if (row.multipart_upload_id) session.multipartUploadId = row.multipart_upload_id;
  if (row.updated_at !== undefined && row.updated_at !== null) {
    session.updatedAt = new Date(Number(row.updated_at));
  }
  if (row.expires_at !== null) session.expiresAt = new Date(Number(row.expires_at));
  if (row.metadata) {
    try {
      session.metadata = JSON.parse(row.metadata) as Record<string, string>;
    } catch {
      // ignore malformed metadata
    }
  }
  return session;
}
