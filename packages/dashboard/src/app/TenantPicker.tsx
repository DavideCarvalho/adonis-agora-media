import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
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
  'mono flex items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-1 text-[11px] text-zinc-300';

/**
 * The header's "Organization" control (tenancy on): a fixed chip for one organization, a searchable
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
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!picker || picker.mode === 'off') return null;

  if (picker.mode === 'none') {
    return (
      <span
        className={chip}
        data-tenant-picker="none"
        title="Choose an organization in the app to see its files"
      >
        <span className="text-zinc-500">Organization</span> none
      </span>
    );
  }
  if (picker.mode === 'fixed') {
    return (
      <span className={chip} data-tenant-picker="fixed">
        <span className="text-zinc-500">Organization</span>
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

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        className={`${chip} hover:border-zinc-600`}
        aria-label="Organization"
        aria-haspopup="listbox"
        aria-expanded={open}
        data-tenant-picker="pick"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="text-zinc-500">Organization</span>
        {tenantLabel(picker, current)}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Choose an organization"
          className="absolute right-0 top-full z-50 mt-2 w-64 rounded-md border border-border bg-panel-2 p-1"
          onKeyDown={(event) => {
            if (event.key === 'Escape') setOpen(false);
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the popover opens to search
            autoFocus
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="search organizations…"
            aria-label="search organizations"
            className="mb-1 w-full rounded border border-border bg-transparent px-2 py-1 text-xs text-zinc-200 outline-none"
          />
          <div role="listbox" aria-label="Organizations" className="max-h-72 overflow-y-auto">
            {picker.all && (
              <button
                type="button"
                role="option"
                aria-selected={current === undefined}
                onClick={() => void choose(undefined)}
                className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-panel"
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
                className="flex w-full flex-col rounded px-2 py-1.5 text-left text-xs text-zinc-200 hover:bg-panel"
              >
                <span className="truncate">{t.label}</span>
                {t.label !== t.id && (
                  <span className="mono truncate text-[10px] text-zinc-500">{t.id}</span>
                )}
              </button>
            ))}
            {shown.length === 0 && <p className="px-2 py-1.5 text-xs text-zinc-500">No match.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
