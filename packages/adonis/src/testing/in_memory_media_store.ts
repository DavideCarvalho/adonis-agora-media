import type { MediaRecord } from '../media_record.js';
import {
  clampMediaListLimit,
  decodeMediaCursor,
  encodeMediaCursor,
  type MediaListOptions,
  type MediaListPage,
  type MediaStore,
} from '../media_store.js';

/** In-memory {@link MediaStore} for tests and scratch apps. */
export class InMemoryMediaStore implements MediaStore {
  private readonly records = new Map<string, MediaRecord>();

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
            r.path.startsWith(options.prefix)),
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

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async nextOrder(ownerType: string, ownerId: string, collection: string): Promise<number> {
    const inCollection = await this.listByOwner(ownerType, ownerId, collection);
    return inCollection.reduce((max, r) => Math.max(max, r.order + 1), 0);
  }
}
