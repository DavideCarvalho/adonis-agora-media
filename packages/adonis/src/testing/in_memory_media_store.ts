import type { MediaRecord } from '../media_record.js';
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
  tenantMatches,
} from '../media_store.js';

/** In-memory {@link MediaStore} for tests and scratch apps. */
export class InMemoryMediaStore implements MediaStore {
  private readonly records = new Map<string, MediaRecord>();
  readonly tenantFiltering = true;

  async save(record: MediaRecord): Promise<MediaRecord> {
    const copy = { ...record };
    this.records.set(copy.id, copy);
    return { ...copy };
  }

  async find(id: string): Promise<MediaRecord | null> {
    const found = this.records.get(id);
    return found ? { ...found } : null;
  }

  async listByOwner(
    ownerType: string,
    ownerId: string,
    collection?: string,
  ): Promise<MediaRecord[]> {
    return [...this.records.values()]
      .filter(
        (r) =>
          r.ownerType === ownerType &&
          r.ownerId === ownerId &&
          (collection === undefined || r.collection === collection),
      )
      .sort((a, b) => a.order - b.order)
      .map((r) => ({ ...r }));
  }

  async list(options: MediaListOptions = {}): Promise<MediaListPage> {
    const limit = clampMediaListLimit(options.limit);
    const ordered = [...this.records.values()]
      .filter(
        (r) =>
          (options.ownerType === undefined || r.ownerType === options.ownerType) &&
          (options.ownerId === undefined || r.ownerId === options.ownerId) &&
          (options.collection === undefined || r.collection === options.collection) &&
          (options.prefix === undefined ||
            options.prefix === '' ||
            r.path.startsWith(options.prefix)) &&
          tenantMatches(options.tenantIds, r.tenantId),
      )
      // Newest first, tie-broken by id desc — the same stable keyset the Lucid store paginates on.
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
      );

    // Drop everything up to and including the cursor row, per the (createdAt desc, id desc) order.
    const cursor = decodeMediaCursor(options.cursor);
    const after = cursor
      ? ordered.filter(
          (r) =>
            r.createdAt.getTime() < cursor.createdAt ||
            (r.createdAt.getTime() === cursor.createdAt && r.id < cursor.id),
        )
      : ordered;

    const page = after.slice(0, limit);
    const hasMore = after.length > limit;
    const last = page[page.length - 1];
    return {
      items: page.map((r) => ({ ...r })),
      nextCursor:
        hasMore && last
          ? encodeMediaCursor({ createdAt: last.createdAt.getTime(), id: last.id })
          : null,
    };
  }

  async listByOwnerPaged(
    ownerType: string,
    ownerId: string,
    options: MediaOwnerPageOptions = {},
  ): Promise<MediaListPage> {
    const collections = options.collections;
    const all = [...this.records.values()].filter(
      (r) =>
        r.ownerType === ownerType &&
        r.ownerId === ownerId &&
        (collections === undefined || collections.includes(r.collection)) &&
        tenantMatches(options.tenantIds, r.tenantId),
    );
    return keysetPage(all, options.cursor, options.limit);
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async collectionTotals(options: MediaTotalsOptions = {}): Promise<MediaCollectionTotals[]> {
    const totals = new Map<string, MediaCollectionTotals & { newest: number }>();
    for (const record of this.records.values()) {
      if (!tenantMatches(options.tenantIds, record.tenantId)) continue;
      const entry = totals.get(record.collection) ?? {
        collection: record.collection,
        count: 0,
        sumSize: 0,
        newest: Number.NEGATIVE_INFINITY,
      };
      entry.count += 1;
      entry.sumSize += record.size;
      entry.newest = Math.max(entry.newest, record.createdAt.getTime());
      totals.set(record.collection, entry);
    }
    return [...totals.values()]
      .sort((a, b) => b.newest - a.newest)
      .map(({ collection, count, sumSize }) => ({ collection, count, sumSize }));
  }

  async listTenants(): Promise<string[]> {
    const ids = new Set<string>();
    for (const record of this.records.values()) if (record.tenantId) ids.add(record.tenantId);
    return [...ids].sort();
  }

  async nextOrder(ownerType: string, ownerId: string, collection: string): Promise<number> {
    const inCollection = await this.listByOwner(ownerType, ownerId, collection);
    return inCollection.reduce((max, r) => Math.max(max, r.order + 1), 0);
  }
}

/** Newest first (createdAt desc, id desc), resumed strictly after `cursor`. */
function keysetPage(
  records: MediaRecord[],
  cursorValue: string | undefined,
  limitValue: number | undefined,
): MediaListPage {
  const limit = clampMediaListLimit(limitValue);
  const ordered = records.sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  const cursor = decodeMediaCursor(cursorValue);
  const after = cursor
    ? ordered.filter(
        (r) =>
          r.createdAt.getTime() < cursor.createdAt ||
          (r.createdAt.getTime() === cursor.createdAt && r.id < cursor.id),
      )
    : ordered;
  const page = after.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({ ...r })),
    nextCursor:
      after.length > limit && last
        ? encodeMediaCursor({ createdAt: last.createdAt.getTime(), id: last.id })
        : null,
  };
}
