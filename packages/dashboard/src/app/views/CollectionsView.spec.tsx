// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
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

const PAGE: CollectionListResponse = { items: [entry()], nextCursor: null };

function baseClient(overrides: Record<string, unknown> = {}) {
  return {
    collections: vi.fn(async () => PAGE),
    collectionsSummary: vi.fn(async () => ({ collections: [] })),
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
    expect(client.collections).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
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
        expect.objectContaining({ ownerType: 'User', collection: 'avatar', limit: 50 }),
      ),
    );
  });

  it('renders the empty state when nothing matches', async () => {
    const client = baseClient({
      collections: vi.fn(async () => ({ items: [], nextCursor: null }) as CollectionListResponse),
    });
    renderView(<CollectionsView route={{ tab: 'collections' }} />, client);
    await waitFor(() =>
      expect(screen.getByText('No media records match this filter.')).toBeTruthy(),
    );
  });

  it('loads a further page via the cursor', async () => {
    const collections = vi
      .fn()
      .mockResolvedValueOnce({ items: [entry({ id: 'm1', name: 'first' })], nextCursor: 'c2' })
      .mockResolvedValueOnce({ items: [entry({ id: 'm2', name: 'second' })], nextCursor: null });
    renderView(<CollectionsView route={{ tab: 'collections' }} />, {
      collections,
      collectionsSummary: vi.fn(async () => ({ collections: [] })),
    });
    await waitFor(() => expect(screen.getByText('first')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('second')).toBeTruthy());
    expect(collections).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'c2' }));
  });
});
