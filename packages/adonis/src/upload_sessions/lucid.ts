import type { Database } from '@adonisjs/lucid/database';
import type { QueryClientContract } from '@adonisjs/lucid/types/database';
import type {
  UploadSession,
  UploadSessionListFilter,
  UploadSessionStore,
} from '../resumable_upload.js';
import type { MultipartPart } from '../types.js';

export interface LucidUploadSessionStoreOptions {
  /** Lucid connection name. Defaults to the `Database` default connection. */
  connectionName?: string;
  /** Sessions table name. Default `media_upload_sessions`. */
  table?: string;
  /** Parts side-index table name. Default `media_upload_parts`. */
  partsTable?: string;
}

/** Physical row shape of the `media_upload_sessions` table. Timestamps are epoch-ms integers. */
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
  expires_at: number | null;
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
export class LucidUploadSessionStore implements UploadSessionStore {
  private readonly table: string;
  private readonly partsTable: string;
  private readonly connectionName: string | undefined;

  constructor(
    private readonly db: Database,
    options: LucidUploadSessionStoreOptions = {},
  ) {
    this.table = options.table ?? 'media_upload_sessions';
    this.partsTable = options.partsTable ?? 'media_upload_parts';
    this.connectionName = options.connectionName;
  }

  private client(): QueryClientContract {
    return this.connectionName ? this.db.connection(this.connectionName) : this.db.connection();
  }

  async create(session: UploadSession): Promise<UploadSession> {
    const stored: UploadSession = { ...session, createdAt: session.createdAt ?? new Date() };
    await this.client().table(this.table).insert(toRow(stored)).onConflict('id').merge();
    return { ...stored };
  }

  async get(id: string): Promise<UploadSession | null> {
    const row = (await this.client()
      .from(this.table)
      .where('id', id)
      .first()) as SessionRow | null;
    return row ? fromRow(row) : null;
  }

  async update(session: UploadSession): Promise<UploadSession> {
    await this.client().table(this.table).insert(toRow(session)).onConflict('id').merge();
    return { ...session };
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
    const rows = (await q.orderBy('created_at', 'asc')) as SessionRow[];
    return rows.map(fromRow);
  }
}

function toRow(session: UploadSession): SessionRow {
  return {
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
  if (row.multipart_upload_id) session.multipartUploadId = row.multipart_upload_id;
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
