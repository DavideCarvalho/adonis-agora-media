import { allTenants, type TenantScope, tenantPathPrefix } from '../agora/tenancy.js';
import type { MediaStore } from '../media_store.js';
import type { UploadSession } from '../resumable_upload.js';
import { tenantScopedStore } from '../tenant_scoped_store.js';
import { DashboardError, type MediaManagerLike } from './service.js';

/**
 * Which tenants (organizations) the console shows a viewer, once tenancy is on:
 *
 * - `authorized`: what `authorize` granted — `'*'` (every tenant, and files with no tenant), a
 *   list, or the viewer's own active tenant (`own`), or nothing (`'none'`: a viewer with no tenant).
 * - `selected`: the tenant the viewer picked (`?tenant=`), already intersected with `authorized`.
 * - `ids`: what the console's reads are confined to (`undefined` = no confinement; `null` = files
 *   with no tenant).
 */
export interface ConsoleTenantScope {
  authorized: '*' | string[] | 'none';
  /** The viewer's own active tenant, when the scope came from it. */
  own?: { id: string; kind?: string | undefined; slug?: string | undefined } | undefined;
  selected: string | undefined;
  ids: Array<string | null> | undefined;
  /** The viewer asked for a tenant outside `authorized` (answered with nothing, and audited). */
  forged: boolean;
}

/** Resolve the console scope from the `authorize` grant, the viewer's tenant and their pick. */
export function resolveConsoleTenantScope(input: {
  granted: '*' | string[] | undefined;
  own: { id: string; kind?: string | undefined; slug?: string | undefined } | undefined;
  selected: string | undefined;
}): ConsoleTenantScope {
  const authorized: ConsoleTenantScope['authorized'] =
    input.granted !== undefined ? input.granted : input.own ? [input.own.id] : 'none';
  const selected = input.selected?.trim() || undefined;
  const pick = selected === '*' ? undefined : selected;
  const base = {
    authorized,
    ...(input.granted === undefined && input.own ? { own: input.own } : {}),
  };
  if (authorized === 'none') {
    return { ...base, selected: undefined, ids: [], forged: pick !== undefined };
  }
  if (pick === undefined) {
    return {
      ...base,
      selected: undefined,
      ids: authorized === '*' ? undefined : [...authorized],
      forged: false,
    };
  }
  if (authorized === '*' || authorized.includes(pick)) {
    return { ...base, selected: pick, ids: [pick], forged: false };
  }
  return { ...base, selected: pick, ids: [], forged: true };
}

/** The ids of a console scope as a {@link TenantScope} (`undefined`: unconfined). */
export function tenantScopeOf(ids: Array<string | null> | undefined): TenantScope | undefined {
  if (ids === undefined) return undefined;
  return {
    tenants: ids.filter((id): id is string => id !== null),
    includeNull: ids.includes(null),
  };
}

/**
 * The storage prefixes a confined viewer may browse on the disks: `t/<tenantId>/` per tenant in
 * scope (where tenancy stores new files). `undefined` when the viewer is not confined.
 */
export function consoleKeyPrefixes(ids: Array<string | null> | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  return ids.filter((id): id is string => id !== null).map(tenantPathPrefix);
}

/**
 * The console's view of the media manager with tenancy on, confined to `ids` (`undefined`: every
 * tenant): the store only sees those tenants' records (another tenant's reads as missing), and the
 * upload list only their sessions. Upload-session reads run across tenants first (the console's
 * own scope replaces the request's tenant), then keep the scope's.
 */
export function scopedManager(
  manager: MediaManagerLike,
  ids: Array<string | null> | undefined,
): MediaManagerLike {
  const scope = tenantScopeOf(ids);
  const visible = (session: UploadSession) =>
    ids === undefined || ids.includes(session.tenantId ?? null);
  const resumable = manager.resumable;
  const sessions = async () =>
    allTenants(() => resumable.list(ids !== undefined ? { tenantIds: ids } : {}));
  return {
    storage: manager.storage,
    hasResumable: manager.hasResumable,
    store:
      scope === undefined
        ? manager.store
        : tenantScopedStore(manager.store as MediaStore, { scope: () => scope }),
    get resumable() {
      return {
        list: async (filter?: { disk?: string; keyPrefix?: string }) =>
          (
            await allTenants(() =>
              resumable.list({ ...filter, ...(ids !== undefined ? { tenantIds: ids } : {}) }),
            )
          ).filter(visible),
        abort: async (id: string) => {
          if (!(await sessions()).some((s) => s.id === id && visible(s))) {
            throw new DashboardError(`unknown upload: ${id}`, 404);
          }
          return allTenants(() => resumable.abort(id));
        },
        listParts: async (id: string) => {
          if (!(await sessions()).some((s) => s.id === id && visible(s))) return [];
          return allTenants(() => resumable.listParts(id));
        },
      };
    },
  };
}
