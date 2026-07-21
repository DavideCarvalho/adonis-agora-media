import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('media service singleton (services/main.ts)', () => {
  beforeEach(() => {
    // Fresh module graph each test: the module-level `media` binding and `booted_app`'s captured
    // app must both start empty, and this module's top-level `await` re-runs on every import.
    vi.resetModules();
  });

  it('throws the booted_app error when imported before MediaProvider registered', async () => {
    // Mirrors the dual-package hazard this fix closes: previously, a non-booted copy's
    // `@adonisjs/core/services/app` import silently yielded `undefined`, and this same top-level
    // `await app.booted(...)` crashed with an opaque `Cannot read properties of undefined`. Now it
    // fails with the same clear, actionable error `getBootedApp()` gives everywhere else.
    await expect(import('../src/services/main.js')).rejects.toThrow(/MediaProvider registered/);
  });

  it('resolves the MediaManager from the app captured by setBootedApp once booted', async () => {
    const manager = { library: { attach: vi.fn() } };
    const make = vi.fn().mockResolvedValue(manager);
    // A fake `ApplicationService` that is already "booted" — `.booted()` invokes the handler
    // immediately, exactly like the real `Application#booted()` does once `isBooted` is true.
    const fakeApp = { container: { make }, booted: vi.fn((handler) => handler()) };

    const { setBootedApp } = await import('../src/services/booted_app.js');
    setBootedApp(fakeApp as never);

    const { default: media } = await import('../src/services/main.js');

    expect(media).toBe(manager);
    expect(make).toHaveBeenCalledWith(expect.any(Function));
    expect(fakeApp.booted).toHaveBeenCalledTimes(1);
  });
});
