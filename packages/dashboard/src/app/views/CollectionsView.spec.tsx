// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CollectionListResponse, MediaEntry } from '../../types';
import { renderView } from '../testkit';
import { CollectionsView, RecordDetailBody } from './CollectionsView';

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
    // The collection field is a creatable combobox: a key the summary lacks is typed and picked.
    const collection = screen.getByLabelText('Collection');
    fireEvent.keyDown(collection, { key: 'ArrowDown' });
    fireEvent.change(collection, { target: { value: 'avatar' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Use “avatar”' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(client.collections).toHaveBeenCalledWith(
        expect.objectContaining({ ownerType: 'User', collection: 'avatar', first: 50 }),
      ),
    );
  });

  it('offers the summary collections in the collection field', async () => {
    const client = baseClient({
      collectionsSummary: vi.fn(async () => ({
        data: [
          { key: 'gallery', count: 3, sumSize: 4096 },
          { key: 'avatars', count: 1, sumSize: 512 },
        ],
      })),
    });
    renderView(<CollectionsView route={{ tab: 'collections' }} />, client);
    await waitFor(() => expect(screen.getByText('sunset')).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('button', { name: /avatars/ })).toBeTruthy());

    const collection = screen.getByLabelText('Collection');
    fireEvent.keyDown(collection, { key: 'ArrowDown' });
    fireEvent.change(collection, { target: { value: 'ava' } });
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
        'avatars',
        'Use “ava”',
      ]),
    );
    fireEvent.click(screen.getByRole('option', { name: 'avatars' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(window.location.hash).toContain('collection=avatars'));
    await waitFor(() =>
      expect(client.collections).toHaveBeenLastCalledWith(
        expect.objectContaining({ collection: 'avatars' }),
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

describe('CollectionsView: timestamps', () => {
  it('lists a Created column with the full timestamp in the title', async () => {
    renderView(<CollectionsView route={{ tab: 'collections' }} />, baseClient());
    await waitFor(() => expect(screen.getByText('sunset')).toBeTruthy());
    expect(screen.getByRole('columnheader', { name: 'Created' })).toBeTruthy();
    const cell = screen.getByText('2026-07-13 10:00');
    expect(cell.getAttribute('title')).toBe(new Date('2026-07-13T10:00:00.000Z').toLocaleString());
  });

  it('shows Created and Updated on the record detail', () => {
    renderView(
      <RecordDetailBody
        detail={{ record: entry(), variants: [] }}
        deleting={false}
        deleteError={undefined}
        onDelete={() => undefined}
      />,
      {},
    );
    expect(screen.getByText('Created')).toBeTruthy();
    expect(screen.getByText('Updated')).toBeTruthy();
    expect(screen.getByText('2026-07-13 10:00')).toBeTruthy();
    expect(screen.getByText('2026-07-13 11:00')).toBeTruthy();
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
    expect((screen.getByLabelText('Collection') as HTMLInputElement).value).toBe('gallery');
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
