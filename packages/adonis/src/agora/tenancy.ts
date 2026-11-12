/**
 * Structural reader for the tenancy contract `@adonis-agora/context` publishes on its global slots.
 * Never imports that package: with the slot missing, too old, or throwing, tenancy reads as OFF, so
 * media behaves exactly as it does without tenancy.
 *
 * The tenant here is the customer a piece of data belongs to (an organization, a clinic…), not a
 * process topology.
 */

const ACCESSOR = Symbol.for('@agora/context:accessor');
const TENANCY = Symbol.for('@agora/context:tenancy');

/** One level of a tenant chain. */
export interface TenantLevel {
  id: string;
  kind: string;
  slug?: string;
  role?: string;
}

/** The active tenant, as context publishes it. */
export interface TenantRef extends TenantLevel {
  source?: string;
  chain?: TenantLevel[];
  family?: string;
}

/** How a read or write must be scoped right now. */
export type TenantFilter =
  | { mode: 'system' }
  | { mode: 'all' }
  | { mode: 'tenantless' }
  | { mode: 'tenant'; tenant: TenantRef; chain?: TenantLevel[] };

/** The `tenancy` option of `config/media.ts`. */
export type MediaTenancyOption =
  | 'inherit'
  | false
  | {
      /** `'inherit'` (default) follows `tenancy.enabled` in `config/context.ts`. */
      enabled?: 'inherit' | boolean;
      /** Tenant kinds media honours; another kind reads as no tenant. Default: context's. */
      kinds?: string[];
      /**
       * Files with no tenant: `'tenantless'` (default) shows them only to requests without a
       * tenant; `'shared'` also shows them inside every tenant.
       */
      nullRows?: 'tenantless' | 'shared';
      /**
       * Store new files under `t/<tenantId>/…` (default `true` once tenancy is on). Existing files
       * never move: each record keeps the path it was written to.
       */
      pathPrefix?: boolean;
    };

/** {@link MediaTenancyOption} resolved against context. */
export interface ResolvedMediaTenancy {
  enabled: boolean;
  kinds?: string[];
  nullRows: 'tenantless' | 'shared';
  pathPrefix: boolean;
}

/** Tenancy off: nothing is stamped, filtered or prefixed. */
export const TENANCY_OFF: ResolvedMediaTenancy = Object.freeze({
  enabled: false,
  nullRows: 'tenantless',
  pathPrefix: false,
}) as ResolvedMediaTenancy;

interface TenancySlot {
  version?: number;
  tenancy?: () => { enabled?: boolean; kinds?: string[]; required?: boolean } | undefined;
  tenantFilter?: (options?: { kinds?: string[] }) => TenantFilter;
  withTenant?: <T>(input: { id: string; kind: string } | null, fn: () => T) => T;
  allTenants?: <T>(fn: () => T) => T;
  tenantLabels?: (ids: string[], kind?: string) => Promise<Record<string, string>>;
}

function slot<T>(key: symbol): T | undefined {
  const value = (globalThis as Record<symbol, unknown>)[key];
  return value !== null && typeof value === 'object' ? (value as T) : undefined;
}

/**
 * The tenancy reader: context's versioned `:tenancy` slot (v1) when present, else the `:accessor`
 * slot's tenancy members (an earlier context), else nothing.
 */
function reader(): TenancySlot | undefined {
  const tenancy = slot<TenancySlot>(TENANCY);
  if (tenancy?.version === 1 && typeof tenancy.tenantFilter === 'function') return tenancy;
  const accessor = slot<TenancySlot>(ACCESSOR);
  return typeof accessor?.tenantFilter === 'function' ? accessor : undefined;
}

/** Resolve media's `tenancy` option. With no (or an old) context, tenancy is off. */
export function resolveMediaTenancy(option: MediaTenancyOption | undefined): ResolvedMediaTenancy {
  if (option === false) return TENANCY_OFF;
  const accessor = reader();
  if (accessor === undefined) return TENANCY_OFF;
  const own = typeof option === 'object' ? option : {};
  let context: { enabled?: boolean; kinds?: string[] } | undefined;
  try {
    context = accessor.tenancy?.();
  } catch {
    context = undefined;
  }
  const enabled =
    own.enabled === undefined || own.enabled === 'inherit'
      ? context?.enabled === true
      : own.enabled;
  if (!enabled) return TENANCY_OFF;
  const kinds = own.kinds ?? context?.kinds;
  return {
    enabled: true,
    ...(kinds !== undefined ? { kinds: [...kinds] } : {}),
    nullRows: own.nullRows ?? 'tenantless',
    pathPrefix: own.pathPrefix !== false,
  };
}

/**
 * How the current request (or job) must be scoped. Tenancy off → `system` (nothing filtered). A
 * tenant of a kind media does not honour reads as `tenantless`. A context configured with
 * `required: true` throws here when there is no tenant.
 */
export function currentTenantFilter(tenancy: ResolvedMediaTenancy): TenantFilter {
  if (!tenancy.enabled) return { mode: 'system' };
  const filter = reader()?.tenantFilter?.(
    tenancy.kinds !== undefined ? { kinds: tenancy.kinds } : undefined,
  );
  if (filter === undefined || filter === null || typeof filter !== 'object') {
    return { mode: 'system' };
  }
  if (filter.mode === 'tenant') {
    const kind = filter.tenant?.kind;
    if (tenancy.kinds !== undefined && !tenancy.kinds.includes(kind)) return { mode: 'tenantless' };
  }
  return filter;
}

/** The tenant id to stamp on a write right now: the tenant's id in `tenant` mode, else `null`. */
export function currentTenantId(tenancy: ResolvedMediaTenancy): string | null {
  const filter = currentTenantFilter(tenancy);
  return filter.mode === 'tenant' ? filter.tenant.id : null;
}

/** A tenant set reads are confined to: these ids, plus rows with no tenant when `includeNull`. */
export interface TenantScope {
  tenants: readonly string[];
  includeNull: boolean;
}

/** The {@link TenantScope} of a filter, or `undefined` for "no filtering" (`system` / `all`). */
export function scopeOfFilter(
  filter: TenantFilter,
  nullRows: 'tenantless' | 'shared' = 'tenantless',
): TenantScope | undefined {
  switch (filter.mode) {
    case 'system':
    case 'all':
      return undefined;
    case 'tenantless':
      return { tenants: [], includeNull: true };
    case 'tenant':
      return { tenants: [filter.tenant.id], includeNull: nullRows === 'shared' };
  }
}

/** The scope reads must apply right now (`undefined` = unfiltered). */
export function currentTenantScope(tenancy: ResolvedMediaTenancy): TenantScope | undefined {
  if (!tenancy.enabled) return undefined;
  return scopeOfFilter(currentTenantFilter(tenancy), tenancy.nullRows);
}

/** Whether a row stamped `tenantId` is inside `scope` (`undefined` scope = everything). */
export function inScope(
  scope: TenantScope | undefined,
  tenantId: string | null | undefined,
): boolean {
  if (scope === undefined) return true;
  const id = tenantId ?? null;
  return id === null ? scope.includeNull : scope.tenants.includes(id);
}

/** The scope as a list of tenant ids with `null` standing for "no tenant" (`undefined` = all). */
export function scopeIds(scope: TenantScope | undefined): Array<string | null> | undefined {
  if (scope === undefined) return undefined;
  return scope.includeNull ? [...scope.tenants, null] : [...scope.tenants];
}

/** Run `fn` inside `tenant` (or no tenant), through context; plain `fn()` without context. */
export function withTenant<T>(tenant: { id: string; kind: string } | null, fn: () => T): T {
  const withTenantFn = slot<TenancySlot>(TENANCY)?.withTenant;
  return typeof withTenantFn === 'function' ? withTenantFn(tenant, fn) : fn();
}

/** Run `fn` across every tenant (context's `allTenants`); plain `fn()` without context. */
export function allTenants<T>(fn: () => T): T {
  const all = slot<TenancySlot>(TENANCY)?.allTenants;
  return typeof all === 'function' ? all(fn) : fn();
}

/** Display labels for tenant ids, from context's label resolver; ids map to themselves otherwise. */
export async function tenantLabels(ids: string[], kind?: string): Promise<Record<string, string>> {
  const labels: Record<string, string> = Object.fromEntries(ids.map((id) => [id, id]));
  const tenancy = slot<TenancySlot>(TENANCY);
  if (tenancy?.version !== 1 || typeof tenancy.tenantLabels !== 'function') return labels;
  try {
    const resolved = await tenancy.tenantLabels(ids, kind);
    for (const id of ids) {
      const label = resolved?.[id];
      if (typeof label === 'string' && label !== '') labels[id] = label;
    }
  } catch {
    // labels are display only
  }
  return labels;
}

/** The storage prefix of a tenant's new files: `t/<tenantId>/`. */
export function tenantPathPrefix(tenantId: string): string {
  return `t/${encodeURIComponent(tenantId)}/`;
}
