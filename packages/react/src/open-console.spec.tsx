// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OpenMediaDashboardButton } from './open-console-button.js';

describe('OpenMediaDashboardButton', () => {
  it('mints a session and navigates on click', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const navigate = vi.fn();
    render(<OpenMediaDashboardButton fetch={fetchImpl} navigate={navigate} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Media console' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/media/dashboard'));
    expect(fetchImpl).toHaveBeenCalledWith(
      '/media/dashboard/api/session',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('renders the refusal instead of silently doing nothing', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 403 }),
    ) as unknown as typeof fetch;
    render(<OpenMediaDashboardButton fetch={fetchImpl} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open Media console' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });

  it('forwards a custom label and disables while pending', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    ) as unknown as typeof fetch;
    render(
      <OpenMediaDashboardButton fetch={fetchImpl} navigate={vi.fn()}>
        Launch console
      </OpenMediaDashboardButton>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Launch console' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Opening…' })).toBeTruthy());
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);

    resolveFetch(new Response(null, { status: 200 }));
  });
});
