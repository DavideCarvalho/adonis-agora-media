import type { Database } from '@adonisjs/lucid/database';
import type { QueryClientContract } from '@adonisjs/lucid/types/database';
import type { MediaConversion, MediaRecord } from '../media_record.js';
import {
  clampMediaListLimit,
  decodeMediaCursor,
  encodeMediaCursor,
  type MediaCollectionTotals,
  type MediaListOptions,
  type MediaListPage,
  type MediaOwnerPageOptions,
  type MediaStore,
  type MediaTotalsOptions,
} from '../media_store.js';
import {
  createMediaTables,
  ensureMediaTenantColumn,
  hasMediaTenantColumn,
} from './lucid-schema.js';

export interface LucidMediaStoreOptions {
  /** The Lucid connection name. Defaults to the `Database` default connection. */
  connectionName?: string;
  /** Table name. Default `media`. */
  table?: string;
  /**
   * Auto-create the `media` table on first use (default `true`). Set to `false` to
   * manage the schema explicitly via a migration calling {@link createMediaTables}.
   */
  autoCreateSchema?: boolean;
  /**
   * Read and write the `tenant_id` column (media's `tenancy` is on). Off by default: the column is
   * then never touched, so a table without it keeps working. With `autoCreateSchema` the column is
   * added when missing; without it, a missing column fails the first query with
   * {@link MediaTenancySchemaError} (run `node ace media:publish-migration tenancy`).
   */
  tenantColumn?: boolean;
}

/** Thrown when tenancy is on and the `media` table has no `tenant_id` column. */
export class MediaTenancySchemaError extends Error {
  readonly code = 'E_MEDIA_TENANCY_SCHEMA';
  constructor(table: string) {
    super(
      `@adonis-agora/media: tenancy is on but the "${table}" table has no tenant_id column. Run \`node ace media:publish-migration tenancy\` and \`node ace migration:run\`, or set \`tenancy: false\` in config/media.ts.`,
    );
    this.name = 'MediaTenancySchemaError';
  }
}

/** Physical row shape of the `media` table. JSON columns are stored as text. */
interface MediaRow {
  id: string;
  owner_type: string;
  owner_id: string;
  collection: string;
  name: string;
  file_name: string;
  mime_type: string;
  size: number;
  disk: string;
  path: string;
  order: number;
  custom_properties: string | null;
  conversions: string | null;
  created_at: number;
  updated_at: number;
  tenant_id?: string | null;
}

/**
 * Lucid-backed {@link MediaStore}. Persists media records in a `media` table via `@adonisjs/lucid`'s
 * query builder (Knex), so it works across SQLite / Postgres / MySQL. JSON payloads
 * (`custom_properties`, `conversions`) are stored as TEXT and timestamps as epoch-ms integers, so the
 * schema is portable across engines.
 *
 * The `media` table is auto-created on first use (`autoCreateSchema`, default `true`) — the
 * ecosystem convention, same as `@adonis-agora/authz` and `@adonis-agora/durable`. An app that
 * prefers explicit control sets `autoCreateSchema: false` and publishes the migration via
 * `node ace configure @adonis-agora/media` (or calls {@link createMediaTables} from a migration).
 */
export class LucidMediaStore implements MediaStore {
  readonly tenantFiltering = true;
  private readonly table: string;
  private readonly connectionName: string | undefined;
  private readonly autoCreate: boolean;
  private readonly tenantColumn: boolean;
  private schemaReady: Promise<void> | undefined;

  constructor(
    private readonly db: Database,
    options: LucidMediaStoreOptions = {},
  ) {
    this.table = options.table ?? 'media';
    this.connectionName = options.connectionName;
    this.autoCreate = options.autoCreateSchema !== false;
    this.tenantColumn = options.tenantColumn === true;
  }

  private client(): QueryClientContract {
    return this.connectionName ? this.db.connection(this.connectionName) : this.db.connection();
  }

  private query() {
    return this.client().from(this.table);
  }

  /** Ensure the schema exists before the first operation, once per store instance. */
  private async ready(): Promise<void> {
    if (!this.autoCreate && !this.tenantColumn) return;
    if (!this.schemaReady) {
      this.schemaReady = (this.autoCreate ? this.ensureSchema() : this.assertTenantColumn()).catch(
        (error) => {
          // Not cached: a migration run later in the same process is picked up on the next call.
          this.schemaReady = undefined;
          throw error;
        },
      );
    }
    return this.schemaReady;
  }

  private async assertTenantColumn(): Promise<void> {
    if (!(await hasMediaTenantColumn(this.client(), { table: this.table }))) {
      throw new MediaTenancySchemaError(this.table);
    }
  }

  /**
   * Create the `media` table (idempotent). Delegates to the standalone {@link createMediaTables}
   * so the auto-create path and a migration-based one run identical DDL.
   */
  async ensureSchema(): Promise<void> {
    await createMediaTables(this.db, { table: this.table });
    if (this.tenantColumn) await ensureMediaTenantColumn(this.db, { table: this.table });
  }

  async save(record: MediaRecord): Promise<MediaRecord> {
    await this.ready();
    const row = toRow(record, this.tenantColumn);
    // Single atomic upsert (portable Knex `INSERT ... ON CONFLICT (id) DO UPDATE`) instead of a
    // racy read-then-branch: concurrent saves of the same id can't interleave into a lost write.
    await this.client().table(this.table).insert(row).onConflict('id').merge();
    return { ...record };
  }

  async find(id: string): Promise<MediaRecord | null> {
    await this.ready();
    const row = (await this.query().where('id', id).first()) as MediaRow | null;
    return row ? fromRow(row) : null;
  }

  async listByOwner(
    ownerType: string,
    ownerId: string,
    collection?: string,
  ): Promise<MediaRecord[]> {
    await this.ready();
    let q = this.query().where('owner_type', ownerType).where('owner_id', ownerId);
    if (collection !== undefined) q = q.where('collection', collection);
    const rows = (await q.orderBy('order', 'asc')) as MediaRow[];
    return rows.map(fromRow);
  }

  async listByOwnerPaged(
    ownerType: string,
    ownerId: string,
    options: MediaOwnerPageOptions = {},
  ): Promise<MediaListPage> {
    if (options.collections !== undefined && options.collections.length === 0) {
      return { items: [], nextCursor: null };
    }
    return this.list({
      ownerType,
      ownerId,
      ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.tenantIds !== undefined ? { tenantIds: options.tenantIds } : {}),
      ...(options.collections !== undefined ? { collectionIn: options.collections } : {}),
    });
  }

  async list(
    options: MediaListOptions & { collectionIn?: readonly string[] } = {},
  ): Promise<MediaListPage> {
    await this.ready();
    const limit = clampMediaListLimit(options.limit);
    let q = this.query();
    if (options.collectionIn !== undefined) q = q.whereIn('collection', [...options.collectionIn]);
    if (options.ownerType !== undefined) q = q.where('owner_type', options.ownerType);
    if (options.ownerId !== undefined) q = q.where('owner_id', options.ownerId);
    if (options.collection !== undefined) q = q.where('collection', options.collection);
    if (options.prefix !== undefined && options.prefix !== '') {
      q = q.where('path', 'like', `${options.prefix}%`);
    }
    if (this.tenantColumn && options.tenantIds !== undefined) {
      q = whereTenantIn(q, options.tenantIds);
    }

    // Keyset pagination on the (created_at desc, id desc) ordering: resume strictly *after* the cursor
    // row, so pages don't drift or duplicate when rows are inserted concurrently.
    const cursor = decodeMediaCursor(options.cursor);
    if (cursor) {
      q = q.where((builder) => {
        builder
          .where('created_at', '<', cursor.createdAt)
          .orWhere((eq) => eq.where('created_at', cursor.createdAt).where('id', '<', cursor.id));
      });
    }

    // Fetch one extra row to detect whether a further page exists without a second COUNT query.
    const rows = (await q
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)) as MediaRow[];

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(fromRow);
    const last = page[page.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last
          ? encodeMediaCursor({ createdAt: Number(last.created_at), id: last.id })
          : null,
    };
  }

  async delete(id: string): Promise<void> {
    await this.ready();
    await this.query().where('id', id).delete();
  }

  async collectionTotals(options: MediaTotalsOptions = {}): Promise<MediaCollectionTotals[]> {
    await this.ready();
    let q = this.query();
    if (this.tenantColumn && options.tenantIds !== undefined) {
      q = whereTenantIn(q, options.tenantIds);
    }
    const rows = (await q
      .select('collection')
      .count('* as count')
      .sum('size as sum_size')
      .max('created_at as newest')
      .groupBy('collection')
      .orderBy('newest', 'desc')) as Array<{
      collection: string;
      count: number | string;
      sum_size: number | string | null;
    }>;
    return rows.map((row) => ({
      collection: row.collection,
      count: Number(row.count),
      sumSize: Number(row.sum_size ?? 0),
    }));
  }

  async listTenants(): Promise<string[]> {
    if (!this.tenantColumn) return [];
    await this.ready();
    const rows = (await this.query()
      .distinct('tenant_id')
      .whereNotNull('tenant_id')
      .orderBy('tenant_id', 'asc')
      .limit(1000)) as Array<{ tenant_id: string }>;
    return rows.map((row) => String(row.tenant_id));
  }

  async nextOrder(ownerType: string, ownerId: string, collection: string): Promise<number> {
    await this.ready();
    const row = (await this.query()
      .where('owner_type', ownerType)
      .where('owner_id', ownerId)
      .where('collection', collection)
      .max('order as max_order')
      .first()) as { max_order: number | null } | null;
    const max = row?.max_order;
    return max === null || max === undefined ? 0 : Number(max) + 1;
  }
}

/** `tenant_id IN (…)`, with `null` standing for `tenant_id IS NULL`; an empty list matches nothing. */
// biome-ignore lint/suspicious/noExplicitAny: Knex's chainable builder type.
function whereTenantIn<Q extends { where: any }>(q: Q, tenantIds: ReadonlyArray<string | null>): Q {
  const ids = tenantIds.filter((id): id is string => id !== null);
  const withNull = tenantIds.includes(null);
  return q.where(
    (builder: {
      whereIn(column: string, values: string[]): unknown;
      orWhereNull(column: string): unknown;
      whereRaw(sql: string): unknown;
    }) => {
      if (ids.length === 0 && !withNull) {
        builder.whereRaw('1 = 0');
        return;
      }
      if (ids.length > 0) builder.whereIn('tenant_id', ids);
      if (withNull) builder.orWhereNull('tenant_id');
    },
  ) as Q;
}

function toRow(record: MediaRecord, tenantColumn: boolean): MediaRow {
  return {
    ...(tenantColumn ? { tenant_id: record.tenantId ?? null } : {}),
    id: record.id,
    owner_type: record.ownerType,
    owner_id: record.ownerId,
    collection: record.collection,
    name: record.name,
    file_name: record.fileName,
    mime_type: record.mimeType,
    size: record.size,
    disk: record.disk,
    path: record.path,
    order: record.order,
    custom_properties: JSON.stringify(record.customProperties ?? {}),
    conversions: JSON.stringify(record.conversions ?? {}),
    created_at: record.createdAt.getTime(),
    updated_at: record.updatedAt.getTime(),
  };
}

function fromRow(row: MediaRow): MediaRecord {
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    collection: row.collection,
    name: row.name,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: Number(row.size),
    disk: row.disk,
    path: row.path,
    order: Number(row.order),
    customProperties: parseJson<Record<string, unknown>>(row.custom_properties, {}),
    conversions: parseJson<Record<string, MediaConversion>>(row.conversions, {}),
    createdAt: new Date(Number(row.created_at)),
    updatedAt: new Date(Number(row.updated_at)),
    ...(row.tenant_id !== undefined ? { tenantId: row.tenant_id } : {}),
  };
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
