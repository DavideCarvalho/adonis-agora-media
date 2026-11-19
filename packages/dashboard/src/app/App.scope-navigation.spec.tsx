// @vitest-environment jsdom
import {
  act,
  cleanup,
  configure,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { useQueryState } from 'nuqs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetConsoleCache } from '../agora-kit/console-data';
import { CONFIG_ELEMENT_ID } from '../client/dashboard-client';
import { App } from './App';
import { navigate } from './hash-route';
import { renderView } from './testkit';

configure({ asyncUtilTimeout: 5000 });

function client() {
  return {
    topology: vi.fn(async () => ({ disks: 2, hasUploads: true, actions: false })),
    tenants: vi.fn(async () => ({ mode: 'off', all: false, selected: null, tenants: [] })),
    uploads: vi.fn(async () => ({ data: [] })),
    disks: vi.fn(async () => ({ data: [] })),
    apps: vi.fn(async () => ({
      local: { label: 'Hub' },
      apps: [{ id: 'entre-textos', label: 'Entre Textos' }],
      selected: new URLSearchParams(window.location.search).get('app'),
    })),
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/media');
});

let setCollection: ((v: string) => unknown) | undefined;
/** Exposes a hash-query filter setter, as the Collections view's filters use. */
function Probe() {
  const [, set] = useQueryState('collection', { history: 'push' });
  setCollection = set;
  return null;
}

const nav = () => within(screen.getByRole('navigation', { name: 'Console' }));

describe('the picked app (`?app=`) survives in-console navigation', () => {
  it('through the sidebar', async () => {
    window.history.replaceState(null, '', '/media?app=entre-textos#/uploads');
    renderView(<App />, client() as never);
    await screen.findByRole('button', { name: /^App/ });
    for (const [label, hash] of [
      ['Collections', '#/collections'],
      ['Upload', '#/upload'],
      ['Library', '#/browse'],
    ] as const) {
      fireEvent.click(nav().getByRole('link', { name: label }));
      await waitFor(() => expect(window.location.hash).toBe(hash));
      expect(window.location.search).toBe('?app=entre-textos');
    }
  });

  it('through the ⌘K page commands', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    window.history.replaceState(null, '', '/media?app=entre-textos#/uploads');
    renderView(<App />, client() as never);
    await screen.findByRole('button', { name: /^App/ });
    // jsdom has no scrollIntoView, which cmdk calls on the active item.
    Element.prototype.scrollIntoView ??= () => undefined;
    act(() => {
      fireEvent.keyDown(document, { key: 'k', metaKey: true });
    });
    fireEvent.click(await screen.findByRole('option', { name: /^Collections/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/collections'));
    expect(window.location.search).toBe('?app=entre-textos');
  });

  it('through detail navigation', () => {
    window.history.replaceState(null, '', '/media?app=entre-textos#/collections');
    navigate({ tab: 'collections', recordId: 'm1' });
    expect(window.location.hash).toBe('#/collections/m1');
    expect(window.location.search).toBe('?app=entre-textos');
    navigate({ tab: 'browse', disk: 's3', prefix: 'avatars/' });
    expect(window.location.search).toBe('?app=entre-textos');
  });

  it('through the filters (nuqs writes into the hash)', async () => {
    window.history.replaceState(null, '', '/media?app=entre-textos#/collections');
    renderView(<Probe />, {});
    act(() => {
      void setCollection?.('avatar');
    });
    await waitFor(() => expect(window.location.hash).toBe('#/collections?collection=avatar'));
    expect(window.location.search).toBe('?app=entre-textos');
  });

  it('into the console switcher right after an organization pick', async () => {
    resetConsoleCache();
    const block = document.createElement('script');
    block.type = 'application/json';
    block.id = CONFIG_ELEMENT_ID;
    block.textContent = JSON.stringify({ switcher: { endpoint: '/x/api/consoles', others: 1 } });
    document.head.appendChild(block);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 1,
              current: 'x',
              consoles: [
                { id: 'telescope', title: 'Telescope', icon: 'telescope', href: '/telescope' },
              ],
            }),
          ),
      ),
    );
    try {
      window.history.replaceState(null, '', '/media#/uploads');
      renderView(<App />, {
        ...client(),
        apps: vi.fn(async () => ({ local: { label: 'Hub' }, apps: [], selected: null })),
        tenants: vi.fn(async () => ({
          mode: 'pick',
          all: true,
          selected: null,
          tenants: [
            { id: 'org-1', label: 'Acme' },
            { id: 'org-2', label: 'Globex' },
          ],
        })),
        selectTenant: vi.fn(async () => undefined),
      } as never);
      fireEvent.click(await screen.findByRole('button', { name: /^Organization/ }));
      fireEvent.mouseDown(await screen.findByRole('option', { name: /Globex/ }));
      await waitFor(() => expect(window.location.search).toBe('?tenant=org-2'));
      await act(async () => {
        fireEvent.click(await screen.findByRole('button', { name: /switch console/ }));
      });
      const link = (await screen.findAllByRole('menuitem')).find((el) => el.tagName === 'A');
      await waitFor(() => expect(link?.getAttribute('href')).toBe('/telescope?tenant=org-2'));
    } finally {
      block.remove();
    }
  });
});
