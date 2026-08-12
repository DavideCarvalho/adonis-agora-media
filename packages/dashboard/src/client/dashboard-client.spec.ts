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

  it('builds collections requests with only the present filters', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], nextCursor: null }));
    const client = new DashboardClient({ apiBase: '/api', fetchImpl });
    await client.collections({ ownerType: 'Post', ownerId: '42', cursor: 'c1', limit: 50 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/collections?ownerType=Post&ownerId=42&cursor=c1&limit=50');
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

  it('builds the same-origin raw preview proxy url', () => {
    const client = new DashboardClient({ apiBase: '/api' });
    expect(client.objectRawUrl('s3', 'a b.txt')).toBe('/api/object/raw?disk=s3&key=a+b.txt');
  });

  describe('me()', () => {
    it('reports "open" when the server has no user and no auth-required marker', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ authRequired: false }));
      const client = new DashboardClient({ apiBase: '/api', fetchImpl });
      await expect(client.me()).resolves.toEqual({ state: 'open' });
    });

    it('reports "authenticated" with the session user', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ user: { id: 'u1', roles: ['admin'] } }));
      const client = new DashboardClient({ apiBase: '/api', fetchImpl });
      await expect(client.me()).resolves.toEqual({
        state: 'authenticated',
        user: { id: 'u1', roles: ['admin'] },
      });
    });

    it('reports "login" with the offered modes on a 401', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ auth: { modes: ['login'] } }, 401));
      const client = new DashboardClient({ apiBase: '/api', fetchImpl });
      await expect(client.me()).resolves.toEqual({ state: 'login', modes: ['login'] });
    });
  });

  it('login() posts credentials and throws a friendly message on 401', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const client = new DashboardClient({ apiBase: '/api', fetchImpl });
    await expect(client.login('a', 'b')).rejects.toThrow('Invalid credentials');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/login');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      username: 'a',
      password: 'b',
    });
  });

  it('logout() posts to /logout', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 204));
    const client = new DashboardClient({ apiBase: '/api', fetchImpl });
    await client.logout();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/logout');
    expect(init).toMatchObject({ method: 'POST' });
  });

  it('mediaRecord() and collectionsSummary() hit their read routes', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    const client = new DashboardClient({ apiBase: '/api', fetchImpl });
    await client.mediaRecord('m1');
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/media-record?id=m1');
    await client.collectionsSummary();
    expect(fetchImpl.mock.calls[1][0]).toBe('/api/collections/summary');
  });

  it('uploadDetail() and abortUpload() hit the per-upload routes', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 200));
    const client = new DashboardClient({ apiBase: '/api', fetchImpl });
    await client.uploadDetail('u1');
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/uploads/u1');
    await client.abortUpload('u1');
    expect(fetchImpl.mock.calls[1][0]).toBe('/api/uploads/u1/abort');
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: 'POST' });
  });
});
