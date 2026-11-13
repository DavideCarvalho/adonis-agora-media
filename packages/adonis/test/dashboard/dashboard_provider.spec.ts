import { describe, expect, it, vi } from 'vitest';

/**
 * Same fake-router shape as `test/media_provider.spec.ts` — a route method call log plus a `.group()`
 * that runs its callback synchronously and records applied middleware, modeled after the real
 * `HttpRouterService` surface this provider actually touches.
 */
function makeFakeRouter() {
  const calls: { method: string; path: string }[] = [];
  const groups: { middleware: unknown[] }[] = [];
  const chain = { as: vi.fn().mockReturnThis() };
  const router: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
    router[method] = vi.fn((path: string) => {
      calls.push({ method, path });
      return chain;
    });
  }
  router.group = vi.fn((cb: () => void) => {
    cb();
    const g = {
      middleware: [] as unknown[],
      prefix: vi.fn().mockReturnThis(),
      use: vi.fn((mw: unknown) => {
        g.middleware.push(...(Array.isArray(mw) ? mw : [mw]));
        return g;
      }),
    };
    groups.push(g);
    return g;
  });
  return { router, calls, groups };
}

/**
 * Minimal fake of the `ApplicationService` pieces the provider touches: config, a container with
 * `make`, and `booted` modeled as a plain hook queue (not auto-invoked) — same shape as
 * `test/media_provider.spec.ts`'s fake, so route registration can be asserted ONLY after the queued
 * hook actually runs, mirroring the real `Application#booted()` ordering.
 */
function makeFakeApp(config: Record<string, unknown>, router: unknown, manager: unknown = {}) {
  const bootedHandlers: Array<() => Promise<void> | void> = [];
  const make = vi.fn(async (token: unknown) => {
    if (token === 'router') return router;
    return manager; // MediaManager — `{}` unless a test actually runs a route handler.
  });
  const app = {
    config: { get: (key: string, def: unknown) => config[key] ?? def },
    container: { make },
    booted: vi.fn(async (handler: () => Promise<void> | void) => {
      bootedHandlers.push(handler);
    }),
  };
  return { app, bootedHandlers, make };
}

describe('MediaDashboardProvider (embedded in @adonis-agora/media)', () => {
  it('boot() defers route registration to app.booted() instead of resolving the router synchronously', async () => {
    const { default: MediaDashboardProvider } = await import(
      '../../providers/dashboard_provider.js'
    );
    const { router, calls } = makeFakeRouter();
    const { app, bootedHandlers, make } = makeFakeApp({}, router);

    const provider = new MediaDashboardProvider(app as never);
    await provider.boot();

    // `boot()` only queued a hook — it must NOT have touched the container yet.
    expect(make).not.toHaveBeenCalled();
    expect(bootedHandlers).toHaveLength(1);
    expect(calls).toHaveLength(0);

    // Simulate the framework firing "booted" (after every provider's own boot() has run).
    await bootedHandlers[0]?.();

    expect(make).toHaveBeenCalledWith('router');
    expect(calls).toContainEqual({ method: 'get', path: '/' });
    expect(calls).toContainEqual({ method: 'get', path: '/assets/:file' });
    expect(calls).toContainEqual({ method: 'get', path: '/topology' });
    // No console login: sign-in is the app's own.
    for (const path of ['/me', '/login', '/session', '/logout']) {
      expect(calls.some((call) => call.path === path)).toBe(false);
    }
  });

  it('reads config/media_dashboard.ts (the literal file-name key) and applies its middleware', async () => {
    const { default: MediaDashboardProvider } = await import(
      '../../providers/dashboard_provider.js'
    );
    const { router, groups } = makeFakeRouter();
    const guard = { __guard: 'auth' };
    const { app, bootedHandlers } = makeFakeApp({ media_dashboard: { middleware: guard } }, router);

    const provider = new MediaDashboardProvider(app as never);
    await provider.boot();
    await bootedHandlers[0]?.();

    expect(groups.flatMap((g) => g.middleware)).toContain(guard);
  });

  it('does NOT read the camelCase key (Adonis can never load config under it)', async () => {
    const { default: MediaDashboardProvider } = await import(
      '../../providers/dashboard_provider.js'
    );
    const { router, groups } = makeFakeRouter();
    const guard = { __guard: 'auth' };
    const { app, bootedHandlers } = makeFakeApp({ mediaDashboard: { middleware: guard } }, router);

    const provider = new MediaDashboardProvider(app as never);
    await provider.boot();
    await bootedHandlers[0]?.();

    expect(groups.flatMap((g) => g.middleware)).not.toContain(guard);
  });

  it('wires objectUrls (and the API mount it needs) from config through to the service', async () => {
    const { default: MediaDashboardProvider } = await import(
      '../../providers/dashboard_provider.js'
    );
    const { router } = makeFakeRouter();
    // Extended-disk shaped (`isExtendedDisk`) so `object()` takes the `stat` path, as in production.
    const disk = {
      capabilities: { presign: true, multipart: true, publicUrls: true, list: true },
      copy: vi.fn(),
      move: vi.fn(),
      deleteMany: vi.fn(),
      list: vi.fn(),
      size: vi.fn(),
      stat: vi.fn(async () => ({ size: 42 })),
      getSignedUrl: vi.fn(async () => 'https://internal.invalid/signed'),
    };
    const manager = {
      storage: { defaultDisk: 's3', disk: () => disk },
      hasResumable: false,
    };
    const { app, bootedHandlers } = makeFakeApp(
      { media_dashboard: { basePath: '/media', objectUrls: 'proxy' } },
      router,
      manager,
    );

    const provider = new MediaDashboardProvider(app as never);
    await provider.boot();
    await bootedHandlers[0]?.();

    // Run the real `GET /object` handler the provider registered, so the assertion covers the whole
    // config → service path (including that `proxy` is rooted at the DERIVED api mount, not a guess).
    const handler = router.get.mock.calls.find((call) => call[0] === '/object')?.[1] as (
      ctx: unknown,
    ) => Promise<unknown>;
    let body: { url?: string } | undefined;
    await handler({
      request: { input: (key: string) => ({ disk: 's3', key: 'a.txt' })[key] },
      response: { status: () => ({ json: (payload: unknown) => (body = payload as never) }) },
    });

    expect(disk.getSignedUrl).not.toHaveBeenCalled();
    expect(body?.url).toBe('/media/api/object/raw?disk=s3&key=a.txt');
  });

  it('follows the media delivery mode when objectUrls is unset: delivery proxy ⇒ console proxy URLs', async () => {
    const { default: MediaDashboardProvider } = await import(
      '../../providers/dashboard_provider.js'
    );
    const { router } = makeFakeRouter();
    // Same extended-disk fake as the test above — `stat` path, as in production.
    const disk = {
      capabilities: { presign: true, multipart: true, publicUrls: true, list: true },
      copy: vi.fn(),
      move: vi.fn(),
      deleteMany: vi.fn(),
      list: vi.fn(),
      size: vi.fn(),
      stat: vi.fn(async () => ({ size: 42 })),
      getSignedUrl: vi.fn(async () => 'https://internal.invalid/signed'),
    };
    const manager = {
      storage: { defaultDisk: 's3', disk: () => disk },
      hasResumable: false,
    };
    // No `objectUrls` in the console config — but the host already streams every read through
    // the app (`delivery.mode: 'proxy'`), i.e. it declared the store unreachable from a browser.
    const { app, bootedHandlers } = makeFakeApp(
      { media_dashboard: { basePath: '/media' }, media: { delivery: { mode: 'proxy' } } },
      router,
      manager,
    );

    const provider = new MediaDashboardProvider(app as never);
    await provider.boot();
    await bootedHandlers[0]?.();

    const handler = router.get.mock.calls.find((call) => call[0] === '/object')?.[1] as (
      ctx: unknown,
    ) => Promise<unknown>;
    let body: { url?: string } | undefined;
    await handler({
      request: { input: (key: string) => ({ disk: 's3', key: 'a.txt' })[key] },
      response: { status: () => ({ json: (payload: unknown) => (body = payload as never) }) },
    });

    expect(disk.getSignedUrl).not.toHaveBeenCalled();
    expect(body?.url).toBe('/media/api/object/raw?disk=s3&key=a.txt');
  });

  it('serves the list routes in the filter wire format: { data, meta } pages, 400 on unknown fields', async () => {
    const { default: MediaDashboardProvider } = await import(
      '../../providers/dashboard_provider.js'
    );
    const { router } = makeFakeRouter();
    const disk = {
      capabilities: { presign: true, multipart: true, publicUrls: true, list: true },
      copy: vi.fn(),
      move: vi.fn(),
      deleteMany: vi.fn(),
      list: vi.fn(async () => ({
        folders: ['a/'],
        files: [{ key: 'b.txt', name: 'b.txt', sizeBytes: 1, lastModified: undefined }],
        cursor: 'next',
      })),
      size: vi.fn(),
      stat: vi.fn(),
      getSignedUrl: vi.fn(),
    };
    const store = { list: vi.fn(async () => ({ items: [], nextCursor: null })) };
    const manager = {
      storage: { defaultDisk: 's3', disk: () => disk },
      hasResumable: false,
      store,
    };
    const { app, bootedHandlers } = makeFakeApp({ media_dashboard: {} }, router, manager);
    const provider = new MediaDashboardProvider(app as never);
    await provider.boot();
    await bootedHandlers[0]?.();

    const call = async (path: string, qs: Record<string, unknown>) => {
      const handler = router.get.mock.calls.find((c) => c[0] === path)?.[1] as (
        ctx: unknown,
      ) => Promise<unknown>;
      let status = 0;
      let body: unknown;
      await handler({
        request: { qs: () => qs, input: (key: string) => qs[key] },
        response: {
          status: (code: number) => {
            status = code;
            return { json: (payload: unknown) => (body = payload) };
          },
        },
      });
      return { status, body };
    };

    const objects = await call('/objects', { filter: { disk: 's3', prefix: '' }, first: '10' });
    expect(objects.status).toBe(200);
    expect(objects.body).toEqual({
      data: [
        { type: 'folder', name: 'a', prefix: 'a/' },
        { type: 'file', key: 'b.txt', name: 'b.txt', sizeBytes: 1, lastModified: null },
      ],
      meta: { nextCursor: 'next', prevCursor: null, hasNext: true, hasPrev: false },
    });
    expect(disk.list).toHaveBeenCalledWith('', { delimiter: '/', limit: 10 });

    const collections = await call('/collections', { filter: { collection: 'gallery' } });
    expect(collections).toEqual({
      status: 200,
      body: {
        data: [],
        meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
      },
    });
    expect(store.list).toHaveBeenCalledWith({ collection: 'gallery', limit: 50 });

    expect((await call('/collections', { filter: { owner: 'x' } })).status).toBe(400);
    expect((await call('/collections', { sort: 'name' })).status).toBe(400);
    expect((await call('/objects', { filter: { disk: 's3' }, before: 'x' })).status).toBe(400);
    expect((await call('/objects', {})).status).toBe(400);
    expect(await call('/uploads', {})).toEqual({ status: 200, body: { data: [] } });
    expect((await call('/disks', {})).body).toMatchObject({ data: [{ name: 'default' }] });
  });

  it('an explicit objectUrls always wins over the media delivery mode', async () => {
    const { default: MediaDashboardProvider } = await import(
      '../../providers/dashboard_provider.js'
    );
    const { router } = makeFakeRouter();
    const disk = {
      capabilities: { presign: true, multipart: true, publicUrls: true, list: true },
      copy: vi.fn(),
      move: vi.fn(),
      deleteMany: vi.fn(),
      list: vi.fn(),
      size: vi.fn(),
      stat: vi.fn(async () => ({ size: 42 })),
      getSignedUrl: vi.fn(async () => 'https://internal.invalid/signed'),
    };
    const manager = {
      storage: { defaultDisk: 's3', disk: () => disk },
      hasResumable: false,
    };
    const { app, bootedHandlers } = makeFakeApp(
      {
        media_dashboard: { basePath: '/media', objectUrls: 'auto' },
        media: { delivery: { mode: 'proxy' } },
      },
      router,
      manager,
    );

    const provider = new MediaDashboardProvider(app as never);
    await provider.boot();
    await bootedHandlers[0]?.();

    const handler = router.get.mock.calls.find((call) => call[0] === '/object')?.[1] as (
      ctx: unknown,
    ) => Promise<unknown>;
    let body: { url?: string } | undefined;
    await handler({
      request: { input: (key: string) => ({ disk: 's3', key: 'a.txt' })[key] },
      response: { status: () => ({ json: (payload: unknown) => (body = payload as never) }) },
    });

    expect(disk.getSignedUrl).toHaveBeenCalled();
    expect(body?.url).toBe('https://internal.invalid/signed');
  });

  it('keeps the historical auto default when neither objectUrls nor a proxy delivery is configured', async () => {
    const { default: MediaDashboardProvider } = await import(
      '../../providers/dashboard_provider.js'
    );
    const { router } = makeFakeRouter();
    const disk = {
      capabilities: { presign: true, multipart: true, publicUrls: true, list: true },
      copy: vi.fn(),
      move: vi.fn(),
      deleteMany: vi.fn(),
      list: vi.fn(),
      size: vi.fn(),
      stat: vi.fn(async () => ({ size: 42 })),
      getSignedUrl: vi.fn(async () => 'https://internal.invalid/signed'),
    };
    const manager = {
      storage: { defaultDisk: 's3', disk: () => disk },
      hasResumable: false,
    };
    const { app, bootedHandlers } = makeFakeApp(
      { media_dashboard: { basePath: '/media' } },
      router,
      manager,
    );

    const provider = new MediaDashboardProvider(app as never);
    await provider.boot();
    await bootedHandlers[0]?.();

    const handler = router.get.mock.calls.find((call) => call[0] === '/object')?.[1] as (
      ctx: unknown,
    ) => Promise<unknown>;
    let body: { url?: string } | undefined;
    await handler({
      request: { input: (key: string) => ({ disk: 's3', key: 'a.txt' })[key] },
      response: { status: () => ({ json: (payload: unknown) => (body = payload as never) }) },
    });

    expect(disk.getSignedUrl).toHaveBeenCalled();
    expect(body?.url).toBe('https://internal.invalid/signed');
  });

  it('enabled: false skips registration entirely — no "booted" hook is even queued', async () => {
    const { default: MediaDashboardProvider } = await import(
      '../../providers/dashboard_provider.js'
    );
    const { router } = makeFakeRouter();
    const { app, bootedHandlers } = makeFakeApp({ media_dashboard: { enabled: false } }, router);

    const provider = new MediaDashboardProvider(app as never);
    await provider.boot();

    expect(bootedHandlers).toHaveLength(0);
  });
});

describe('MediaDashboardProvider — authorize denials: JSON for the API, a page for the browser', () => {
  interface Recorded {
    status?: number;
    body?: unknown;
    headers: Record<string, string>;
  }

  function fakeCtx(recorded: Recorded, extra: Record<string, unknown> = {}) {
    const response = {
      getHeader: (name: string) => recorded.headers[name.toLowerCase()],
      status(code: number) {
        recorded.status = code;
        return this;
      },
      header(name: string, value: string) {
        recorded.headers[name.toLowerCase()] = value;
        return this;
      },
      send(body: unknown) {
        recorded.body = body;
      },
      redirect(url: string) {
        recorded.status = 302;
        recorded.headers.location = url;
      },
      ...extra,
    };
    return { response, request: { header: () => undefined } };
  }

  /** Boot with `config`, fire "booted", and return the API and SPA groups' first middleware. */
  async function gates(config: Record<string, unknown>, appExtra: Record<string, unknown> = {}) {
    const { default: MediaDashboardProvider } = await import(
      '../../providers/dashboard_provider.js'
    );
    const { router, groups } = makeFakeRouter();
    const { app, bootedHandlers } = makeFakeApp({ media_dashboard: config }, router);
    Object.assign(app, appExtra);
    await new MediaDashboardProvider(app as never).boot();
    await bootedHandlers[0]?.();
    // Groups are created in mount order: API, SPA.
    const [api, spa] = groups;
    type Gate = (ctx: unknown, next: () => Promise<void>) => Promise<void>;
    return { api: api?.middleware[0] as Gate, spa: spa?.middleware[0] as Gate };
  }

  it('answers 403 Forbidden JSON on the API group', async () => {
    const { api } = await gates({ authorize: () => false });
    const recorded: Recorded = { headers: {} };
    const next = vi.fn(async () => {});
    await api(fakeCtx(recorded), next);
    expect(next).not.toHaveBeenCalled();
    expect(recorded.status).toBe(403);
    expect(recorded.body).toEqual({ error: 'forbidden' });
  });

  it('serves the built-in 403 page on the SPA group', async () => {
    const { spa } = await gates({ authorize: () => false });
    const recorded: Recorded = { headers: {} };
    const next = vi.fn(async () => {});
    await spa(fakeCtx(recorded), next);
    expect(next).not.toHaveBeenCalled();
    expect(recorded.status).toBe(403);
    expect(recorded.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(recorded.headers['cache-control']).toBe('no-store, must-revalidate');
    expect(recorded.body).toContain('<!doctype html>');
    expect(recorded.body).toContain('<h1>Access denied</h1>');
    expect(recorded.body).toContain('Media');
    expect(recorded.body).not.toContain('<script');
  });

  it('applies the accessDenied options, a renderer, and stands down on a redirect', async () => {
    const tweaked = await gates({
      authorize: () => false,
      accessDenied: { brand: 'Entre Textos', title: 'Sem acesso', homeHref: '/admin' },
    });
    const a: Recorded = { headers: {} };
    await tweaked.spa(fakeCtx(a), async () => {});
    expect(a.body).toContain('<h1>Sem acesso</h1>');
    expect(a.body).toContain('Entre Textos');
    expect(a.body).toContain('href="/admin"');

    const custom = await gates({
      authorize: () => false,
      accessDenied: (info: { status: number; basePath: string }) =>
        `<p>custom ${info.status} ${info.basePath}</p>`,
    });
    const b: Recorded = { headers: {} };
    await custom.spa(fakeCtx(b), async () => {});
    expect(b.body).toBe('<p>custom 403 /media/dashboard</p>');

    const redirected = await gates({
      authorize: () => false,
      accessDenied: (_info: unknown, ctx: { response: { header(n: string, v: string): void } }) => {
        ctx.response.header('location', '/entrar');
      },
    });
    const c: Recorded = { headers: {} };
    await redirected.spa(fakeCtx(c), async () => {});
    expect(c.headers.location).toBe('/entrar');
    expect(c.body).toBeUndefined();
  });

  it('never overwrites a redirect the authorize hook wrote, and honours the CSP nonce', async () => {
    const { spa } = await gates({
      authorize: (ctx: { response: { header(n: string, v: string): void } }) => {
        ctx.response.header('location', '/login');
        return false;
      },
    });
    const a: Recorded = { headers: {} };
    await spa(fakeCtx(a), async () => {});
    expect(a.headers.location).toBe('/login');
    expect(a.body).toBeUndefined();

    const plain = await gates({ authorize: () => false });
    const b: Recorded = { headers: {} };
    await plain.spa(fakeCtx(b, { nonce: 'n0nce' }), async () => {});
    expect(b.body).toContain('<style nonce="n0nce">');
  });

  describe('the shared ConsoleAuthorize contract', () => {
    async function run(authorize: unknown, mode: 'api' | 'spa', extra?: Record<string, unknown>) {
      const g = await gates({ authorize });
      const recorded: Recorded = { headers: {} };
      const next = vi.fn(async () => {});
      await g[mode](fakeCtx(recorded, extra), next);
      return { recorded, next };
    }

    it.each([
      ['true', () => true],
      ['{ allowed: true }', () => ({ allowed: true })],
      ['async { allowed: true }', async () => ({ allowed: true })],
      [
        '{ allowed: true, reason } (reason ignored)',
        () => ({ allowed: true, reason: 'forbidden' }),
      ],
    ])('%s lets API and page requests through', async (_label, authorize) => {
      for (const mode of ['api', 'spa'] as const) {
        const { recorded, next } = await run(authorize, mode);
        expect(next).toHaveBeenCalledOnce();
        expect(recorded.status).toBeUndefined();
        expect(recorded.body).toBeUndefined();
      }
    });

    it.each([
      ['false', () => false],
      ['{ allowed: false } (a truthy object!)', () => ({ allowed: false })],
      ['async { allowed: false }', async () => ({ allowed: false })],
      ["{ allowed: false, reason: 'forbidden' }", () => ({ allowed: false, reason: 'forbidden' })],
      [
        'a throwing hook',
        () => {
          throw new Error('boom');
        },
      ],
      [
        'a rejecting hook',
        async () => {
          throw new Error('boom');
        },
      ],
    ])(
      '%s denies with 403 — JSON on the API, the page on a navigation',
      async (_label, authorize) => {
        const api = await run(authorize, 'api');
        expect(api.next).not.toHaveBeenCalled();
        expect(api.recorded.status).toBe(403);
        expect(api.recorded.body).toEqual({ error: 'forbidden' });

        const spa = await run(authorize, 'spa');
        expect(spa.next).not.toHaveBeenCalled();
        expect(spa.recorded.status).toBe(403);
        expect(spa.recorded.headers['content-type']).toBe('text/html; charset=utf-8');
        expect(spa.recorded.body).toContain('<h1>Access denied</h1>');
      },
    );

    it("{ allowed: false, reason: 'unauthenticated' } denies with 401", async () => {
      const authorize = () => ({ allowed: false, reason: 'unauthenticated' });
      const api = await run(authorize, 'api');
      expect(api.next).not.toHaveBeenCalled();
      expect(api.recorded.status).toBe(401);
      expect(api.recorded.body).toEqual({ error: 'unauthenticated' });

      const spa = await run(authorize, 'spa');
      expect(spa.next).not.toHaveBeenCalled();
      expect(spa.recorded.status).toBe(401);
      expect(spa.recorded.body).toContain('<h1>Sign in required</h1>');
    });

    it('hands the matching status/reason to a custom accessDenied renderer', async () => {
      const g = await gates({
        authorize: () => ({ allowed: false, reason: 'unauthenticated' }),
        accessDenied: (info: { status: number; reason: string }) => `${info.status} ${info.reason}`,
      });
      const recorded: Recorded = { headers: {} };
      await g.spa(fakeCtx(recorded), async () => {});
      expect(recorded.status).toBe(401);
      expect(recorded.body).toBe('401 unauthenticated');
    });

    it('a redirect the hook wrote still wins over a decision, on the API and the page', async () => {
      const authorize = (ctx: { response: { header(n: string, v: string): void } }) => {
        ctx.response.header('location', '/login');
        return { allowed: false, reason: 'unauthenticated' };
      };
      for (const mode of ['api', 'spa'] as const) {
        const { recorded, next } = await run(authorize, mode);
        expect(next).not.toHaveBeenCalled();
        expect(recorded.headers.location).toBe('/login');
        expect(recorded.status).toBeUndefined();
        expect(recorded.body).toBeUndefined();
      }
    });

    it('a body the hook queued is kept on the API too (nothing is written over it)', async () => {
      const { recorded, next } = await run(() => ({ allowed: false }), 'api', {
        hasLazyBody: true,
      });
      expect(next).not.toHaveBeenCalled();
      expect(recorded.status).toBeUndefined();
      expect(recorded.body).toBeUndefined();
    });

    it('{ redirectTo } redirects a page navigation and answers 401 JSON to the API', async () => {
      const authorize = () => ({ redirectTo: '/login?next=/media/dashboard' });
      const spa = await run(authorize, 'spa');
      expect(spa.next).not.toHaveBeenCalled();
      expect(spa.recorded.status).toBe(302);
      expect(spa.recorded.headers.location).toBe('/login?next=/media/dashboard');
      expect(spa.recorded.body).toBeUndefined();

      const api = await run(authorize, 'api');
      expect(api.next).not.toHaveBeenCalled();
      expect(api.recorded.status).toBe(401);
      expect(api.recorded.body).toEqual({
        error: 'unauthenticated',
        redirectTo: '/login?next=/media/dashboard',
      });
      expect(api.recorded.headers.location).toBeUndefined();
    });

    it('accepts a ConsoleAuthorizer class, built through ctx.containerResolver', async () => {
      class Access {
        authorize(ctx: { user?: string }) {
          return ctx.user === 'admin';
        }
      }
      const make = vi.fn(async (Class: new () => Access) => new Class());
      for (const [user, allowed] of [
        ['admin', true],
        ['guest', false],
      ] as const) {
        const g = await gates({ authorize: Access });
        const r: Recorded = { headers: {} };
        const n = vi.fn(async () => {});
        await g.api({ ...fakeCtx(r), user, containerResolver: { make } }, n);
        expect(n).toHaveBeenCalledTimes(allowed ? 1 : 0);
        if (!allowed) expect(r.status).toBe(403);
      }
      expect(make).toHaveBeenCalledWith(Access);
    });

    it('accepts a lazy import of a ConsoleAuthorizer class', async () => {
      class Access {
        authorize() {
          return { allowed: false, reason: 'unauthenticated' };
        }
      }
      const load = vi.fn(async () => ({ default: Access }));
      const g = await gates({ authorize: load });
      for (let i = 0; i < 2; i++) {
        const r: Recorded = { headers: {} };
        const n = vi.fn(async () => {});
        await g.spa(
          { ...fakeCtx(r), containerResolver: { make: async (C: new () => Access) => new C() } },
          n,
        );
        expect(n).not.toHaveBeenCalled();
        expect(r.status).toBe(401);
      }
      expect(load).toHaveBeenCalledOnce();
    });
  });

  describe('without authorize', () => {
    const NO_AUTHORIZE_WARNING =
      '[@adonis-agora/media] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in config/media_dashboard.ts.';

    it('stays open outside production (no gate is mounted) and warns once at boot', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { api, spa } = await gates({}, { inProduction: false });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(api).toBeUndefined();
        expect(spa).toBeUndefined();
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(NO_AUTHORIZE_WARNING);
      } finally {
        warn.mockRestore();
      }
    });

    it('keeps `middleware` working outside production', async () => {
      const guard = vi.fn();
      const { api, spa } = await gates({ middleware: guard }, { inProduction: false });
      expect(api).toBe(guard);
      expect(spa).toBe(guard);
    });

    it('refuses every request in production (403) and warns once at boot', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { api, spa } = await gates({}, { inProduction: true });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(warn).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith(NO_AUTHORIZE_WARNING);

        const a: Recorded = { headers: {} };
        const an = vi.fn(async () => {});
        await api(fakeCtx(a), an);
        expect(an).not.toHaveBeenCalled();
        expect(a.status).toBe(403);
        expect(a.body).toEqual({ error: 'forbidden' });

        const p: Recorded = { headers: {} };
        const pn = vi.fn(async () => {});
        await spa(fakeCtx(p), pn);
        expect(pn).not.toHaveBeenCalled();
        expect(p.status).toBe(403);
        expect(p.body).toContain('<h1>Access denied</h1>');
        expect(warn).toHaveBeenCalledOnce();
      } finally {
        warn.mockRestore();
      }
    });

    it('logs the production warning through the app logger when one is bound', async () => {
      const logger = { warn: vi.fn() };
      const { default: MediaDashboardProvider } = await import(
        '../../providers/dashboard_provider.js'
      );
      const { router } = makeFakeRouter();
      const { app, bootedHandlers, make } = makeFakeApp({ media_dashboard: {} }, router);
      make.mockImplementation(async (token: unknown) => (token === 'router' ? router : logger));
      Object.assign(app, { inProduction: true });
      await new MediaDashboardProvider(app as never).boot();
      await bootedHandlers[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(NO_AUTHORIZE_WARNING);
    });

    it('an explicit authorize opens it in production, without the warning', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { api } = await gates({ authorize: () => true }, { inProduction: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
      const r: Recorded = { headers: {} };
      const n = vi.fn(async () => {});
      await api(fakeCtx(r), n);
      expect(n).toHaveBeenCalledOnce();
    });
  });

  describe('authorizeByToken through the gate', () => {
    it('allows the Bearer token and answers 401 JSON otherwise', async () => {
      const { authorizeByToken } = await import('../../src/dashboard/index.js');
      const { api, spa } = await gates({ authorize: authorizeByToken({ token: 's3cret' }) });
      const withAuth = (r: Recorded, value?: string) => ({
        ...fakeCtx(r),
        request: { header: (name: string) => (name === 'authorization' ? value : undefined) },
      });

      const ok: Recorded = { headers: {} };
      const okNext = vi.fn(async () => {});
      await api(withAuth(ok, 'Bearer s3cret'), okNext);
      expect(okNext).toHaveBeenCalledOnce();

      const bad: Recorded = { headers: {} };
      const badNext = vi.fn(async () => {});
      await api(withAuth(bad, 'Bearer nope'), badNext);
      expect(badNext).not.toHaveBeenCalled();
      expect(bad.status).toBe(401);
      expect(bad.body).toEqual({ error: 'unauthenticated' });

      const page: Recorded = { headers: {} };
      const pageNext = vi.fn(async () => {});
      await spa(withAuth(page), pageNext);
      expect(pageNext).not.toHaveBeenCalled();
      expect(page.status).toBe(401);
    });
  });
});
