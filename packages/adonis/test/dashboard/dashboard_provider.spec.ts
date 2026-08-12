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
