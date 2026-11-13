import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '../agora-kit/ui/popover';
import { selectedTenant } from '../client/dashboard-client';
import type { TenantPickerResponse } from '../types';
import { useDashboard } from './context';

/** Put the picked organization in the URL (`?tenant=`, absent = all), keeping the hash route. */
function writeTenantToUrl(tenant: string | undefined): void {
  const url = new URL(window.location.href);
  if (tenant === undefined) url.searchParams.delete('tenant');
  else url.searchParams.set('tenant', tenant);
  window.history.pushState(null, '', url.toString());
}

/** The label of the picked organization (or "All organizations"). */
export function tenantLabel(picker: TenantPickerResponse | undefined, id: string | undefined) {
  if (id === undefined) return 'All organizations';
  return picker?.tenants.find((t) => t.id === id)?.label ?? id;
}

/** The picker data, shared by the header control and the lists' organization column. */
export function useTenantPicker(): TenantPickerResponse | undefined {
  const { client } = useDashboard();
  const { data } = useQuery({
    queryKey: ['tenants'],
    queryFn: () => client.tenants(),
    staleTime: 60_000,
    refetchInterval: false,
  });
  return data;
}

/** Whether the lists should show an organization column (several organizations in view). */
export function useShowsTenantColumn(): boolean {
  const picker = useTenantPicker();
  return picker?.mode === 'pick' && selectedTenant() === undefined;
}

const chip =
  'mono flex h-7 items-center gap-1.5 rounded-md border border-line bg-panel-2 px-2 text-[11px] text-fg-2';

/**
 * The topbar's "Organization" control (tenancy on): a fixed chip for one organization, a searchable
 * list for several ("All organizations" first when the viewer may see every one). Nothing when
 * tenancy is off.
 */
export function TenantPickerControl() {
  const picker = useTenantPicker();
  const { client } = useDashboard();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [current, setCurrent] = useState(selectedTenant);

  if (!picker || picker.mode === 'off') return null;

  if (picker.mode === 'none') {
    return (
      <span
        className={chip}
        data-tenant-picker="none"
        title="Choose an organization in the app to see its files"
      >
        <span className="text-faint">Organization</span> none
      </span>
    );
  }
  if (picker.mode === 'fixed') {
    return (
      <span className={chip} data-tenant-picker="fixed">
        <span className="text-faint">Organization</span>
        {picker.tenants[0]?.label ?? picker.tenants[0]?.id}
      </span>
    );
  }

  const choose = async (tenant: string | undefined) => {
    setOpen(false);
    setSearch('');
    await client.selectTenant(tenant ?? '*').catch(() => undefined);
    writeTenantToUrl(tenant);
    setCurrent(tenant);
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'tenants' });
  };
  const needle = search.trim().toLowerCase();
  const shown = picker.tenants.filter(
    (t) =>
      needle === '' ||
      t.label.toLowerCase().includes(needle) ||
      t.id.toLowerCase().includes(needle),
  );
  const option =
    'flex w-full flex-col rounded px-2 py-1.5 text-left text-xs text-fg hover:bg-hover aria-selected:bg-brand-soft';

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={`${chip} max-w-64 hover:border-line-strong`}
        aria-label="Organization"
        data-tenant-picker="pick"
      >
        <span className="hidden text-faint sm:inline">Organization</span>
        <span className="truncate">{tenantLabel(picker, current)}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 gap-1 p-1">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="search organizations…"
          aria-label="search organizations"
          className="mb-1 h-7 w-full rounded border border-line bg-transparent px-2 text-xs text-fg outline-none placeholder:text-faint focus-visible:border-ring"
        />
        <div role="listbox" aria-label="Organizations" className="max-h-72 overflow-y-auto">
          {picker.all && (
            <button
              type="button"
              role="option"
              aria-selected={current === undefined}
              onClick={() => void choose(undefined)}
              className={option}
            >
              All organizations
            </button>
          )}
          {shown.map((t) => (
            <button
              key={t.id}
              type="button"
              role="option"
              aria-selected={current === t.id}
              onClick={() => void choose(t.id)}
              className={option}
            >
              <span className="truncate">{t.label}</span>
              {t.label !== t.id && (
                <span className="mono truncate text-[10px] text-faint">{t.id}</span>
              )}
            </button>
          ))}
          {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-faint">No match.</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}
