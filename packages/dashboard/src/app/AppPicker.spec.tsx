import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { withScope } from '../client/dashboard-client';
import type { AppPickerResponse, Topology } from '../types';
import { AppPickerControl, SelectedAppNotice } from './AppPicker';
import { renderView } from './testkit';
import { RecordDetailBody } from './views/CollectionsView';
import { LibraryBrowseView } from './views/LibraryBrowseView';
import { UploadPanel } from './views/UploadPanel';
import { UploadDetailBody } from './views/UploadsView';

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

describe('federated apps in the picker', () => {
  /** A server answering `selected` from the URL, with one federated app per actions mode. */
  const server = () =>
    vi.fn(async (): Promise<AppPickerResponse> => {
      const app = new URLSearchParams(window.location.search).get('app');
      return {
        local: { label: 'Hub' },
        apps: [
          { id: 'entre-textos', label: 'Entre Textos', mode: 'federated', actions: 'app' },
          { id: 'eduliberta', label: 'EduLiberta', mode: 'federated', actions: 'none' },
        ],
        selected: app === 'entre-textos' || app === 'eduliberta' ? app : null,
      };
    });

  it('badges each federated app, in the list and on the trigger', async () => {
    window.history.replaceState(null, '', '/media?app=eduliberta#/browse');
    renderView(<AppPickerControl />, { apps: server() });
    const trigger = await screen.findByRole('button', { name: 'App' });
    await waitFor(() => expect(trigger.querySelector('[data-app-mode="federated"]')).toBeTruthy());
    expect(trigger.querySelector('[data-app-mode]')?.getAttribute('title')).toContain(
      'Read-only here',
    );
    fireEvent.click(trigger);
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.querySelector('[data-app-mode]') !== null)).toEqual([
      false,
      true,
      true,
    ]);
    window.history.replaceState(null, '', '/media');
  });

  it('notices a federated app at the top of the page, saying who runs the actions', async () => {
    window.history.replaceState(null, '', '/media?app=entre-textos#/browse');
    renderView(<SelectedAppNotice />, { apps: server() });
    const note = await screen.findByRole('note');
    expect(note.textContent).toContain("reads Entre Textos's data");
    expect(note.textContent).toContain('Actions are sent to Entre Textos');
    window.history.replaceState(null, '', '/media');
  });

  it('shows no notice for this app', async () => {
    window.history.replaceState(null, '', '/media#/browse');
    const apps = server();
    renderView(<SelectedAppNotice />, { apps });
    await waitFor(() => expect(apps).toHaveBeenCalled());
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('shows the actions of a read-only federated app disabled, with why', async () => {
    window.history.replaceState(null, '', '/media?app=eduliberta#/browse');
    renderView(<LibraryBrowseView />, {
      apps: server(),
      topology: async (): Promise<Topology> => ({
        disks: 1,
        hasUploads: false,
        actions: false,
        app: 'eduliberta',
      }),
      disks: async () => ({
        data: [
          {
            name: 's3',
            driver: 's3',
            default: true,
            capabilities: { list: true, presign: true, multipart: false, publicUrls: false },
          },
        ],
      }),
      objects: async () => ({
        folders: [],
        data: [],
        meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
      }),
    } as never);
    const button = await screen.findByRole('button', { name: /New folder/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.parentElement?.getAttribute('title')).toContain('read-only here');
    window.history.replaceState(null, '', '/media');
  });

  it('disables record delete and upload cancel with the reason it is given', () => {
    const reason = 'EduLiberta is federated and read-only here: change it in EduLiberta itself.';
    renderView(
      <>
        <RecordDetailBody
          detail={{
            record: {
              id: 'm1',
              ownerType: 'Post',
              ownerId: '1',
              collection: 'gallery',
              name: 'a',
              fileName: 'a.png',
              mimeType: 'image/png',
              sizeBytes: 1,
              disk: 's3',
              path: 'a.png',
              conversions: [],
              createdAt: '2026-11-18T00:00:00.000Z',
              updatedAt: '2026-11-18T00:00:00.000Z',
            },
            variants: [],
          }}
          deleting={false}
          deleteError={undefined}
          onDelete={() => undefined}
          unavailable={reason}
        />
        <UploadDetailBody
          detail={{
            upload: {
              id: 'u1',
              key: 'k',
              disk: 's3',
              offset: 0,
              size: 10,
              percent: 0,
              multipart: false,
            } as never,
            parts: [],
          }}
          actions={false}
          canceling={false}
          cancelFailed={false}
          onCancel={() => undefined}
          unavailable={reason}
        />
      </>,
      {},
    );
    const del = screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement;
    const cancel = screen.getByRole('button', { name: 'Cancel session' }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);
    expect(del.parentElement?.getAttribute('title')).toBe(reason);
    expect(cancel.parentElement?.getAttribute('title')).toBe(reason);
  });
});
