// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiskListResponse, ObjectListResponse, Topology } from '../../types';
import { renderView } from '../testkit';
import { LibraryBrowseView } from './LibraryBrowseView';

const DISKS: DiskListResponse = {
  disks: [
    {
      name: 's3',
      default: true,
      capabilities: { presign: true, multipart: true, publicUrls: true, list: true },
    },
  ],
};
const TOPOLOGY: Topology = { disks: 1, hasUploads: true, actions: true };
const OBJECTS: ObjectListResponse = {
  folders: [{ name: '2024', prefix: 'photos/2024/' }],
  files: [{ key: 'a.txt', name: 'a.txt', sizeBytes: 12, lastModified: '2026-07-13T10:00:00.000Z' }],
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

describe('LibraryBrowseView', () => {
  it('lists folders and files for the default disk', async () => {
    const client = baseClient();
    renderView(<LibraryBrowseView />, client);
    await waitFor(() => expect(screen.getByText('2024')).toBeTruthy());
    expect(screen.getByText('a.txt')).toBeTruthy();
    expect(client.objects).toHaveBeenCalledWith('s3', expect.objectContaining({ limit: 50 }));
  });

  it('copies an object across a chosen destination key', async () => {
    const client = baseClient();
    renderView(<LibraryBrowseView />, client);
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy());
    const fileRow = within(screen.getByText('a.txt').closest('tr') as HTMLElement);

    fireEvent.click(fileRow.getByRole('button', { name: 'Copy to…' }));
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
    const fileRow = within(screen.getByText('a.txt').closest('tr') as HTMLElement);

    fireEvent.click(fileRow.getByRole('button', { name: 'Delete' }));
    // The confirm dialog's own "Delete" button is the last on the page (the two row-level "Delete"
    // buttons — folder and file — plus the dialog's).
    const confirmButtons = await screen.findAllByRole('button', { name: 'Delete' });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);

    await waitFor(() =>
      expect(client.remove).toHaveBeenCalledWith({ disk: 's3', keys: ['a.txt'] }),
    );
  });

  it('hides row actions when the console is read-only', async () => {
    const client = baseClient({ topology: vi.fn(async () => ({ ...TOPOLOGY, actions: false })) });
    renderView(<LibraryBrowseView />, client);
    await waitFor(() => expect(screen.getByText('a.txt')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Copy to…' })).toBeNull();
  });
});
