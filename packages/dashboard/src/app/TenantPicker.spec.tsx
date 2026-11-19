import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withScope } from '../client/dashboard-client';
import type { TenantPickerResponse } from '../types';
import { TenantPickerControl } from './TenantPicker';
import { renderView } from './testkit';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/media');
});

const tenants = (over: Partial<TenantPickerResponse>) =>
  vi.fn(
    async (): Promise<TenantPickerResponse> => ({
      mode: 'pick',
      all: true,
      selected: null,
      tenants: [
        { id: 'org-1', label: 'Acme' },
        { id: 'org-2', label: 'Globex' },
      ],
      ...over,
    }),
  );

describe('TenantPickerControl', () => {
  it('renders nothing with tenancy off', async () => {
    const fetch = tenants({ mode: 'off', tenants: [] });
    renderView(<TenantPickerControl />, { tenants: fetch });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(document.querySelector('[data-tenant-chip]')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows a chip for one organization, and "none" for a viewer without one', async () => {
    renderView(<TenantPickerControl />, {
      tenants: tenants({ mode: 'fixed', all: false, tenants: [{ id: 'org-1', label: 'Acme' }] }),
    });
    await waitFor(() =>
      expect(document.querySelector('[data-tenant-chip]')?.textContent).toBe('OrganizationAcme'),
    );
    expect(screen.queryByRole('button')).toBeNull();
    cleanup();
    renderView(<TenantPickerControl />, {
      tenants: tenants({ mode: 'none', all: false, tenants: [] }),
    });
    await waitFor(() =>
      expect(document.querySelector('[data-tenant-chip]')?.textContent).toBe('Organizationnone'),
    );
  });

  it('lists "All organizations" first, searches, and records a pick in the URL', async () => {
    const selectTenant = vi.fn(async (id: string) => ({ tenant: id }));
    renderView(<TenantPickerControl />, { tenants: tenants({}), selectTenant } as never);
    const trigger = await screen.findByRole('button', { name: /^Organization/ });
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.textContent).toContain('All organizations');
    fireEvent.click(trigger);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'All organizations',
      'Acmeorg-1',
      'Globexorg-2',
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Search organizations' }), {
      target: { value: 'glo' },
    });
    fireEvent.mouseDown(screen.getByRole('option', { name: /Globex/ }));
    await waitFor(() => expect(selectTenant).toHaveBeenCalledWith('org-2'));
    await waitFor(() => expect(window.location.search).toBe('?tenant=org-2'));
    await waitFor(() => expect(trigger.textContent).toContain('Globex'));
    expect(withScope('/api/collections')).toBe('/api/collections?tenant=org-2');
  });
});
