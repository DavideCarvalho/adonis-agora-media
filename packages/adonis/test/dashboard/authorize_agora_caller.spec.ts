import { describe, expect, it } from 'vitest';
import {
  authorizeAgoraCaller,
  authorizeAppCaller,
  capabilityAllows,
  identifyAgoraCaller,
  identifySharedSecret,
  MEDIA_ACTION_ROUTES,
  mediaCallerCsrfExceptions,
  permitAll,
  permitTokenCapabilities,
  resolveConsoleAuthorize,
} from '../../src/dashboard/console_authorize.js';

function ctx(options: {
  caller?: { app: string; capabilities: string[] };
  method?: string;
  route?: string;
  headers?: Record<string, string>;
}) {
  return {
    agora: options.caller ? { caller: options.caller } : {},
    route: { name: options.route ?? 'media.dashboard.object.raw' },
    request: {
      method: () => options.method ?? 'GET',
      header: (name: string) => options.headers?.[name],
    },
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
    expect(await check(ctx({ caller: hub }))).toEqual({ allowed: true, tenants: '*', apps: [] });
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

describe('authorizeAgoraCaller with `actions`', () => {
  const check = resolveConsoleAuthorize(
    authorizeAgoraCaller({ apps: ['agora-hub'], actions: true }),
  );
  const writer = { app: 'agora-hub', capabilities: ['media:objects:write'] };
  const reader = { app: 'agora-hub', capabilities: ['media:objects:read'] };
  const allowed = { allowed: true, tenants: '*', apps: [] };
  const forbidden = { allowed: false, status: 403 };

  it('names exactly the console action routes', () => {
    expect([...MEDIA_ACTION_ROUTES].sort()).toEqual(
      [
        'media.dashboard.copy',
        'media.dashboard.delete',
        'media.dashboard.folder.copy',
        'media.dashboard.folder.create',
        'media.dashboard.folder.delete',
        'media.dashboard.folder.move',
        'media.dashboard.media_record.delete',
        'media.dashboard.move',
        'media.dashboard.uploads.abort',
      ].sort(),
    );
  });

  it.each(MEDIA_ACTION_ROUTES)(
    'lets a caller holding the write capability POST %s',
    async (route) => {
      expect(await check(ctx({ caller: writer, method: 'POST', route }))).toEqual(allowed);
      expect(
        await check(
          ctx({ caller: { ...writer, capabilities: ['media:*'] }, method: 'POST', route }),
        ),
      ).toEqual(allowed);
    },
  );

  it('keeps reads and writes apart, and every other route closed', async () => {
    const post = (caller: typeof writer, route: string) => ctx({ caller, method: 'POST', route });
    // The read capability does not run actions; the write one does not read bytes.
    expect(await check(post(reader, 'media.dashboard.delete'))).toMatchObject(forbidden);
    expect(await check(ctx({ caller: writer }))).toMatchObject(forbidden);
    expect(await check(ctx({ caller: reader }))).toEqual(allowed);
    // Upload, the Organization switch and reads are not actions; an action route needs POST.
    expect(await check(post(writer, 'media.dashboard.object.upload'))).toMatchObject(forbidden);
    expect(await check(post(writer, 'media.dashboard.tenants.select'))).toMatchObject(forbidden);
    expect(
      await check(ctx({ caller: writer, method: 'GET', route: 'media.dashboard.delete' })),
    ).toMatchObject(forbidden);
    expect(await check(post({ ...writer, app: 'lumen' }, 'media.dashboard.delete'))).toMatchObject(
      forbidden,
    );
    expect(await check(ctx({ method: 'POST', route: 'media.dashboard.delete' }))).toMatchObject({
      allowed: false,
      status: 401,
    });
  });

  it('opens no action without `actions`, and takes another capability', async () => {
    const plain = resolveConsoleAuthorize(authorizeAgoraCaller({ apps: ['agora-hub'] }));
    expect(
      await plain(ctx({ caller: writer, method: 'POST', route: 'media.dashboard.delete' })),
    ).toMatchObject(forbidden);
    const custom = resolveConsoleAuthorize(
      authorizeAgoraCaller({ actions: true, actionsCapability: 'media:admin' }),
    );
    expect(
      await custom(ctx({ caller: writer, method: 'POST', route: 'media.dashboard.delete' })),
    ).toMatchObject(forbidden);
    expect(
      await custom(
        ctx({
          caller: { app: 'x', capabilities: ['media:admin'] },
          method: 'POST',
          route: 'media.dashboard.delete',
        }),
      ),
    ).toEqual(allowed);
  });
});

describe('mediaCallerCsrfExceptions', () => {
  const req = (url: string, headers: Record<string, string>) =>
    ({ request: { url: () => url, header: (name: string) => headers[name] } }) as never;

  it('exempts only a bearer request with no cookie under the console API', () => {
    const opts = { apiBase: '/media/api' };
    expect(
      mediaCallerCsrfExceptions(req('/media/api/delete', { authorization: 'Bearer t' }), opts),
    ).toBe(true);
    expect(
      mediaCallerCsrfExceptions(
        req('/media/api/delete', { authorization: 'Bearer t', cookie: 'adonis-session=x' }),
        opts,
      ),
    ).toBe(false);
    expect(mediaCallerCsrfExceptions(req('/media/api/delete', {}), opts)).toBe(false);
    expect(
      mediaCallerCsrfExceptions(req('/media/api/delete', { authorization: 'Basic x' }), opts),
    ).toBe(false);
    expect(
      mediaCallerCsrfExceptions(req('/media/apix/delete', { authorization: 'Bearer t' }), opts),
    ).toBe(false);
    expect(
      mediaCallerCsrfExceptions(req('/media/dashboard/api/copy', { authorization: 'Bearer t' })),
    ).toBe(true);
  });
});

describe('authorizeAppCaller (identify + permit)', () => {
  const allowed = { allowed: true, tenants: '*', apps: [] };
  const forbidden = { allowed: false, status: 403 };
  const unauthenticated = { allowed: false, status: 401 };
  const raw = (headers: Record<string, string>) => ctx({ headers });
  const act = (headers: Record<string, string>, route = 'media.dashboard.delete') =>
    ctx({ headers, method: 'POST', route });

  it('shared secret + permitAll: a trusted app reads and acts; a wrong or missing secret is a 401', async () => {
    const check = resolveConsoleAuthorize(
      authorizeAppCaller({
        identify: identifySharedSecret({ apps: { hub: 's3cret-hub', lumen: 's3cret-lumen' } }),
        permit: permitAll(),
      }),
    );
    expect(await check(raw({ authorization: 'Bearer s3cret-hub' }))).toEqual(allowed);
    expect(await check(act({ authorization: 'Bearer s3cret-lumen' }))).toEqual(allowed);
    expect(await check(raw({ authorization: 'Bearer nope' }))).toMatchObject(unauthenticated);
    expect(await check(raw({ authorization: 's3cret-hub' }))).toMatchObject(unauthenticated);
    expect(await check(raw({}))).toMatchObject(unauthenticated);
    // Still only the fixed routes.
    expect(
      await check(
        ctx({ headers: { authorization: 'Bearer s3cret-hub' }, route: 'media.dashboard.objects' }),
      ),
    ).toMatchObject(forbidden);
  });

  it('shared secret in another header, and refuses an empty secret at config time', async () => {
    const check = resolveConsoleAuthorize(
      authorizeAppCaller({
        identify: identifySharedSecret({ apps: { hub: 'k' }, header: 'X-Media-Key' }),
        permit: permitAll(),
      }),
    );
    expect(await check(raw({ 'x-media-key': 'k' }))).toEqual(allowed);
    expect(await check(raw({ authorization: 'Bearer k' }))).toMatchObject(unauthenticated);
    expect(() => identifySharedSecret({ apps: { hub: '' } })).toThrow(/non-empty secret/);
    expect(() => identifySharedSecret({ apps: {} })).toThrow(/at least one app/);
  });

  it('authkit identity + token capabilities: a read-only caller cannot act', async () => {
    const check = resolveConsoleAuthorize(
      authorizeAppCaller({ identify: identifyAgoraCaller(), permit: permitTokenCapabilities() }),
    );
    const reader = { app: 'agora-hub', capabilities: ['media:objects:read'] };
    expect(await check(ctx({ caller: reader }))).toEqual(allowed);
    expect(
      await check(ctx({ caller: reader, method: 'POST', route: 'media.dashboard.copy' })),
    ).toMatchObject(forbidden);
    expect(await check(ctx({ method: 'POST', route: 'media.dashboard.copy' }))).toMatchObject(
      unauthenticated,
    );
  });

  it('custom identify + permit (own tables, an authz check): asked the exact permission', async () => {
    const asked: Array<[string, string]> = [];
    const scopes: Record<string, string[]> = {
      hub: ['media:objects:read'],
      ops: ['media:objects:write'],
    };
    const check = resolveConsoleAuthorize(
      authorizeAppCaller({
        identify: async (c) => {
          const key = (c as { request: { header(n: string): string | undefined } }).request.header(
            'x-api-key',
          );
          return key && key in scopes ? { app: key, claims: { row: key } } : undefined;
        },
        permit: async (caller, permission) => {
          asked.push([caller.app, permission]);
          return scopes[caller.app]?.includes(permission) ?? false;
        },
        apps: ['hub', 'ops'],
      }),
    );
    expect(await check(raw({ 'x-api-key': 'hub' }))).toEqual(allowed);
    expect(await check(act({ 'x-api-key': 'hub' }))).toMatchObject(forbidden);
    expect(await check(act({ 'x-api-key': 'ops' }, 'media.dashboard.folder.move'))).toEqual(
      allowed,
    );
    expect(await check(raw({ 'x-api-key': 'ops' }))).toMatchObject(forbidden);
    expect(await check(raw({ 'x-api-key': 'stranger' }))).toMatchObject(unauthenticated);
    expect(asked).toEqual([
      ['hub', 'media:objects:read'],
      ['hub', 'media:objects:write'],
      ['ops', 'media:objects:write'],
      ['ops', 'media:objects:read'],
    ]);
  });

  it('`write: false` opens no action, and `permit` is never asked off the fixed routes', async () => {
    let asked = 0;
    const check = resolveConsoleAuthorize(
      authorizeAppCaller({
        identify: () => ({ app: 'hub' }),
        permit: () => {
          asked++;
          return true;
        },
        write: false,
      }),
    );
    expect(await check(act({}))).toMatchObject(forbidden);
    expect(await check(act({}, 'media.dashboard.object.upload'))).toMatchObject(forbidden);
    expect(asked).toBe(0);
    expect(() => authorizeAppCaller({ identify: () => undefined } as never)).toThrow(/permit/);
  });
});
