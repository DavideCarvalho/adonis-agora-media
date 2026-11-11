import { describe, expect, it, vi } from 'vitest';
import {
  normalizeConsoleAuthorizeResult,
  resolveConsoleAuthorize,
} from '../../src/dashboard/console_authorize.js';

const FORBIDDEN = { allowed: false, status: 403, reason: 'forbidden' };
const UNAUTHENTICATED = { allowed: false, status: 401, reason: 'unauthenticated' };

/** A ctx double carrying a container resolver that records what it built. */
function ctxWith(extra: Record<string, unknown> = {}) {
  const built: unknown[] = [];
  const containerResolver = {
    make: vi.fn(async (Class: new (...args: unknown[]) => unknown) => {
      const instance = new Class('injected');
      built.push(instance);
      return instance;
    }),
  };
  return { ctx: { containerResolver, ...extra } as never, containerResolver, built };
}

describe('normalizeConsoleAuthorizeResult', () => {
  it.each([
    ['true', true, { allowed: true }],
    ['{ allowed: true }', { allowed: true }, { allowed: true }],
    [
      '{ allowed: true, reason } (reason ignored)',
      { allowed: true, reason: 'forbidden' },
      { allowed: true },
    ],
    ['false', false, FORBIDDEN],
    ['{ allowed: false }', { allowed: false }, FORBIDDEN],
    ["{ allowed: false, reason: 'forbidden' }", { allowed: false, reason: 'forbidden' }, FORBIDDEN],
    [
      "{ allowed: false, reason: 'unauthenticated' }",
      { allowed: false, reason: 'unauthenticated' },
      UNAUTHENTICATED,
    ],
    ['{ redirectTo }', { redirectTo: '/login' }, { ...UNAUTHENTICATED, redirectTo: '/login' }],
    ['{ redirectTo: "" }', { redirectTo: '' }, FORBIDDEN],
    ['undefined', undefined, FORBIDDEN],
    ['null', null, FORBIDDEN],
    ['a string', 'yes', FORBIDDEN],
    ['1', 1, FORBIDDEN],
  ])('%s', (_label, input, expected) => {
    expect(normalizeConsoleAuthorizeResult(input)).toEqual(expected);
  });
});

describe('resolveConsoleAuthorize', () => {
  it('calls an inline function with the ctx', async () => {
    const fn = vi.fn((ctx: { admin?: boolean }) => ctx.admin === true);
    const decide = resolveConsoleAuthorize(fn as never);
    expect(await decide({ admin: true } as never)).toEqual({ allowed: true });
    expect(await decide({ admin: false } as never)).toEqual(FORBIDDEN);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('awaits an async function', async () => {
    const decide = resolveConsoleAuthorize(async () => ({
      allowed: false,
      reason: 'unauthenticated',
    }));
    expect(await decide({} as never)).toEqual(UNAUTHENTICATED);
  });

  it('builds a class through ctx.containerResolver (DI) and calls authorize(ctx)', async () => {
    class Access {
      constructor(public dep?: string) {}
      authorize(ctx: { user?: string }) {
        return this.dep === 'injected' && ctx.user === 'admin';
      }
    }
    const decide = resolveConsoleAuthorize(Access as never);
    const allowed = ctxWith({ user: 'admin' });
    expect(await decide(allowed.ctx)).toEqual({ allowed: true });
    expect(allowed.containerResolver.make).toHaveBeenCalledWith(Access);
    expect(allowed.built[0]).toBeInstanceOf(Access);

    const denied = ctxWith({ user: 'guest' });
    expect(await decide(denied.ctx)).toEqual(FORBIDDEN);
  });

  it('builds a class with `new` when the ctx has no container resolver', async () => {
    class Access {
      authorize() {
        return { redirectTo: '/login' };
      }
    }
    const decide = resolveConsoleAuthorize(Access as never);
    expect(await decide({} as never)).toEqual({ ...UNAUTHENTICATED, redirectTo: '/login' });
  });

  it('loads a lazy import once, then builds the class through the container per request', async () => {
    class Access {
      constructor(public dep?: string) {}
      async authorize() {
        return this.dep === 'injected';
      }
    }
    const load = vi.fn(async () => ({ default: Access }));
    const decide = resolveConsoleAuthorize(load);

    const first = ctxWith();
    const second = ctxWith();
    expect(await decide(first.ctx)).toEqual({ allowed: true });
    expect(await decide(second.ctx)).toEqual({ allowed: true });
    expect(load).toHaveBeenCalledOnce();
    expect(first.containerResolver.make).toHaveBeenCalledWith(Access);
    expect(second.containerResolver.make).toHaveBeenCalledWith(Access);
  });

  it('memoizes per resolved config, not globally', async () => {
    class Access {
      authorize() {
        return true;
      }
    }
    const load = vi.fn(async () => ({ default: Access }));
    await resolveConsoleAuthorize(load)(ctxWith().ctx);
    await resolveConsoleAuthorize(load)(ctxWith().ctx);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('treats a module whose default is not an authorizer class as a denial', async () => {
    const decide = resolveConsoleAuthorize((async () => ({ default: () => true })) as never);
    expect(await decide({} as never)).toEqual(FORBIDDEN);
  });

  it.each([
    [
      'an inline function',
      () => {
        throw new Error('boom');
      },
    ],
    [
      'an async function',
      async () => {
        throw new Error('boom');
      },
    ],
    [
      'a class',
      class {
        authorize() {
          throw new Error('boom');
        }
      },
    ],
    ['a lazy import', async () => Promise.reject(new Error('module not found'))],
    [
      'a container that cannot build the class',
      class Needy {
        authorize() {
          return true;
        }
      },
    ],
  ])('a throw from %s is a 403, never an allow', async (label, authorize) => {
    const decide = resolveConsoleAuthorize(authorize as never);
    const ctx =
      label === 'a container that cannot build the class'
        ? { containerResolver: { make: async () => Promise.reject(new Error('unresolvable')) } }
        : {};
    expect(await decide(ctx as never)).toEqual(FORBIDDEN);
  });

  it('retries a lazy import that failed instead of caching the failure', async () => {
    class Access {
      authorize() {
        return true;
      }
    }
    const load = vi
      .fn<() => Promise<{ default: typeof Access }>>()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ default: Access });
    const decide = resolveConsoleAuthorize(load);
    expect(await decide(ctxWith().ctx)).toEqual(FORBIDDEN);
    expect(await decide(ctxWith().ctx)).toEqual({ allowed: true });
  });
});
