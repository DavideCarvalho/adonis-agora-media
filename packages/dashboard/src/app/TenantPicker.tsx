import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ScopeChip, ScopeMenu } from '../agora-kit/blocks/scope-menu';
import { selectedTenant } from '../client/dashboard-client';
import type { TenantPickerResponse } from '../types';
import { useDashboard } from './context';

/** Put the picked organization in the URL (`?tenant=`, absent = all), keeping the hash route. */
function writeTenantToUrl(tenant: string | undefined): void {
  const url = new URL(window.location.href);
  if (tenant === undefined) url.searchParams.delete('tenant');
  else url.searchParams.set('tenant', tenant);
  window.history.pushState(null, '', url.toString());
  // A pushState fires nothing: tell the shell and the URL-state adapter the URL moved.
  window.dispatchEvent(new PopStateEvent('popstate'));
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

const TENANT_TEXT = {
  noun: 'Organization',
  all: 'All organizations',
  some: 'Every organization you can see',
  search: 'Search organizations',
  empty: 'No organizations.',
};

/**
 * The topbar's "Organization" control (tenancy on), in the kit's look: a fixed chip for one
 * organization (or "none"), a searchable `ScopeMenu` for several ("All organizations" first when
 * the viewer may see every one). Nothing when tenancy is off.
 */
export function TenantPickerControl() {
  const picker = useTenantPicker();
  const { client } = useDashboard();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState(selectedTenant);

  if (!picker || picker.mode === 'off') return null;

  if (picker.mode === 'none' || picker.mode === 'fixed') {
    if (picker.mode === 'none') {
      return (
        <span title="Choose an organization in the app to see its files">
          <ScopeChip noun={TENANT_TEXT.noun} label="none" kind="tenant" />
        </span>
      );
    }
    const only = picker.tenants[0];
    return <ScopeChip noun={TENANT_TEXT.noun} label={only ? only.label : 'none'} kind="tenant" />;
  }

  const choose = async (tenant: string | undefined) => {
    await client.selectTenant(tenant ?? '*').catch(() => undefined);
    writeTenantToUrl(tenant);
    setCurrent(tenant);
    await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'tenants' });
  };

  return (
    <ScopeMenu
      items={picker.tenants}
      all={picker.all}
      current={current}
      text={TENANT_TEXT}
      labelOf={(id) => tenantLabel(picker, id)}
      onChoose={(next) => void choose(next)}
    />
  );
}
