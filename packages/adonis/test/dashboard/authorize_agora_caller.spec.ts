import { describe, expect, it } from 'vitest';
import {
  authorizeAgoraCaller,
  capabilityAllows,
  resolveConsoleAuthorize,
} from '../../src/dashboard/console_authorize.js';

function ctx(options: {
  caller?: { app: string; capabilities: string[] };
  method?: string;
  route?: string;
}) {
  return {
    agora: options.caller ? { caller: options.caller } : {},
    route: { name: options.route ?? 'media.dashboard.object.raw' },
    request: { method: () => options.method ?? 'GET', header: () => undefined },
  } as never;
}

describe('capabilityAllows (the Agora wildcard rule)', () => {
  it.each([
    ['media:objects:read', 'media:objects:read', true],
    ['media:*', 'media:objects:read', true],
    ['media:*', 'media', true],
    ['*', 'media:objects:read', true],
    ['media:*:read', 'media:objects:read', true],
    ['media:*:read', 'media:read', false],
    ['media:objects', 'media:objects:read', false],
    ['media:objects:read', 'media:objects', false],
    ['payments:*', 'media:objects:read', false],
  ])('%s covers %s → %s', (granted, required, expected) => {
    expect(capabilityAllows(granted, required)).toBe(expected);
  });
});

describe('authorizeAgoraCaller', () => {
  const check = resolveConsoleAuthorize(authorizeAgoraCaller({ apps: ['agora-hub'] }));
  const hub = { app: 'agora-hub', capabilities: ['media:objects:read'] };

  it('lets the named app read object bytes, across tenants', async () => {
    expect(await check(ctx({ caller: hub }))).toEqual({ allowed: true, tenants: '*' });
    expect(
      await check(ctx({ caller: { app: 'agora-hub', capabilities: ['media:*'] } })),
    ).toMatchObject({ allowed: true });
  });

  it('answers 401 with no caller, 403 for anything else', async () => {
    expect(await check(ctx({}))).toMatchObject({ allowed: false, status: 401 });
    const forbidden = { allowed: false, status: 403 };
    expect(await check(ctx({ caller: { ...hub, app: 'lumen' } }))).toMatchObject(forbidden);
    expect(
      await check(ctx({ caller: { ...hub, capabilities: ['media:records:read'] } })),
    ).toMatchObject(forbidden);
    expect(await check(ctx({ caller: hub, route: 'media.dashboard.objects' }))).toMatchObject(
      forbidden,
    );
    expect(await check(ctx({ caller: hub, method: 'POST' }))).toMatchObject(forbidden);
  });
});
