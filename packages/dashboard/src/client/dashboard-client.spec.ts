import { describe, expect, it, vi } from 'vitest';
import { DashboardClient } from './dashboard-client';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('DashboardClient', () => {
  it('builds object listing requests with query params and same-origin credentials', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ folders: [], files: [] }));
    const client = new DashboardClient({ apiBase: '/media/dashboard/api', fetchImpl });
    await client.objects('s3', { prefix: 'photos/', cursor: 'c1', limit: 50 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/media/dashboard/api/objects?disk=s3&prefix=photos%2F&cursor=c1&limit=50');
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
  });

  it('omits empty query params', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ uploads: [] }));
    const client = new DashboardClient({ apiBase: '/api', fetchImpl });
    await client.uploads({});
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/uploads');
  });

  it('posts copy/move/delete as JSON bodies', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 204, json: async () => ({}) }) as Response,
    );
    const client = new DashboardClient({ apiBase: '/api', fetchImpl });
    await client.copy({ disk: 's3', from: 'a', to: 'b', toDisk: 'backup' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/copy');
    expect(init).toMatchObject({ method: 'POST' });
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      disk: 's3',
      from: 'a',
      to: 'b',
      toDisk: 'backup',
    });
  });

  it('surfaces the server error message on non-2xx', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'disk is required' }, 400));
    const client = new DashboardClient({ apiBase: '/api', fetchImpl });
    await expect(client.disks()).rejects.toThrow('disk is required');
  });

  it('treats 204 as an empty success', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 204, json: async () => ({}) }) as Response,
    );
    const client = new DashboardClient({ apiBase: '/api', fetchImpl });
    await expect(client.remove({ disk: 's3', keys: ['a'] })).resolves.toBeUndefined();
  });
});
