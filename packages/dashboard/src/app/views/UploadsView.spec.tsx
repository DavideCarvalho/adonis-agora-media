// @vitest-environment jsdom
import { cleanup, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UploadInfo } from '../../types';
import { renderView } from '../testkit';
import { UploadDetailBody, UploadsView } from './UploadsView';

describe('UploadsView', () => {
  it('renders in-progress upload sessions from the client', async () => {
    const client = {
      uploads: vi.fn(async () => ({
        data: [
          {
            id: 'u1',
            disk: 's3',
            key: 'videos/big.mp4',
            offset: 50,
            size: 100,
            percent: 50,
            parts: 3,
            multipart: true,
            createdAt: new Date().toISOString(),
          },
        ],
      })),
    };
    renderView(<UploadsView route={{ tab: 'uploads' }} />, client);
    await waitFor(() => expect(screen.getByText('videos/big.mp4')).toBeTruthy());
    expect(screen.getByText(/50% ·/)).toBeTruthy();
    expect(client.uploads).toHaveBeenCalled();
  });

  it('shows an empty state when there are no sessions', async () => {
    const client = { uploads: vi.fn(async () => ({ data: [] })) };
    renderView(<UploadsView route={{ tab: 'uploads' }} />, client);
    await waitFor(() => expect(screen.getByText('No resumable uploads in progress.')).toBeTruthy());
  });

  it('shows Created and Updated on the session detail (— when unknown)', () => {
    const upload: UploadInfo = {
      id: 'u1',
      disk: 's3',
      key: 'k',
      offset: 0,
      size: 10,
      percent: 0,
      parts: 0,
      multipart: false,
      createdAt: '2026-07-13T10:00:00.000Z',
      updatedAt: null,
    };
    const props = {
      actions: false,
      canceling: false,
      cancelFailed: false,
      onCancel: () => undefined,
    };
    renderView(<UploadDetailBody detail={{ upload, parts: [] }} {...props} />, {});
    expect(screen.getByText('Created')).toBeTruthy();
    expect(screen.getByText('Updated')).toBeTruthy();
    expect(screen.getByText('2026-07-13 10:00').getAttribute('title')).toBe(
      new Date('2026-07-13T10:00:00.000Z').toLocaleString(),
    );
    expect(screen.getByText('—')).toBeTruthy();
    cleanup();

    renderView(
      <UploadDetailBody
        detail={{ upload: { ...upload, updatedAt: '2026-07-13T10:05:00.000Z' }, parts: [] }}
        {...props}
      />,
      {},
    );
    expect(screen.getByText('2026-07-13 10:05')).toBeTruthy();
  });
});
