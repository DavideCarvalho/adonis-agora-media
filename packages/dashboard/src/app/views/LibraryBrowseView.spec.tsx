// @vitest-environment jsdom
import { configure, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiskListResponse, ObjectListResponse, Topology } from '../../types';
import { renderView } from '../testkit';
import { LibraryBrowseView } from './LibraryBrowseView';

const DISKS: DiskListResponse = {
  data: [
    {
      name: 's3',
      default: true,
      capabilities: { presign: true, multipart: true, publicUrls: true, list: true },
    },
  ],
};
const TOPOLOGY: Topology = { disks: 1, hasUploads: true, actions: true };
const OBJECTS: ObjectListResponse = {
  data: [
    { type: 'folder', name: '2024', prefix: 'photos/2024/' },
    {
      type: 'file',
      key: 'a.txt',
      name: 'a.txt',
      sizeBytes: 12,
      lastModified: '2026-07-13T10:00:00.000Z',
    },
  ],
  meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
};

function baseClient(overrides: Record<string, unknown> = {}) {
  return {
    disks: vi.fn(async () => DISKS),
    topology: vi.fn(async () => TOPOLOGY),
    objects: vi.fn(async () => OBJECTS),
    copy: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    ...overrides,
  };
}

// The first render pulls in the whole kit (Base UI menu, dialog, table); give a cold, busy worker
// more than the default second to settle.
configure({ asyncUtilTimeout: 5000 });

/** Open a row's "…" menu and pick an item from it. */
async function rowAction(name: string, action: string): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }));
  fireEvent.click(await screen.findByRole('menuitem', { name: action }));
}

describe('LibraryBrowseView', () => {
  it('lists folders and files for the default disk', async () => {
    const client = baseClient();
    renderView(<LibraryBrowseView />, client);
    await waitFor(() => expect(screen.getByText('2024')).toBeTruthy());
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(client.objects).toHaveBeenCalledWith('s3', expect.objectContaining({ first: 50 }));
  });

  it('copies an object across a chosen destination key', async () => {
    const client = baseClient();
    renderView(<LibraryBrowseView />, client);
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy());
    await rowAction('a.txt', 'Copy to…');
    const nameInput = (await screen.findByLabelText('Name')) as HTMLInputElement;
    expect(nameInput.value).toBe('a.txt');
    fireEvent.change(nameInput, { target: { value: 'copies/a.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    await waitFor(() =>
      expect(client.copy).toHaveBeenCalledWith({
        disk: 's3',
        from: 'a.txt',
        to: 'copies/a.txt',
        toDisk: 's3',
      }),
    );
  });

  it('deletes an object after confirmation', async () => {
    const client = baseClient();
    renderView(<LibraryBrowseView />, client);
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy());
    await rowAction('a.txt', 'Delete');
    // The row-level Delete lives in the "…" menu, so the only Delete button is the dialog's.
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(client.remove).toHaveBeenCalledWith({ disk: 's3', keys: ['a.txt'] }),
    );
  });

  it('hides row actions when the console is read-only', async () => {
    const client = baseClient({ topology: vi.fn(async () => ({ ...TOPOLOGY, actions: false })) });
    renderView(<LibraryBrowseView />, client);
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy());
    // The file row keeps Preview and "Copy key"; the folder row has no menu at all.
    expect(screen.queryByRole('button', { name: 'Actions for 2024' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for a.txt' }));
    expect(await screen.findByRole('menuitem', { name: 'Copy key' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Copy to…' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });
});
