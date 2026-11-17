// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CollectionListResponse, MediaEntry } from '../../types';
import { renderView } from '../testkit';
import { CollectionsView } from './CollectionsView';

function entry(over: Partial<MediaEntry> = {}): MediaEntry {
  return {
    id: 'm1',
    ownerType: 'Post',
    ownerId: '42',
    collection: 'gallery',
    name: 'sunset',
    fileName: 'sunset.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 2048,
    disk: 's3',
    path: 'Post/42/gallery/m1/sunset.jpg',
    conversions: ['thumb'],
    createdAt: '2026-07-13T10:00:00.000Z',
    updatedAt: '2026-07-13T11:00:00.000Z',
    ...over,
  };
}

const PAGE: CollectionListResponse = {
  data: [entry()],
  meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
};

function baseClient(overrides: Record<string, unknown> = {}) {
  return {
    collections: vi.fn(async () => PAGE),
    collectionsSummary: vi.fn(async () => ({ data: [] })),
    topology: vi.fn(async () => ({ disks: 1, hasUploads: false, actions: true })),
    ...overrides,
  };
}

describe('CollectionsView', () => {
  it('lists stored records with owner, collection and conversion chips', async () => {
    const client = baseClient();
    renderView(<CollectionsView route={{ tab: 'collections' }} />, client);
    await waitFor(() => expect(screen.getByText('sunset')).toBeTruthy());
    expect(screen.getByText('gallery')).toBeTruthy();
    expect(screen.getByText('thumb')).toBeTruthy();
    expect(screen.getByText('Post/42/gallery/m1/sunset.jpg')).toBeTruthy();
    expect(client.collections).toHaveBeenCalledWith(expect.objectContaining({ first: 50 }));
  });

  it('applies the owner/collection filters on submit', async () => {
    const client = baseClient();
    renderView(<CollectionsView route={{ tab: 'collections' }} />, client);
    await waitFor(() => expect(screen.getByText('sunset')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Owner type'), { target: { value: 'User' } });
    fireEvent.change(screen.getByLabelText('Collection'), { target: { value: 'avatar' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(client.collections).toHaveBeenCalledWith(
        expect.objectContaining({ ownerType: 'User', collection: 'avatar', first: 50 }),
      ),
    );
  });

  it('renders the empty state when nothing matches', async () => {
    const client = baseClient({
      collections: vi.fn(
        async () =>
          ({
            data: [],
            meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
          }) as CollectionListResponse,
      ),
    });
    renderView(<CollectionsView route={{ tab: 'collections' }} />, client);
    await waitFor(() =>
      expect(screen.getByText('No media records match this filter.')).toBeTruthy(),
    );
  });

  it('loads a further page via the cursor', async () => {
    const collections = vi
      .fn()
      .mockResolvedValueOnce({
        data: [entry({ id: 'm1', name: 'first' })],
        meta: { nextCursor: 'c2', prevCursor: null, hasNext: true, hasPrev: false },
      })
      .mockResolvedValueOnce({
        data: [entry({ id: 'm2', name: 'second' })],
        meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
      });
    renderView(<CollectionsView route={{ tab: 'collections' }} />, {
      collections,
      collectionsSummary: vi.fn(async () => ({ data: [] })),
    });
    await waitFor(() => expect(screen.getByText('first')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('second')).toBeTruthy());
    expect(collections).toHaveBeenLastCalledWith(expect.objectContaining({ after: 'c2' }));
  });
});

describe('CollectionsView: filters in the URL', () => {
  it('opens filtered from a shared link, the form showing the applied filter', async () => {
    window.history.replaceState(
      null,
      '',
      '/media#/collections?collection=gallery&ownerType=Post&keyPrefix=Post%2F42',
    );
    const client = baseClient();
    renderView(<CollectionsView route={{ tab: 'collections', collection: 'gallery' }} />, client);
    await waitFor(() =>
      expect(client.collections).toHaveBeenCalledWith(
        expect.objectContaining({ collection: 'gallery', ownerType: 'Post', prefix: 'Post/42' }),
      ),
    );
    expect((screen.getByLabelText('Owner type') as HTMLInputElement).value).toBe('Post');
    expect((screen.getByLabelText('Path prefix') as HTMLInputElement).value).toBe('Post/42');
  });

  it('applying writes the URL (keeping the page path); back restores the previous filter', async () => {
    window.history.replaceState(null, '', '/media?tenant=acme#/collections');
    const client = baseClient();
    renderView(<CollectionsView route={{ tab: 'collections' }} />, client);
    await waitFor(() => expect(screen.getByText('sunset')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Owner type'), { target: { value: 'User' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(window.location.hash).toBe('#/collections?ownerType=User'));
    expect(window.location.search).toBe('?tenant=acme');

    fireEvent.change(screen.getByLabelText('Owner id'), { target: { value: '42' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(window.location.hash).toBe('#/collections?ownerType=User&ownerId=42'),
    );

    act(() => window.history.back());
    await waitFor(() => expect(window.location.hash).toBe('#/collections?ownerType=User'));
    await waitFor(() =>
      expect((screen.getByLabelText('Owner id') as HTMLInputElement).value).toBe(''),
    );
    expect(client.collections).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ ownerId: '42' }),
    );
  });

  it('reset takes every filter out of the URL', async () => {
    window.history.replaceState(null, '', '/media#/collections?collection=gallery&ownerId=42');
    renderView(
      <CollectionsView route={{ tab: 'collections', collection: 'gallery' }} />,
      baseClient(),
    );
    await waitFor(() => expect(screen.getByText('sunset')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(window.location.hash).toBe('#/collections'));
  });
});
