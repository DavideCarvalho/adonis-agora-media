import { inScope, scopeIds, type TenantScope } from './agora/tenancy.js';
import type { MediaRecord } from './media_record.js';
import type {
  MediaCollectionTotals,
  MediaListOptions,
  MediaListPage,
  MediaStore,
  MediaTotalsOptions,
} from './media_store.js';
import type { UploadSessionListFilter, UploadSessionStore } from './resumable_upload.js';

/** What {@link tenantScopedStore} needs besides the store. */
export interface TenantScopedStoreOptions {
  /** The scope reads are confined to right now (`undefined`: unfiltered). Read on every call. */
  scope: () => TenantScope | undefined;
  /** Collections every tenant may read (`access.read: 'public'`): never filtered. */
  isShared?: (collection: string) => boolean;
}

/** Intersect a caller's `tenantIds` with the scope's (`undefined` on either side: the other). */
function intersect(
  requested: ReadonlyArray<string | null> | undefined,
  allowed: ReadonlyArray<string | null> | undefined,
): ReadonlyArray<string | null> | undefined {
  if (allowed === undefined) return requested;
  if (requested === undefined) return allowed;
  return requested.filter((id) => allowed.includes(id));
}

/**
 * A {@link MediaStore} view confined to a tenant scope: a record outside it reads as missing
 * (`find` → `null`, never "forbidden"), listings and totals only see the scope. Writes go through
 * unchanged; the library stamps new records itself. A record of a shared (public) collection stays
 * readable from every scope by id (`find`) and in its owner's list (`listByOwner`), which is how an
 * app serves and renders it; the cross-owner management reads (`list`, totals, paged owner lists)
 * stay confined to the scope.
 */
export function tenantScopedStore(
  store: MediaStore,
  options: TenantScopedStoreOptions,
): MediaStore {
  const shared = options.isShared ?? (() => false);
  const visible = (scope: TenantScope | undefined, record: MediaRecord) =>
    inScope(scope, record.tenantId) || shared(record.collection);

  const scoped: MediaStore = {
    save: (record) => store.save(record),
    delete: (id) => store.delete(id),
    // The order counter only counts the scope's records, so another tenant's files leave no gaps.
    async nextOrder(ownerType, ownerId, collection) {
      const scope = options.scope();
      if (scope === undefined) return store.nextOrder(ownerType, ownerId, collection);
      const records = await store.listByOwner(ownerType, ownerId, collection);
      return records
        .filter((record) => inScope(scope, record.tenantId))
        .reduce((max, record) => Math.max(max, record.order + 1), 0);
    },
    async find(id) {
      const scope = options.scope();
      const record = await store.find(id);
      return record && visible(scope, record) ? record : null;
    },
    async listByOwner(ownerType, ownerId, collection) {
      const scope = options.scope();
      const records = await store.listByOwner(ownerType, ownerId, collection);
      return scope === undefined ? records : records.filter((record) => visible(scope, record));
    },
    async list(listOptions: MediaListOptions = {}): Promise<MediaListPage> {
      const scope = options.scope();
      if (scope === undefined) return store.list(listOptions);
      const tenantIds = intersect(listOptions.tenantIds, scopeIds(scope));
      const page = await store.list({
        ...listOptions,
        ...(tenantIds !== undefined ? { tenantIds } : {}),
      });
      // A store that ignores `tenantIds` is filtered here (its pages may then come back short).
      return store.tenantFiltering === true
        ? page
        : { ...page, items: page.items.filter((record) => inScope(scope, record.tenantId)) };
    },
    ...(store.tenantFiltering === true ? { tenantFiltering: true } : {}),
  };

  // Never count across tenants: a store that cannot filter its totals offers none here, so callers
  // fall back to paging the scoped `list`.
  const totals = store.tenantFiltering === true ? store.collectionTotals?.bind(store) : undefined;
  if (totals) {
    scoped.collectionTotals = async (
      totalsOptions: MediaTotalsOptions = {},
    ): Promise<MediaCollectionTotals[]> => {
      const scope = options.scope();
      if (scope === undefined) return totals(totalsOptions);
      const tenantIds = intersect(totalsOptions.tenantIds, scopeIds(scope));
      return totals({ ...totalsOptions, ...(tenantIds !== undefined ? { tenantIds } : {}) });
    };
  }
  return scoped;
}

/** What {@link tenantScopedSessionStore} needs besides the store. */
export interface TenantScopedSessionStoreOptions {
  /** The scope reads are confined to right now (`undefined`: unfiltered). */
  scope: () => TenantScope | undefined;
  /** The tenant a new session is stamped with (`null`: none). */
  stamp: () => string | null;
}

/**
 * An {@link UploadSessionStore} view confined to a tenant scope: new sessions are stamped with the
 * current tenant, and a session of another tenant reads as missing (its upload cannot be resumed,
 * completed or aborted from there).
 */
export function tenantScopedSessionStore(
  store: UploadSessionStore,
  options: TenantScopedSessionStoreOptions,
): UploadSessionStore {
  const scoped: UploadSessionStore = {
    create: (session) =>
      store.create(
        session.tenantId === undefined ? { ...session, tenantId: options.stamp() } : session,
      ),
    async get(id) {
      const scope = options.scope();
      const session = await store.get(id);
      return session && inScope(scope, session.tenantId) ? session : null;
    },
    update: (session) => store.update(session),
    delete: (id) => store.delete(id),
  };
  if (store.addPart) scoped.addPart = store.addPart.bind(store);
  if (store.listParts) scoped.listParts = store.listParts.bind(store);
  const list = store.list?.bind(store);
  if (list) {
    scoped.list = async (filter: UploadSessionListFilter = {}) => {
      const scope = options.scope();
      if (scope === undefined) return list(filter);
      const tenantIds = intersect(filter.tenantIds, scopeIds(scope));
      const sessions = await list({ ...filter, ...(tenantIds !== undefined ? { tenantIds } : {}) });
      return sessions.filter((session) => inScope(scope, session.tenantId));
    };
  }
  return scoped;
}
