import type { Database } from '@adonisjs/lucid/database';
import type { QueryClientContract } from '@adonisjs/lucid/types/database';
import type { MediaConversion, MediaRecord } from '../media_record.js';
import {
  type MediaListOptions,
  type MediaListPage,
  type MediaStore,
  clampMediaListLimit,
  decodeMediaCursor,
  encodeMediaCursor,
} from '../media_store.js';

export interface LucidMediaStoreOptions {
  /** The Lucid connection name. Defaults to the `Database` default connection. */
  connectionName?: string;
  /** Table name. Default `media`. */
  table?: string;
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
}

/**
 * Lucid-backed {@link MediaStore}. Persists media records in a `media` table via `@adonisjs/lucid`'s
 * query builder (Knex), so it works across SQLite / Postgres / MySQL. JSON payloads
 * (`custom_properties`, `conversions`) are stored as TEXT and timestamps as epoch-ms integers, so the
 * schema is portable across engines. Publish the migration with `node ace configure @adonis-agora/media`.
 */
export class LucidMediaStore implements MediaStore {
  private readonly table: string;
  private readonly connectionName: string | undefined;

  constructor(
    private readonly db: Database,
    options: LucidMediaStoreOptions = {},
  ) {
    this.table = options.table ?? 'media';
    this.connectionName = options.connectionName;
  }

  private client(): QueryClientContract {
    return this.connectionName ? this.db.connection(this.connectionName) : this.db.connection();
  }

  private query() {
    return this.client().from(this.table);
  }

  async save(record: MediaRecord): Promise<MediaRecord> {
    const row = toRow(record);
    // Single atomic upsert (portable Knex `INSERT ... ON CONFLICT (id) DO UPDATE`) instead of a
    // racy read-then-branch: concurrent saves of the same id can't interleave into a lost write.
    await this.client().table(this.table).insert(row).onConflict('id').merge();
    return { ...record };
  }

  async find(id: string): Promise<MediaRecord | null> {
    const row = (await this.query().where('id', id).first()) as MediaRow | null;
    return row ? fromRow(row) : null;
  }

  async listByOwner(
    ownerType: string,
    ownerId: string,
    collection?: string,
  ): Promise<MediaRecord[]> {
    let q = this.query().where('owner_type', ownerType).where('owner_id', ownerId);
    if (collection !== undefined) q = q.where('collection', collection);
    const rows = (await q.orderBy('order', 'asc')) as MediaRow[];
    return rows.map(fromRow);
  }

  async list(options: MediaListOptions = {}): Promise<MediaListPage> {
    const limit = clampMediaListLimit(options.limit);
    let q = this.query();
    if (options.ownerType !== undefined) q = q.where('owner_type', options.ownerType);
    if (options.ownerId !== undefined) q = q.where('owner_id', options.ownerId);
    if (options.collection !== undefined) q = q.where('collection', options.collection);
    if (options.prefix !== undefined && options.prefix !== '') {
      q = q.where('path', 'like', `${options.prefix}%`);
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
    await this.query().where('id', id).delete();
  }

  async nextOrder(ownerType: string, ownerId: string, collection: string): Promise<number> {
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

function toRow(record: MediaRecord): MediaRow {
  return {
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
