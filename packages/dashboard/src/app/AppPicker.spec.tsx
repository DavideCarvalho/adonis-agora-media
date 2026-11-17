import { fireEvent, screen, waitFor } from '@testing-library/react';
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
