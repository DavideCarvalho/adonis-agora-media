// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderView } from '../testkit';
import { UploadsView } from './UploadsView';

describe('UploadsView', () => {
  it('renders in-progress upload sessions from the client', async () => {
    const client = {
      uploads: vi.fn(async () => ({
        uploads: [
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
    renderView(<UploadsView />, client);
    await waitFor(() => expect(screen.getByText('videos/big.mp4')).toBeTruthy());
    expect(screen.getByText(/50% ·/)).toBeTruthy();
    expect(client.uploads).toHaveBeenCalled();
  });

  it('shows an empty state when there are no sessions', async () => {
    const client = { uploads: vi.fn(async () => ({ uploads: [] })) };
    renderView(<UploadsView />, client);
    await waitFor(() => expect(screen.getByText('No resumable uploads in progress.')).toBeTruthy());
  });
});
