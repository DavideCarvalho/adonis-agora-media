import { describe, expect, it, vi } from 'vitest';

/**
 * The provider mounts through the `@adonisjs/core/services/router` façade (a module-level
 * import), so the router is mocked here rather than injected.
 */
const groups: { middleware: unknown[] }[] = [];

vi.mock('@adonisjs/core/services/router', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['get', 'post', 'put', 'delete', 'any', 'as', 'use', 'where']) {
    chain[m] = () => chain;
  }
  const group = () => {
    const g = {
      middleware: [] as unknown[],
      prefix: () => g,
      as: () => g,
      use: (mw: unknown) => {
        g.middleware.push(...(Array.isArray(mw) ? mw : [mw]));
        return g;
      },
    };
    groups.push(g);
    return g;
  };
  return {
    default: {
      ...chain,
      group: (cb: () => void) => {
        cb();
        return group();
      },
    },
  };
});

const { default: MediaDashboardProvider } = await import('./media_dashboard_provider.js');

/**
 * Guards the config KEY the provider reads.
 *
 * AdonisJS keys config by the literal file name, so the documented
 * `config/media_dashboard.ts` lands under `media_dashboard`. The provider once read
 * `mediaDashboard`, which always missed and fell back to the `{}` default — silently
 * discarding the entire config. The dangerous part was `middleware`: the documented
 * `middleware: middleware.auth()` guard was dropped, so the dashboard SPA and its JSON
 * API mounted with NO auth at all. Every other key (basePath/disks/actions) was ignored
 * too, but those fail visibly; the auth hole fails silently.
 *
 * The assertions target the CONSEQUENCE (the guard reaches the mounted routes), not the
 * key string, so the drift is still caught if it is reintroduced by another route.
 */
function fakeApp(config: Record<string, unknown>) {
  return {
    config: { get: (key: string, fallback: unknown) => config[key] ?? fallback },
    container: { make: vi.fn(async () => ({})) },
    makeURL: () => new URL('file:///app/'),
  } as never;
}

describe('MediaDashboardProvider config key', () => {
  it('reads config/media_dashboard.ts and applies its auth middleware to the routes', () => {
    groups.length = 0;
    const guard = { __guard: 'auth' };

    new MediaDashboardProvider(fakeApp({ media_dashboard: { middleware: guard } })).boot();

    expect(groups.flatMap((g) => g.middleware)).toContain(guard);
  });

  it('does NOT read the camelCase key (Adonis can never load config under it)', () => {
    groups.length = 0;
    const guard = { __guard: 'auth' };

    new MediaDashboardProvider(fakeApp({ mediaDashboard: { middleware: guard } })).boot();

    expect(groups.flatMap((g) => g.middleware)).not.toContain(guard);
  });
});
