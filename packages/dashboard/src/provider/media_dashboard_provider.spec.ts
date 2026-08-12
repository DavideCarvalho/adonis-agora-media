import { beforeEach, describe, expect, it } from 'vitest';
import { bootCalls } from '../../test/fixtures/fake_media_dashboard_provider.js';

/**
 * `MediaDashboardProvider` is a thin delegate to `@adonis-agora/media`'s embedded dashboard provider
 * (see the class doc comment for why the delegation is a runtime `import()` rather than a static
 * one). `@adonis-agora/media` is not linked into this package inside this monorepo (see the same
 * comment), so `vitest.config.ts` aliases the `import()`'s target to a local fixture
 * (`test/fixtures/fake_media_dashboard_provider.ts`) that records what it was constructed/booted
 * with — exactly what a real consumer's bundler resolves once the peer is actually installed.
 */
describe('MediaDashboardProvider (standalone package)', () => {
  beforeEach(() => {
    bootCalls.length = 0;
  });

  it('delegates boot() to the embedded @adonis-agora/media dashboard provider, passing the same app', async () => {
    const { default: MediaDashboardProvider } = await import('./media_dashboard_provider.js');
    const app = { fake: 'application-service' };

    const provider = new MediaDashboardProvider(app as never);
    await provider.boot();

    expect(bootCalls).toEqual([app]);
  });

  it('resolves the inner provider only once across repeated boot() calls', async () => {
    const { default: MediaDashboardProvider } = await import('./media_dashboard_provider.js');
    const provider = new MediaDashboardProvider({} as never);

    await provider.boot();
    await provider.boot();

    expect(bootCalls).toHaveLength(2);
  });
});
