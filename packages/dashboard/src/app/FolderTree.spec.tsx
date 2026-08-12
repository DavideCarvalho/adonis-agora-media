// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DiskInfo } from '../types';
import { FolderTree } from './FolderTree';
import { renderView } from './testkit';

const DISKS: DiskInfo[] = [
  {
    name: 's3',
    default: true,
    capabilities: { presign: true, multipart: true, publicUrls: true, list: true },
  },
  {
    name: 'backup',
    default: false,
    capabilities: { presign: false, multipart: false, publicUrls: false, list: false },
  },
];

describe('FolderTree', () => {
  it('renders every disk root and marks the unlistable one', () => {
    const client = { objects: vi.fn(async () => ({ folders: [], files: [] })) };
    renderView(
      <FolderTree disks={DISKS} selectedDisk="s3" currentPrefix={undefined} onNavigate={vi.fn()} />,
      client,
    );
    expect(screen.getByText('s3')).toBeTruthy();
    expect(screen.getByText('backup')).toBeTruthy();
    expect(screen.getByText('default')).toBeTruthy();
  });

  it('fetches and renders sub-folders once a node expands', async () => {
    const client = {
      objects: vi.fn(async () => ({
        folders: [{ name: '2024', prefix: 'photos/2024/' }],
        files: [],
      })),
    };
    renderView(
      <FolderTree disks={DISKS} selectedDisk="s3" currentPrefix={undefined} onNavigate={vi.fn()} />,
      client,
    );
    // The selected disk's root starts expanded, so its children are fetched without a click.
    await waitFor(() => expect(screen.getByText('2024')).toBeTruthy());
    expect(client.objects).toHaveBeenCalledWith('s3', {});
  });

  it('navigates when a disk root is clicked', () => {
    const client = { objects: vi.fn(async () => ({ folders: [], files: [] })) };
    const onNavigate = vi.fn();
    renderView(
      <FolderTree
        disks={DISKS}
        selectedDisk={undefined}
        currentPrefix={undefined}
        onNavigate={onNavigate}
      />,
      client,
    );
    fireEvent.click(screen.getByText('s3'));
    expect(onNavigate).toHaveBeenCalledWith('s3', '');
  });
});
