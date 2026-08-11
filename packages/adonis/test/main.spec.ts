import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const make = vi.fn();
  let bootedHandler: (() => void) | null = null;
  // `app` SEMPRE é um objeto com `booted` — antes do boot ele apenas agenda o handler
  // (não invoca); depois, o teste o invoca manualmente. Assim o import nunca lança.
  const app = {
    container: { make },
    booted: vi.fn((handler: () => void) => {
      bootedHandler = handler;
    }),
  };
  return {
    app,
    make,
    bootNow() {
      const h = bootedHandler;
      bootedHandler = null;
      if (h) h();
    },
  };
});

// Mock do `@adonisjs/core/services/app` — o `services/main.ts` agora lê o app do core (mesmo
// padrão lucid/drive/queue), em vez do `setBootedApp`/`getBootedApp` capturado no provider.
vi.mock('@adonisjs/core/services/app', () => ({
  default: h.app,
}));

describe('media service singleton (services/main.ts)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('imports safely before the app boots (does not throw at import time)', async () => {
    // O import top-level NÃO lança: `app.booted()` apenas agenda o handler (pré-boot), como o
    // ace carregando metadados de commands. `media` fica `undefined` até o boot.
    const mod = await import('../src/services/main.js');
    expect(mod.default).toBeUndefined();
    expect(h.app.booted).toHaveBeenCalled();
  });

  it('resolves the MediaManager from the core app once booted', async () => {
    const manager = { library: { attach: vi.fn() } };
    h.make.mockResolvedValue(manager);

    const mod = await import('../src/services/main.js');
    // Dispara o `booted` handler — o manager é resolvido e `media` passa a apontar para ele.
    h.bootNow();
    await Promise.resolve();
    await Promise.resolve();

    expect(h.make).toHaveBeenCalledWith(expect.any(Function));
    expect(mod.default).toBe(manager);
  });
});
