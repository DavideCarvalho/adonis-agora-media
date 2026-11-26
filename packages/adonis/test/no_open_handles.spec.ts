import { describe, expect, it, vi } from 'vitest';
import MediaProvider from '../providers/media_provider.js';
import { MediaManager } from '../src/media_manager.js';

/**
 * §12: a lib never keeps a plain ace process alive. A tenant of a media control plane, with the
 * federated console configured on the side that may have it, boots and terminates in the `console`
 * environment and leaves no handle open (no stream, poll, timer or socket of its own).
 */
describe('no long-lived connection in a console process', () => {
  it('a tenant app boots, resolves its manager, and terminates with no new open handle', async () => {
    const count = () => {
      const kinds = new Map<string, number>();
      for (const kind of process.getActiveResourcesInfo())
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      return kinds;
    };
    const before = count();
    const bindings = new Map<unknown, () => Promise<unknown>>();
    const booted: Array<() => Promise<void>> = [];
    const config: Record<string, unknown> = {
      media: {
        topology: 'tenant',
        tenant: { url: 'http://127.0.0.1:9/_media', partition: 'shop', token: 'secret-token' },
      },
      'app.appKey': 'an-app-key-of-32-characters-long',
    };
    const app = {
      config: { get: (key: string, def: unknown) => config[key] ?? def },
      getEnvironment: () => 'console',
      inProduction: true,
      container: {
        singleton: vi.fn((token: unknown, factory: () => Promise<unknown>) => {
          bindings.set(token, factory);
        }),
        hasBinding: (token: unknown) => bindings.has(token),
        make: async (token: unknown) => {
          const factory = bindings.get(token);
          if (factory) return factory();
          if (token === 'router') return { route: () => ({ as: () => undefined }) };
          throw new Error(`unexpected ${String(token)}`);
        },
      },
      booted: async (hook: () => Promise<void>) => void booted.push(hook),
      terminating: vi.fn(),
    };
    const provider = new MediaProvider(app as never);
    provider.register();
    await provider.boot();
    for (const hook of booted) await hook();
    await provider.ready();
    // Resolving the manager (what an ace command does) opens nothing either.
    await app.container.make(MediaManager).catch(() => undefined);
    await provider.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    const opened = [...count()].filter(([kind, n]) => n > (before.get(kind) ?? 0));
    expect(opened).toEqual([]);
  });
});
