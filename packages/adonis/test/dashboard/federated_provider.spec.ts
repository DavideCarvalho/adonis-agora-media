import { describe, expect, it, vi } from 'vitest';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import type { MediaRecord } from '../../src/media_record.js';
import { InMemoryMediaStore } from '../../src/testing/in_memory_media_store.js';
import { RedisBus } from '../support/redis_bus.js';

/** The provider's routes as registered, called with a plain `ctx` double. */
function makeFakeRouter() {
  const routes = new Map<string, (ctx: unknown) => Promise<unknown>>();
  const names = new Map<string, string>();
  const groups: Array<{ middleware: unknown[] }> = [];
  const router: Record<string, unknown> = {};
  for (const method of ['get', 'post']) {
    router[method] = vi.fn((path: string, handler: (ctx: unknown) => Promise<unknown>) => {
      const route = `${method.toUpperCase()} ${path}`;
      routes.set(route, handler);
      const chain = {
        as: vi.fn((name: string) => {
          names.set(route, name);
          return chain;
        }),
      };
      return chain;
    });
  }
  router.group = vi.fn((cb: () => void) => {
    cb();
    const g = {
      middleware: [] as unknown[],
      prefix: vi.fn().mockReturnThis(),
      use: vi.fn((mw: unknown) => {
        g.middleware.push(...(Array.isArray(mw) ? mw : [mw]));
        return g;
      }),
    };
    groups.push(g);
    return g;
  });
  return { router, routes, names, groups };
}

function record(id: string): MediaRecord {
  return {
    id,
    ownerType: 'User',
    ownerId: '1',
    collection: 'avatar',
    name: id,
    fileName: `${id}.png`,
    mimeType: 'image/png',
    size: 1,
    disk: 'fs',
    path: `${id}.png`,
    order: 0,
    customProperties: {},
    conversions: {},
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
  };
}

async function boot(
  config: Record<string, unknown>,
  appConfig: Record<string, unknown> = {},
  logger?: { info?: (line: string) => void; warn?: (line: string) => void },
) {
  const { default: MediaDashboardProvider } = await import('../../providers/dashboard_provider.js');
  const { router, routes, names, groups } = makeFakeRouter();
  const localStore = new InMemoryMediaStore();
  await localStore.save(record('hub-1'));
  const manager = {
    storage: { defaultDisk: 'fs', disk: () => ({}) },
    hasResumable: false,
    store: localStore,
  };
  const booted: Array<() => Promise<void>> = [];
  const app = {
    config: {
      get: (key: string, def: unknown) =>
        key === 'media_dashboard' ? config : key in appConfig ? appConfig[key] : def,
    },
    container: {
      make: async (token: unknown) => {
        if (token === 'router') return router;
        if (token === 'logger') return logger ?? Promise.reject(new Error('no logger'));
        if (token === 'redis')
          return appConfig.redisService ?? Promise.reject(new Error('no redis'));
        return manager;
      },
    },
    booted: async (handler: () => Promise<void>) => void booted.push(handler),
    inProduction: false,
  };
  const warnings: string[] = [];
  const provider = new MediaDashboardProvider(app as never);
  vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
  await provider.boot();
  for (const hook of booted) await hook();

  const call = async (
    route: string,
    qs: Record<string, unknown> = {},
  ): Promise<{
    status: number;
    body: unknown;
    location?: string;
    headers?: Record<string, string>;
  }> => {
    const handler = routes.get(route);
    if (!handler) throw new Error(`no route ${route}`);
    let status = 200;
    let body: unknown;
    let location: string | undefined;
    const headers: Record<string, string> = {};
    let streamed = false;
    const ctx = {
      route: { name: names.get(route) },
      request: {
        method: () => route.split(' ')[0],
        qs: () => qs,
        input: (key: string) => qs[key],
        body: () => qs,
        url: () => route,
        header: () => undefined,
      },
      response: {
        header: (name: string, value: string) => {
          headers[name] = value;
          return ctx.response;
        },
        stream: async (stream: AsyncIterable<Uint8Array>) => {
          streamed = true;
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          body = Buffer.concat(chunks).toString();
        },
        getHeader: () => undefined,
        status: (code: number) => {
          status = code;
          return { json: (payload: unknown) => (body = payload), send: () => undefined };
        },
        redirect: (to: string) => {
          status = 302;
          location = to;
        },
      },
    };
    // The API group's `authorize` gate first, when there is one, like the router runs it.
    const gate = groups[0]?.middleware[0] as
      | ((ctx: unknown, next: () => Promise<void>) => Promise<void>)
      | undefined;
    let passed = !gate;
    if (gate) {
      await gate(ctx, async () => {
        passed = true;
      });
    }
    if (passed) await handler(ctx);
    return {
      status,
      body,
      ...(location !== undefined ? { location } : {}),
      ...(streamed ? { headers } : {}),
    };
  };
  return { call, provider, warnings };
}

describe('MediaDashboardProvider — federated console (`apps`, `?app=`)', () => {
  const owningApp = async () => {
    const bus = new RedisBus();
    const store = new InMemoryMediaStore();
    await store.save(record('et-1'));
    await new RedisConsoleChannel({ client: bus.connection(), prefix: 'et' }).answer(
      async (command) => {
        if (command.verb === 'objectUrls') return ['/media/api/object/raw?disk=fs&key=a.png'];
        throw Object.assign(new Error('nope'), { status: 404 });
      },
    );
    return {
      store,
      entry: {
        label: 'Entre Textos',
        store,
        controlPlane: new RedisConsoleChannel({ client: bus.connection(), prefix: 'et' }),
        origin: 'https://et.example',
      },
    };
  };

  it('lists the apps, reads the picked one, and answers 404 for an unknown app', async () => {
    const et = await owningApp();
    const { call, provider } = await boot({ appLabel: 'Hub', apps: { 'entre-textos': et.entry } });

    expect((await call('GET /apps')).body).toEqual({
      local: { label: 'Hub' },
      apps: [{ id: 'entre-textos', label: 'Entre Textos', mode: 'federated', actions: 'none' }],
      selected: null,
    });
    const own = await call('GET /collections', {});
    expect((own.body as { data: Array<{ id: string }> }).data.map((e) => e.id)).toEqual(['hub-1']);
    const other = await call('GET /collections', { app: 'entre-textos' });
    expect((other.body as { data: Array<{ id: string }> }).data.map((e) => e.id)).toEqual(['et-1']);
    expect(await call('GET /collections', { app: 'nope' })).toEqual({
      status: 404,
      body: { error: 'unknown app' },
    });
    expect((await call('GET /tenants', { app: 'entre-textos' })).body).toMatchObject({
      mode: 'off',
    });
    expect(
      await call('GET /object/raw', { app: 'entre-textos', disk: 'fs', key: 'a.png' }),
    ).toEqual({
      status: 302,
      body: undefined,
      location: 'https://et.example/media/api/object/raw?disk=fs&key=a.png',
    });
    // Actions stay off until this console turns them on.
    expect(await call('POST /media-record/delete', { app: 'entre-textos', id: 'et-1' })).toEqual({
      status: 403,
      body: { error: 'actions are disabled on this console' },
    });
    await provider.shutdown();
  });

  it('streams the app bytes itself with `proxyObjects`, downloading active content', async () => {
    const et = await owningApp();
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } });
    });
    try {
      const { call, provider } = await boot({
        apps: {
          'entre-textos': {
            ...et.entry,
            proxyObjects: { headers: () => ({ authorization: 'Bearer svc' }) },
          },
        },
      });
      const raw = await call('GET /object/raw', { app: 'entre-textos', disk: 'fs', key: 'a.png' });
      expect(raw).toMatchObject({ status: 200, body: '<svg/>' });
      expect(raw.headers).toMatchObject({
        'content-type': 'image/svg+xml',
        'content-disposition': 'attachment',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
      });
      expect(seen).toEqual([
        { url: 'https://et.example/media/api/object/raw?disk=fs&key=a.png', auth: 'Bearer svc' },
      ]);
      await provider.shutdown();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('says who runs actions per app, and forwards them with `proxyActions`', async () => {
    const et = await owningApp();
    const seen: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      seen.push({ url: String(input), method: init?.method, body: init?.body });
      return new Response(null, { status: 204 });
    });
    try {
      const { call, provider } = await boot({
        apps: {
          'entre-textos': { ...et.entry, proxyActions: { apiPath: '/media/api' } },
          muted: { ...et.entry, label: 'Muted', proxyActions: true, actions: false },
          redis: { ...et.entry, label: 'Redis' },
        },
      });
      expect((await call('GET /apps')).body).toMatchObject({
        apps: [
          { id: 'entre-textos', mode: 'federated', actions: 'app' },
          { id: 'muted', mode: 'federated', actions: 'none' },
          { id: 'redis', mode: 'federated', actions: 'none' },
        ],
      });
      expect(await call('POST /media-record/delete', { app: 'entre-textos', id: 'et-1' })).toEqual({
        status: 204,
        body: undefined,
      });
      expect(seen).toEqual([
        {
          url: 'https://et.example/media/api/media-record/delete',
          method: 'POST',
          body: JSON.stringify({ id: 'et-1' }),
        },
      ]);
      expect((await call('GET /topology', { app: 'entre-textos' })).body).toMatchObject({
        actions: true,
      });
      expect((await call('POST /media-record/delete', { app: 'muted', id: 'et-1' })).status).toBe(
        403,
      );
      expect(seen).toHaveLength(1);
      await provider.shutdown();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("follows this console's `actions` for an app without `proxyActions`", async () => {
    const et = await owningApp();
    const { call, provider } = await boot({ actions: true, apps: { 'entre-textos': et.entry } });
    expect((await call('GET /apps')).body).toMatchObject({
      apps: [{ id: 'entre-textos', actions: 'app' }],
    });
    await provider.shutdown();
  });

  it('runs an action an app caller sends, and logs the app and the viewer it names', async () => {
    const { authorizeAppCaller, permitAll } = await import(
      '../../src/dashboard/console_authorize.js'
    );
    const infos: string[] = [];
    const { call } = await boot(
      {
        actions: true,
        authorize: authorizeAppCaller({
          identify: () => ({ app: 'agora-hub' }),
          permit: permitAll(),
        }),
      },
      {},
      { info: (line: string) => infos.push(line) },
    );
    expect((await call('POST /media-record/delete', { id: 'hub-1' })).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(infos.join('\n')).toContain('federated console: POST /media-record/delete by');
    expect(infos.join('\n')).toContain('from app agora-hub');
  });

  it('keeps an empty `apps` grant (an app caller) to this app only', async () => {
    const et = await owningApp();
    const { call, provider } = await boot({
      authorize: () => ({ allowed: true, tenants: '*', apps: [] }),
      apps: { 'entre-textos': et.entry },
    });
    expect(
      await call('GET /object/raw', { app: 'entre-textos', disk: 'fs', key: 'a.png' }),
    ).toEqual({ status: 404, body: { error: 'unknown app' } });
    expect((await call('GET /apps')).body).toMatchObject({ apps: [] });
    await provider.shutdown();
  });

  it('hides the apps an `authorize` grant does not name', async () => {
    const et = await owningApp();
    const { call } = await boot({
      appLabel: 'Hub',
      apps: { 'entre-textos': et.entry, eduliberta: { ...et.entry, label: 'EduLiberta' } },
      authorize: () => ({ allowed: true, apps: ['eduliberta'] }),
    });
    expect((await call('GET /apps')).body).toMatchObject({
      apps: [{ id: 'eduliberta', label: 'EduLiberta', mode: 'federated' }],
    });
    expect((await call('GET /collections', { app: 'entre-textos' })).status).toBe(404);
    expect((await call('GET /collections', { app: 'eduliberta' })).status).toBe(200);
  });

  it('reads no `?app=` without `apps`: the Organization picker stays the local one', async () => {
    const { call } = await boot({});
    expect((await call('GET /tenants', { app: 'entre-textos' })).body).toEqual(
      (await call('GET /tenants', {})).body,
    );
  });

  it('fails the boot on a misconfigured app, not its first request', async () => {
    const et = await owningApp();
    const redis = { redis: { connection: 'main', connections: { main: {}, cache: {} } } };
    const plane = (controlPlane: unknown) => ({
      apps: { et: { ...et.entry, controlPlane } },
    });
    await expect(boot(plane({ connection: 'main', prefix: '' }), redis)).rejects.toThrow(
      /apps\["et"\]: `controlPlane.prefix`/,
    );
    await expect(boot(plane({ connection: 'nope', prefix: 'et' }), redis)).rejects.toThrow(
      /"nope" is not a connection of config\/redis.ts \(main, cache\)/,
    );
    await expect(boot(plane({ prefix: 'et' }), {})).rejects.toThrow(/needs @adonisjs\/redis/);
    await expect(boot({ apps: { et: { ...et.entry, timeoutMs: 0 } } })).rejects.toThrow(
      /`timeoutMs` must be a positive number/,
    );
    await expect(
      boot({ apps: { et: { ...et.entry, origin: undefined, proxyActions: true } } }),
    ).rejects.toThrow(/`proxyActions` needs `origin`/);
    await expect(
      boot({ apps: { et: { ...et.entry, proxyActions: { apiPath: 'https://x.example/api' } } } }),
    ).rejects.toThrow(/`proxyActions.apiPath` must be a path/);
    await expect(boot({ apps: { et: { ...et.entry, actions: 'yes' } } })).rejects.toThrow(
      /`actions` must be a boolean/,
    );
    await expect(boot({ apps: { et: { ...et.entry, origin: 'et.example' } } })).rejects.toThrow(
      /`origin` must be an http\(s\) origin/,
    );
    await expect(
      boot({ apps: { et: { ...et.entry, origin: 'https://et.example/media' } } }),
    ).rejects.toThrow(/`origin` must be an http\(s\) origin/);
    // Valid: the default connection, and an origin with a trailing slash.
    await boot(plane({ prefix: 'et' }), redis);
    await boot({ apps: { et: { ...et.entry, origin: 'https://et.example/' } } });
  });

  it('answers a 503 naming the app when it cannot be built, and retries on the next request', async () => {
    const et = await owningApp();
    let builds = 0;
    const { call, warnings } = await boot({
      apps: {
        et: {
          ...et.entry,
          store: async () => {
            builds++;
            if (builds === 1) throw new Error('connection "pg2" is not defined');
            return et.store;
          },
        },
      },
    });
    expect(await call('GET /collections', { app: 'et' })).toEqual({
      status: 503,
      body: { error: 'Entre Textos: the console could not reach this app' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warnings.join('\n')).toContain('connection "pg2" is not defined');
    expect((await call('GET /collections', { app: 'et' })).status).toBe(200);
  });

  it('refuses an app key that cannot travel in the URL', async () => {
    const et = await owningApp();
    await expect(boot({ apps: { 'entre textos': et.entry } })).rejects.toThrow(
      /not a valid app key/,
    );
  });
});
