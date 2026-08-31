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
function makeFakeApp(config: Record<string, unknown>, router: unknown) {
  const bootedHandlers: Array<() => Promise<void> | void> = [];
  const make = vi.fn(async (token: unknown) => {
    if (token === 'router') return router;
    return {}; // MediaManager (or anything else) — never resolved unless a handler actually runs.
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
    expect(calls).toContainEqual({ method: 'get', path: '/me' });
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
      ...extra,
    };
    return { response, request: { header: () => undefined } };
  }

  /** Boot with `config`, fire "booted", and return the API and SPA groups' first middleware. */
  async function gates(config: Record<string, unknown>) {
    const { default: MediaDashboardProvider } = await import(
      '../../providers/dashboard_provider.js'
    );
    const { router, groups } = makeFakeRouter();
    const { app, bootedHandlers } = makeFakeApp({ media_dashboard: config }, router);
    await new MediaDashboardProvider(app as never).boot();
    await bootedHandlers[0]?.();
    // Groups are created in mount order: auth routes (no middleware), API, SPA.
    const [, api, spa] = groups;
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
    expect(recorded.body).toEqual({ error: 'Forbidden' });
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
});
