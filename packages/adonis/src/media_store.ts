import type { MediaRecord } from './media_record.js';

/** Default page size for {@link MediaStore.list} when `limit` is omitted. */
export const DEFAULT_MEDIA_LIST_LIMIT = 50;
/** Hard cap on {@link MediaStore.list} page size, so a caller can't request an unbounded scan. */
export const MAX_MEDIA_LIST_LIMIT = 200;

/** Filters + cursor for a cross-owner {@link MediaStore.list} page. Every filter is optional (`AND`ed). */
export interface MediaListOptions {
  /** Restrict to a single collection. */
  collection?: string;
  /** Restrict to a single owner type. */
  ownerType?: string;
  /** Restrict to a single owner id (usually paired with `ownerType`). */
  ownerId?: string;
  /** Restrict to records whose `path` starts with this prefix. */
  prefix?: string;
  /** Opaque cursor from a previous page's `nextCursor` (see {@link encodeMediaCursor}). */
  cursor?: string;
  /** Page size (clamped to {@link MAX_MEDIA_LIST_LIMIT}). Defaults to {@link DEFAULT_MEDIA_LIST_LIMIT}. */
  limit?: number;
  /**
   * Only records of these tenants; `null` stands for records with no tenant. Applied by stores
   * that declare {@link MediaStore.tenantFiltering}.
   */
  tenantIds?: ReadonlyArray<string | null>;
}

/** Options for {@link MediaStore.listByOwnerPaged}. */
export interface MediaOwnerPageOptions {
  /** Only these collections (omit for every collection; an empty list matches nothing). */
  collections?: readonly string[];
  /** Opaque cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Page size (clamped to {@link MAX_MEDIA_LIST_LIMIT}). Defaults to {@link DEFAULT_MEDIA_LIST_LIMIT}. */
  limit?: number;
  /** Only records of these tenants (`null`: no tenant). */
  tenantIds?: ReadonlyArray<string | null>;
}

/** Options for {@link MediaStore.collectionTotals}. */
export interface MediaTotalsOptions {
  /** Only count records of these tenants (`null`: no tenant). */
  tenantIds?: ReadonlyArray<string | null>;
}

/** One page of a cross-owner {@link MediaStore.list}. `nextCursor` is null when the page is the last. */
export interface MediaListPage {
  items: MediaRecord[];
  nextCursor: string | null;
}

/** Record count and total bytes of one collection, as {@link MediaStore.collectionTotals} reports it. */
export interface MediaCollectionTotals {
  collection: string;
  count: number;
  sumSize: number;
}

/**
 * Persistence SPI for media records. Implemented per backend as a POJO that receives
 * its connection in the constructor. Ships with an in-memory driver (`@adonis-agora/media/testing`)
 * and a Lucid driver (`@adonis-agora/media/stores/lucid`).
 */
export interface MediaStore {
  save(record: MediaRecord): Promise<MediaRecord>;
  find(id: string): Promise<MediaRecord | null>;
  /** Records for an owner, optionally a single collection, ordered by `order` asc. */
  listByOwner(ownerType: string, ownerId: string, collection?: string): Promise<MediaRecord[]>;
  /**
   * Cross-owner, cursor-paginated listing (newest first), for management/console views. Ordered by
   * `createdAt` desc then `id` desc — a stable keyset — so paging is consistent under concurrent writes.
   */
  list(options?: MediaListOptions): Promise<MediaListPage>;
  delete(id: string): Promise<void>;
  /** Next `order` value for appending to a collection (0-based). */
  nextOrder(ownerType: string, ownerId: string, collection: string): Promise<number>;
  /**
   * Count and total size of every collection, in one aggregate over the whole store, ordered by
   * each collection's newest record first. Optional: without it, callers page through {@link list}.
   */
  collectionTotals?(options?: MediaTotalsOptions): Promise<MediaCollectionTotals[]>;
  /**
   * `true` when {@link list} and {@link collectionTotals} honour `tenantIds` (both bundled stores
   * do). Without it, tenant-scoped reads filter `list` pages in memory and skip the totals.
   */
  readonly tenantFiltering?: boolean;
  /**
   * One owner's records across several collections, newest first, cursor-paginated (same keyset as
   * {@link list}). Optional: without it, {@link MediaLibrary.page} walks {@link list} per owner.
   */
  listByOwnerPaged?(
    ownerType: string,
    ownerId: string,
    options?: MediaOwnerPageOptions,
  ): Promise<MediaListPage>;
  /** Every tenant id some record carries (tenancy on), for the console's organization picker. */
  listTenants?(): Promise<string[]>;
}

/** Whether a record's tenant is one of `tenantIds` (`undefined`: no filter). */
export function tenantMatches(
  tenantIds: ReadonlyArray<string | null> | undefined,
  tenantId: string | null | undefined,
): boolean {
  return tenantIds === undefined || tenantIds.includes(tenantId ?? null);
}

/** The keyset a {@link MediaListPage} cursor carries: the last row's `createdAt` (epoch-ms) and `id`. */
export interface MediaCursor {
  createdAt: number;
  id: string;
}

/** Encode a keyset into the opaque `nextCursor` string handed back to callers (URL-safe base64). */
export function encodeMediaCursor(cursor: MediaCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Decode a `cursor` produced by {@link encodeMediaCursor}; returns null when malformed. */
export function decodeMediaCursor(cursor: string | undefined): MediaCursor | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as MediaCursor;
    if (typeof parsed.createdAt !== 'number' || typeof parsed.id !== 'string') return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

/** Clamp a requested page size to `[1, MAX_MEDIA_LIST_LIMIT]`, defaulting when omitted. */
export function clampMediaListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_MEDIA_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_MEDIA_LIST_LIMIT, Math.floor(limit)));
}
