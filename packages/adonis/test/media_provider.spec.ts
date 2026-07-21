import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaConfig } from '../src/define_config.js';

/**
 * A minimal fake of the pieces of `ApplicationService` the provider touches: config, a container
 * with `singleton`/`make`, and `booted` — modeled as a plain hook queue (not auto-invoked), so tests
 * can assert routes are registered ONLY once the queued hook actually runs, exactly like the real
 * `Application#booted()` behaves before `app.boot()` completes.
 */
function makeFakeApp(config: MediaConfig, router: { [key: string]: ReturnType<typeof vi.fn> }) {
  const bootedHandlers: Array<() => Promise<void> | void> = [];
  const make = vi.fn(async (token: unknown) => {
    if (token === 'router') return router;
    throw new Error(`unexpected container.make(${String(token)})`);
  });

  const app = {
    config: { get: (_key: string, def: unknown) => config ?? def },
    container: { singleton: vi.fn(), make },
    booted: vi.fn(async (handler: () => Promise<void> | void) => {
      bootedHandlers.push(handler);
    }),
  };

  return { app, bootedHandlers, make };
}

function makeFakeRouter() {
  const chain = { as: vi.fn().mockReturnThis() };
  return {
    get: vi.fn(() => chain),
    post: vi.fn(() => chain),
    patch: vi.fn(() => chain),
    delete: vi.fn(() => chain),
    put: vi.fn(() => chain),
    route: vi.fn(() => chain),
  };
}

describe('MediaProvider', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('register() captures the app for the booted_app module (immune to dual-package hazard)', async () => {
    const { default: MediaProvider } = await import('../providers/media_provider.js');
    const { getBootedApp } = await import('../src/services/booted_app.js');
    const { app } = makeFakeApp({}, makeFakeRouter());

    const provider = new MediaProvider(app as never);
    provider.register();

    expect(getBootedApp()).toBe(app);
  });

  it('boot() defers route registration to app.booted() instead of resolving the router synchronously', async () => {
    const { default: MediaProvider } = await import('../providers/media_provider.js');
    const router = makeFakeRouter();
    const { app, bootedHandlers, make } = makeFakeApp(
      { uploads: { routes: { enabled: true }, resumable: { routes: { enabled: true } } } },
      router,
    );

    const provider = new MediaProvider(app as never);
    provider.register();
    await provider.boot();

    // `boot()` only queued a hook — it must NOT have touched the container yet.
    expect(make).not.toHaveBeenCalled();
    expect(bootedHandlers).toHaveLength(1);
    expect(router.post).not.toHaveBeenCalled();

    // Simulate the framework firing "booted" (after every provider's own boot() has run).
    await bootedHandlers[0]?.();

    // Only now is `router` resolved from the container and routes mounted.
    expect(make).toHaveBeenCalledWith('router');
    expect(router.post).toHaveBeenCalledWith(
      '/media/uploads/direct/initiate',
      expect.any(Function),
    );
    expect(router.post).toHaveBeenCalledWith('/media/uploads/tus', expect.any(Function));
  });

  it('boot() is a no-op (queues a hook that mounts nothing) when no routes are enabled', async () => {
    const { default: MediaProvider } = await import('../providers/media_provider.js');
    const router = makeFakeRouter();
    const { app, bootedHandlers } = makeFakeApp({}, router);

    const provider = new MediaProvider(app as never);
    provider.register();
    await provider.boot();
    await bootedHandlers[0]?.();

    expect(router.post).not.toHaveBeenCalled();
    expect(router.get).not.toHaveBeenCalled();
  });
});
