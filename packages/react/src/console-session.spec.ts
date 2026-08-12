import { describe, expect, it, vi } from 'vitest';
import {
  ConsoleSessionError,
  mediaDashboardSessionUrl,
  mediaDashboardUrl,
  mintMediaDashboardSession,
  openMediaDashboard,
} from './console-session.js';

function okFetch(): typeof fetch {
  return vi.fn(async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
}

describe('mediaDashboardSessionUrl / mediaDashboardUrl', () => {
  it('defaults to the provider mount conventions', () => {
    expect(mediaDashboardSessionUrl()).toBe('/media/dashboard/api/session');
    expect(mediaDashboardUrl()).toBe('/media/dashboard');
  });

  it('honors a custom apiBasePath', () => {
    expect(mediaDashboardSessionUrl('/api/media/console')).toBe('/api/media/console/session');
  });
});

describe('mintMediaDashboardSession', () => {
  it('POSTs to the session endpoint with credentials and resolves on 200', async () => {
    const fetchImpl = okFetch();
    await mintMediaDashboardSession({ fetch: fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(
      '/media/dashboard/api/session',
      expect.objectContaining({ method: 'POST', credentials: 'include', redirect: 'manual' }),
    );
  });

  it('derives the session url from a custom basePath when apiBasePath is not set', async () => {
    const fetchImpl = okFetch();
    await mintMediaDashboardSession({ basePath: '/admin/media', fetch: fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith('/admin/media/api/session', expect.anything());
  });

  it('throws ConsoleSessionError on a non-ok response', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 401 }),
    ) as unknown as typeof fetch;
    await expect(mintMediaDashboardSession({ fetch: fetchImpl })).rejects.toBeInstanceOf(
      ConsoleSessionError,
    );
  });

  it('treats an opaque/3xx redirect as a refusal, not a silent success', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 302 }),
    ) as unknown as typeof fetch;
    await expect(mintMediaDashboardSession({ fetch: fetchImpl })).rejects.toThrow(/redirect/);
  });

  it('wraps a network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    await expect(mintMediaDashboardSession({ fetch: fetchImpl })).rejects.toBeInstanceOf(
      ConsoleSessionError,
    );
  });
});

describe('openMediaDashboard', () => {
  it('mints then navigates to the console url', async () => {
    const fetchImpl = okFetch();
    const navigate = vi.fn();
    await openMediaDashboard({ fetch: fetchImpl, navigate });
    expect(navigate).toHaveBeenCalledWith('/media/dashboard');
  });

  it('does not navigate when the mint is refused', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 403 }),
    ) as unknown as typeof fetch;
    const navigate = vi.fn();
    await expect(openMediaDashboard({ fetch: fetchImpl, navigate })).rejects.toBeInstanceOf(
      ConsoleSessionError,
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});
