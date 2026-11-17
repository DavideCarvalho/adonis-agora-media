import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { withScope } from '../client/dashboard-client';
import type { AppPickerResponse, Topology } from '../types';
import { AppPickerControl } from './AppPicker';
import { renderView } from './testkit';
import { UploadPanel } from './views/UploadPanel';

const picker = (apps: AppPickerResponse['apps']): AppPickerResponse => ({
  local: { label: 'Hub' },
  apps,
  selected: null,
});

describe('AppPickerControl (federated console)', () => {
  it('renders nothing when the console shows only this app', async () => {
    const apps = vi.fn(async () => picker([]));
    renderView(<AppPickerControl />, { apps });
    await waitFor(() => expect(apps).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'App' })).toBeNull();
  });

  it('puts the picked app in the URL, drops the old folder, and scopes every API call', async () => {
    window.history.replaceState(null, '', '/media#/browse/s3?prefix=avatars%2F');
    renderView(<AppPickerControl />, {
      apps: async () => picker([{ id: 'entre-textos', label: 'Entre Textos' }]),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'App' }));
    fireEvent.click(await screen.findByRole('option', { name: /Entre Textos/ }));
    await waitFor(() => expect(window.location.search).toBe('?app=entre-textos'));
    expect(window.location.hash).toBe('#/browse');
    expect(withScope('/api/collections?first=50')).toBe(
      '/api/collections?first=50&app=entre-textos',
    );
    // Already scoped (an object's raw URL): not twice.
    expect(withScope('/api/object/raw?disk=s3&app=entre-textos')).toBe(
      '/api/object/raw?disk=s3&app=entre-textos',
    );

    fireEvent.click(await screen.findByRole('button', { name: 'App' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Hub' }));
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(withScope('/api/collections')).toBe('/api/collections');
  });
});

describe('AppPickerControl follows the server and the URL', () => {
  /** A server that answers `selected` from the URL, granting only `entre-textos`. */
  const server = () =>
    vi.fn(async (): Promise<AppPickerResponse> => {
      const app = new URLSearchParams(window.location.search).get('app');
      return {
        local: { label: 'Hub' },
        apps: [{ id: 'entre-textos', label: 'Entre Textos' }],
        selected: app === 'entre-textos' ? app : null,
      };
    });

  it("shows the server's app, not a forged `?app=` it does not serve", async () => {
    window.history.replaceState(null, '', '/media?app=forged#/browse');
    renderView(<AppPickerControl />, { apps: server() });
    const trigger = await screen.findByRole('button', { name: 'App' });
    await waitFor(() => expect(trigger.textContent).toContain('Hub'));
    expect(trigger.textContent).not.toContain('forged');
  });

  it('follows back/forward', async () => {
    window.history.replaceState(null, '', '/media#/browse');
    const apps = server();
    renderView(<AppPickerControl />, { apps });
    const trigger = await screen.findByRole('button', { name: 'App' });
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole('option', { name: /Entre Textos/ }));
    await waitFor(() => expect(trigger.textContent).toContain('Entre Textos'));

    // "Back": the URL is this app's again, and the browser says so with a popstate.
    act(() => {
      window.history.replaceState(null, '', '/media#/browse');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(trigger.textContent).toContain('Hub'));
    // "Forward".
    act(() => {
      window.history.replaceState(null, '', '/media?app=entre-textos#/browse');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await waitFor(() => expect(trigger.textContent).toContain('Entre Textos'));
    window.history.replaceState(null, '', '/media');
  });
});

describe('UploadPanel for another app', () => {
  it('does not offer an upload into another app', async () => {
    const topology = async (): Promise<Topology> => ({
      disks: 1,
      hasUploads: true,
      actions: true,
      app: 'entre-textos',
    });
    renderView(<UploadPanel />, { topology, disks: async () => ({ data: [] }) });
    expect(await screen.findByText(/Uploads into another app happen in that app/)).toBeTruthy();
  });
});
