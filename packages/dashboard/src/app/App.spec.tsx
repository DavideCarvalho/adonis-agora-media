// @vitest-environment jsdom
import { cleanup, configure, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { renderView } from './testkit';

configure({ asyncUtilTimeout: 5000 });

function client() {
  return {
    topology: vi.fn(async () => ({ disks: 2, hasUploads: true, actions: false })),
    tenants: vi.fn(async () => ({ mode: 'off', all: false, selected: null, tenants: [] })),
    uploads: vi.fn(async () => ({ data: [] })),
    disks: vi.fn(async () => ({ data: [] })),
  };
}

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('App shell', () => {
  it('groups the pages as LIBRARY and TRANSFERS in the sidebar', () => {
    renderView(<App />, client());
    const nav = within(screen.getByRole('navigation', { name: 'Console' }));
    expect(
      nav.getByText('Library', {
        selector: '[data-sidebar=group-label], [data-slot=sidebar-group-label]',
      }),
    ).toBeTruthy();
    expect(
      nav.getByText('Transfers', {
        selector: '[data-sidebar=group-label], [data-slot=sidebar-group-label]',
      }),
    ).toBeTruthy();
    for (const label of ['Collections', 'Uploads', 'Upload']) {
      expect(nav.getByRole('link', { name: label })).toBeTruthy();
    }
  });

  it('marks the routed page active and titles the topbar with it', async () => {
    window.location.hash = '#/uploads';
    renderView(<App />, client());
    const nav = within(screen.getByRole('navigation', { name: 'Console' }));
    expect(nav.getByRole('link', { name: 'Uploads' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => expect(screen.getByText('No resumable uploads in progress.')).toBeTruthy());
  });

  it('an app with no storage of its own says so and offers the apps the console shows', async () => {
    const c = {
      ...client(),
      topology: vi.fn(async () => ({
        disks: 0,
        hasUploads: false,
        actions: false,
        storage: false,
      })),
      apps: vi.fn(async () => ({
        local: { label: 'Hub' },
        apps: [{ id: 'entre-textos', label: 'Entre Textos' }],
        selected: null,
      })),
    };
    renderView(<App />, c);
    await waitFor(() => expect(screen.getByText('Hub has no media of its own')).toBeTruthy());
    expect(c.disks).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'Entre Textos' }).click();
    expect(new URL(window.location.href).searchParams.get('app')).toBe('entre-textos');
    window.history.replaceState(null, '', window.location.pathname);
  });

  it('puts the deployment pills in the topbar', async () => {
    renderView(<App />, client());
    await waitFor(() => expect(screen.getByText('2 disks')).toBeTruthy());
    expect(screen.getByTitle('Read-only console')).toBeTruthy();
  });
});
