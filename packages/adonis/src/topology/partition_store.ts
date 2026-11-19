import type { MediaRecord } from '../media_record.js';
import type { MediaListOptions, MediaStore } from '../media_store.js';
import { inPartition } from './protocol.js';

/**
 * One tenant app's records on the control plane: the store seen through a guard that only lets that
 * partition's records through. Another app's record reads as missing and cannot be deleted from
 * here, and listing by an owner type outside the partition finds nothing.
 *
 * A tenant's records are stored with the owner type `<partition>/<ownerType>`, which also puts their
 * storage keys under `<partition>/` (the library's layout starts with the owner type), so the
 * cross-owner `list` narrows by that path prefix first, then re-checks every row (`_` is a `LIKE`
 * wildcard, so the prefix alone is not proof).
 */
export function partitionStore(store: MediaStore, partition: string): MediaStore {
  const own = (record: MediaRecord | null): MediaRecord | null =>
    record && inPartition(partition, record) ? record : null;
  const ownsType = (ownerType: string | undefined) =>
    ownerType === undefined || ownerType.startsWith(`${partition}/`);
  const root = `${partition}/`;

  const guarded: MediaStore = {
    save(record) {
      if (!inPartition(partition, record)) {
        return Promise.reject(new Error(`media: a record outside partition "${partition}"`));
      }
      return store.save(record);
    },
    async find(id) {
      return own(await store.find(id));
    },
    async listByOwner(ownerType, ownerId, collection) {
      if (!ownsType(ownerType)) return [];
      return store.listByOwner(ownerType, ownerId, collection);
    },
    async list(options: MediaListOptions = {}) {
      if (!ownsType(options.ownerType)) return { items: [], nextCursor: null };
      const prefix = options.prefix?.startsWith(root) ? options.prefix : root;
      const page = await store.list({ ...options, prefix });
      return {
        items: page.items.filter((record) => inPartition(partition, record)),
        nextCursor: page.nextCursor,
      };
    },
    async delete(id) {
      if (own(await store.find(id))) await store.delete(id);
    },
    nextOrder(ownerType, ownerId, collection) {
      if (!ownsType(ownerType)) {
        return Promise.reject(new Error(`media: an owner outside partition "${partition}"`));
      }
      return store.nextOrder(ownerType, ownerId, collection);
    },
  };
  if (typeof store.listByOwnerPaged === 'function') {
    const paged = store.listByOwnerPaged.bind(store);
    guarded.listByOwnerPaged = async (ownerType, ownerId, options) =>
      ownsType(ownerType) ? paged(ownerType, ownerId, options) : { items: [], nextCursor: null };
  }
  return guarded;
}
