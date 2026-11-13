import { describe, expect, it, vi } from 'vitest';
import { csrfHeader, DashboardClient, followUnauthenticated } from './dashboard-client';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('DashboardClient', () => {
  it('builds object listing requests with query params and same-origin credentials', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [], meta: {} }));
    const client = new DashboardClient({ apiBase: '/media/dashboard/api', fetchImpl });
    await client.objects('s3', { prefix: 'photos/', after: 'c1', first: 50 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(decodeURIComponent(url as string)).toBe(
      '/media/dashboard/api/objects?filter[disk]=s3&filter[prefix]=photos/&after=c1&first=50',
    );
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
  });

  it('builds collections requests with only the present filters', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [], meta: {} }));
    const client = new DashboardClient({ apiBase: '/api', fetchImpl });
    await client.collections({ ownerType: 'Post', ownerId: '42', after: 'c1', first: 50 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(decodeURIComponent(url as string)).toBe(
      '/api/collections?filter[ownerType]=Post&filter[ownerId]=42&after=c1&first=50',
    );
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin' });
  });

  it('omits empty query params', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const client = new DashboardClient({ apiBase: '/api', fetchImpl });
    await client.uploads({ prefix: '' });
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/uploads');
    await client.uploads({ disk: 's3' });
    expect(decodeURIComponent(fetchImpl.mock.calls[1][0] as string)).toBe(
      '/api/uploads?filter[disk]=s3',
    );
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

  it('echoes the XSRF-TOKEN cookie as x-xsrf-token on POSTs', async () => {
    // biome-ignore lint/suspicious/noDocumentCookie: the test plants the cookie shield would set
    document.cookie = 'XSRF-TOKEN=tok%3D1';
    try {
      const fetchImpl = vi.fn(
        async () => ({ ok: true, status: 204, json: async () => ({}) }) as Response,
      );
      const client = new DashboardClient({ apiBase: '/api', fetchImpl });
      await client.createFolder({ disk: 's3', prefix: 'a/' });
      const init = fetchImpl.mock.calls[0][1] as RequestInit;
      expect(init.headers).toMatchObject({ 'x-xsrf-token': 'tok=1' });
      expect(init.redirect).toBe('manual');
    } finally {
      // biome-ignore lint/suspicious/noDocumentCookie: clean up the planted cookie
      document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    }
  });

  it('sends a malformed XSRF-TOKEN as is instead of throwing', () => {
    // biome-ignore lint/suspicious/noDocumentCookie: the test plants a malformed cookie
    document.cookie = 'XSRF-TOKEN=bad%ZZ';
    try {
      expect(csrfHeader()).toEqual({ 'x-xsrf-token': 'bad%ZZ' });
    } finally {
      // biome-ignore lint/suspicious/noDocumentCookie: clean up the planted cookie
      document.cookie = 'XSRF-TOKEN=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
    }
  });

  it('sends no x-xsrf-token without the cookie', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 204, json: async () => ({}) }) as Response,
    );
    const client = new DashboardClient({ apiBase: '/api', fetchImpl });
    await client.remove({ disk: 's3', keys: ['a'] });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.headers).not.toHaveProperty('x-xsrf-token');
  });

  it('turns a redirected response into an error instead of a silent success', async () => {
    const opaque = vi.fn(
      async () =>
        ({ ok: false, status: 0, type: 'opaqueredirect', json: async () => ({}) }) as Response,
    );
    await expect(
      new DashboardClient({ apiBase: '/api', fetchImpl: opaque }).copy({
        disk: 's3',
        from: 'a',
        to: 'b',
      }),
    ).rejects.toThrow(/redirected/);
    const followed = vi.fn(
      async () => ({ ok: true, status: 200, redirected: true, json: async () => ({}) }) as Response,
    );
    await expect(
      new DashboardClient({ apiBase: '/api', fetchImpl: followed }).disks(),
    ).rejects.toThrow(/redirected/);
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

  describe('401 handling', () => {
    it('goes where authorize asked when the 401 carries a redirectTo', async () => {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ error: 'unauthenticated', redirectTo: '/login' }, 401),
      );
      const onUnauthenticated = vi.fn();
      const client = new DashboardClient({ apiBase: '/api', fetchImpl, onUnauthenticated });
      await expect(client.topology()).rejects.toThrow('Not signed in');
      expect(onUnauthenticated).toHaveBeenCalledWith('/login');
    });

    it('passes no target on a bare 401, so the default reloads the page', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: 'unauthenticated' }, 401));
      const onUnauthenticated = vi.fn();
      const client = new DashboardClient({ apiBase: '/api', fetchImpl, onUnauthenticated });
      await expect(client.copy({ disk: 's3', from: 'a', to: 'b' })).rejects.toThrow(
        'Not signed in',
      );
      expect(onUnauthenticated).toHaveBeenCalledWith(undefined);
    });

    it('leaves a 403 as an ordinary error', async () => {
      const fetchImpl = vi.fn(async () => jsonResponse({ error: 'forbidden' }, 403));
      const onUnauthenticated = vi.fn();
      const client = new DashboardClient({ apiBase: '/api', fetchImpl, onUnauthenticated });
      await expect(client.disks()).rejects.toThrow('forbidden');
      expect(onUnauthenticated).not.toHaveBeenCalled();
    });

    it('followUnauthenticated assigns the redirectTo, else reloads', () => {
      const assign = vi.fn();
      const reload = vi.fn();
      vi.stubGlobal('window', { location: { assign, reload } });
      try {
        followUnauthenticated('/login');
        expect(assign).toHaveBeenCalledWith('/login');
        followUnauthenticated(undefined);
        expect(reload).toHaveBeenCalledOnce();
      } finally {
        vi.unstubAllGlobals();
      }
    });
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
