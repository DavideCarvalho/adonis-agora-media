import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('booted_app', () => {
  beforeEach(() => {
    // Fresh module each test so the module-level `bootedApp` starts empty.
    vi.resetModules();
  });

  it('throws a clear, actionable error when read before MediaProvider registered', async () => {
    const { getBootedApp } = await import('../src/services/booted_app.js');
    expect(() => getBootedApp()).toThrow(/MediaProvider registered/);
    expect(() => getBootedApp()).toThrow(/media_provider/);
  });

  it('returns the exact app instance captured by setBootedApp', async () => {
    const { setBootedApp, getBootedApp } = await import('../src/services/booted_app.js');
    const fakeApp = { container: { make: vi.fn() } };

    setBootedApp(fakeApp as never);

    expect(getBootedApp()).toBe(fakeApp);
  });
});
