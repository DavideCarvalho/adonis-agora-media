import { describe, expect, it, vi } from 'vitest';
import { anyAuthorize, authorizeByToken } from '../../src/dashboard/console_authorize.js';
import {
  DEV_TOOLS_BINDING,
  type DevTool,
  type DevToolsLib,
  MAX_DELETE_KEYS,
  mediaDevTools,
  registerMediaDevTools,
} from '../../src/dashboard/dev_tools.js';
import { DashboardService, type MediaManagerLike } from '../../src/dashboard/service.js';
import type { MediaRecord } from '../../src/media_record.js';

function fakeDisk() {
  return {
    capabilities: { presign: true, multipart: true, publicUrls: true, list: true },
    list: vi.fn(async () => ({
      folders: ['User/'],
      files: [{ key: 'a.txt', name: 'a.txt', sizeBytes: 3, lastModified: null }],
      cursor: 'tok',
    })),
    stat: vi.fn(async () => ({ size: 3, contentType: 'text/plain' })),
    copy: vi.fn(),
    move: vi.fn(),
    deleteMany: vi.fn(async () => {}),
    size: vi.fn(),
    getSignedUrl: vi.fn(async () => 'https://signed.example/a.txt?X-Amz-Signature=secret'),
    getMetaData: vi.fn(async () => ({ contentLength: 3 })),
  };
}

const record: MediaRecord = {
  id: 'm1',
  ownerType: 'User',
  ownerId: '42',
  collection: 'avatar',
  name: 'me',
  fileName: 'me.png',
  mimeType: 'image/png',
  size: 10,
  disk: 's3',
  path: 'User/42/avatar/m1/me.png',
  order: 0,
  customProperties: {},
  conversions: { thumb: { disk: 's3', path: 'User/42/avatar/m1/thumb.webp' } },
  createdAt: new Date('2026-11-01T00:00:00Z'),
  updatedAt: new Date('2026-11-01T00:00:00Z'),
};

function setup(actions = false) {
  const disk = fakeDisk();
  const manager: MediaManagerLike = {
    storage: { defaultDisk: 's3', disk: () => disk as never },
    hasResumable: true,
    resumable: {
      list: vi.fn(async () => [
        { id: 'u1', disk: 's3', key: 'big.mp4', offset: 5, size: 10, parts: 1 },
      ]),
      abort: vi.fn(async () => {}),
      listParts: vi.fn(async () => [{ partNumber: 1, etag: 'e1' }]),
    } as never,
    store: {
      list: vi.fn(async () => ({ items: [record], nextCursor: 'c2' })),
      find: vi.fn(async (id: string) => (id === record.id ? record : null)),
      delete: vi.fn(async () => {}),
      collectionTotals: vi.fn(async () => [{ collection: 'avatar', count: 1, sumSize: 10 }]),
    },
  };
  const service = new DashboardService(manager, { diskNames: ['s3'], actions });
  const tools = mediaDevTools({ service: async () => service, actions });
  const byName = (name: string) => tools.find((tool) => tool.name === name) as DevTool;
  const call = {
    ctx: {} as never,
    caller: { id: 'dev-open', via: 'open' as const },
    limits: { maxRows: 100, maxBytes: 48_000 },
  };
  return { disk, manager, tools, byName, call };
}

describe('media dev tools', () => {
  it('declares the ten tools, every name prefixed by the lib, actions marked destructive', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name)).toEqual([
      'media_list_disks',
      'media_list_objects',
      'media_get_object',
      'media_list_uploads',
      'media_get_upload',
      'media_list_collections',
      'media_get_collections_summary',
      'media_get_media',
      'media_abort_upload',
      'media_delete_objects',
    ]);
    for (const tool of tools) {
      expect(tool.name.startsWith('media_')).toBe(true);
      expect(tool.input.type).toBe('object');
      if (tool.kind === 'action') expect(tool.destructive).toBe(true);
    }
  });

  it('lists objects as { items, next } with folders and files, paged by cursor', async () => {
    const { byName, call, disk } = setup();
    const out = await byName('media_list_objects').run(
      { disk: 's3', prefix: 'User/', cursor: 'prev', limit: 500 },
      call,
    );
    expect(disk.list).toHaveBeenCalledWith('User/', { delimiter: '/', cursor: 'prev', limit: 100 });
    expect(out).toEqual({
      items: [
        { type: 'folder', name: 'User', prefix: 'User/' },
        { type: 'file', key: 'a.txt', name: 'a.txt', sizeBytes: 3, lastModified: null },
      ],
      next: 'tok',
    });
  });

  it('never returns a signed URL: get_object and get_media carry no url', async () => {
    const { byName, call, disk } = setup();
    const object = await byName('media_get_object').run({ disk: 's3', key: 'a.txt' }, call);
    const media = await byName('media_get_media').run({ id: 'm1' }, call);
    expect(disk.getSignedUrl).not.toHaveBeenCalled();
    expect(JSON.stringify([object, media])).not.toMatch(/https?:|url/i);
    expect(object).toEqual({
      object: { key: 'a.txt', size: 3, contentType: 'text/plain' },
      insights: [],
    });
    expect((media as { record: { conversions: string[] } }).record.conversions).toEqual(['thumb']);
  });

  it('reads uploads, upload detail, collections and the summary through the console service', async () => {
    const { byName, call, manager } = setup();
    expect(await byName('media_list_uploads').run({}, call)).toMatchObject({
      items: [{ id: 'u1', percent: 50 }],
    });
    expect(await byName('media_get_upload').run({ id: 'u1' }, call)).toMatchObject({
      upload: { id: 'u1' },
      parts: [{ partNumber: 1, etag: 'e1' }],
    });
    const page = await byName('media_list_collections').run(
      { collection: 'avatar', ownerType: 'User', ownerId: '42', limit: 5 },
      call,
    );
    expect(manager.store.list).toHaveBeenCalledWith({
      collection: 'avatar',
      ownerType: 'User',
      ownerId: '42',
      limit: 5,
    });
    expect(page).toMatchObject({ items: [{ id: 'm1' }], next: 'c2' });
    expect(await byName('media_get_collections_summary').run({}, call)).toEqual({
      items: [{ key: 'avatar', count: 1, sumSize: 10 }],
    });
  });

  it('turns a service error into a tool error', async () => {
    const { byName, call } = setup();
    await expect(byName('media_get_media').run({ id: 'nope' }, call)).rejects.toThrow(
      'unknown media record: nope',
    );
    await expect(byName('media_list_objects').run({}, call)).rejects.toThrow('disk is required');
  });

  it('actions are unavailable while the console has actions off', async () => {
    const off = setup(false);
    expect(await off.byName('media_abort_upload').available?.()).toBe(false);
    expect(await off.byName('media_delete_objects').available?.()).toBe(false);
    const on = setup(true);
    expect(await on.byName('media_abort_upload').available?.()).toBe(true);
  });

  it('runs the actions, capping delete at the documented number of keys', async () => {
    const { byName, call, disk, manager } = setup(true);
    expect(await byName('media_abort_upload').run({ id: 'u1' }, call)).toEqual({ ok: true });
    expect(manager.resumable.abort).toHaveBeenCalledWith('u1');
    expect(
      await byName('media_delete_objects').run({ disk: 's3', keys: ['a', 'b'] }, call),
    ).toEqual({ deleted: 2 });
    expect(disk.deleteMany).toHaveBeenCalledWith(['a', 'b']);
    const tooMany = Array.from({ length: MAX_DELETE_KEYS + 1 }, (_, i) => `k${i}`);
    await expect(
      byName('media_delete_objects').run({ disk: 's3', keys: tooMany }, call),
    ).rejects.toThrow(`at most ${MAX_DELETE_KEYS}`);
  });
});

describe('registerMediaDevTools', () => {
  const options = {
    authorize: async () => ({ allowed: true }) as const,
    service: async () => ({}) as never,
    actions: false,
  };

  it('does nothing without the hub binding', async () => {
    const container = { hasBinding: () => false, make: vi.fn() };
    expect(await registerMediaDevTools(container, options)).toBe(false);
    expect(container.make).not.toHaveBeenCalled();
  });

  it('registers the media lib into a v1 hub, with the console gate', async () => {
    const registered: DevToolsLib[] = [];
    const hub = { version: 1 as const, register: (lib: DevToolsLib) => registered.push(lib) };
    const container = {
      hasBinding: (key: string) => key === DEV_TOOLS_BINDING,
      make: async () => hub,
    };
    expect(await registerMediaDevTools(container, options)).toBe(true);
    expect(registered).toHaveLength(1);
    expect(registered[0]?.lib).toBe('media');
    expect(registered[0]?.authorize).toBe(options.authorize);
    expect(registered[0]?.tools).toHaveLength(10);
  });

  it('skips a hub of another version', async () => {
    const hub = { version: 2, register: vi.fn() };
    const container = { hasBinding: () => true, make: async () => hub };
    expect(await registerMediaDevTools(container, options)).toBe(false);
    expect(hub.register).not.toHaveBeenCalled();
  });
});

describe('MediaDashboardProvider registers its dev tools', () => {
  function app(config: Record<string, unknown>, hub: unknown, inProduction = false) {
    return {
      inProduction,
      config: { get: (key: string, def: unknown) => config[key] ?? def },
      container: {
        hasBinding: (key: string) => key === DEV_TOOLS_BINDING && hub !== undefined,
        make: vi.fn(async (key: unknown) => (key === DEV_TOOLS_BINDING ? hub : { warn: vi.fn() })),
      },
      booted: vi.fn(async () => {}),
    };
  }

  it('gates the tools with the console authorize; open outside production when omitted', async () => {
    const { default: Provider } = await import('../../providers/dashboard_provider.js');
    const registered: DevToolsLib[] = [];
    const hub = { version: 1, register: (lib: DevToolsLib) => registered.push(lib) };
    await new Provider(app({}, hub) as never).boot();
    expect(await registered[0]?.authorize({} as never)).toEqual({ allowed: true });

    registered.length = 0;
    await new Provider(app({}, hub, true) as never).boot();
    expect(await registered[0]?.authorize({} as never)).toMatchObject({ allowed: false });

    registered.length = 0;
    const authorize = authorizeByToken({ token: 's3cret' });
    await new Provider(app({ media_dashboard: { authorize } }, hub, true) as never).boot();
    const ctx = (header?: string) => ({ request: { header: () => header } }) as never;
    expect(await registered[0]?.authorize(ctx('Bearer s3cret'))).toEqual({ allowed: true });
    expect(await registered[0]?.authorize(ctx())).toMatchObject({
      allowed: false,
      reason: 'unauthenticated',
    });
  });

  it('a disabled console registers no tools', async () => {
    const { default: Provider } = await import('../../providers/dashboard_provider.js');
    const hub = { version: 1, register: vi.fn() };
    await new Provider(app({ media_dashboard: { enabled: false } }, hub) as never).boot();
    expect(hub.register).not.toHaveBeenCalled();
  });

  it('a hub that throws does not break boot', async () => {
    const { default: Provider } = await import('../../providers/dashboard_provider.js');
    const hub = {
      version: 1,
      register: () => {
        throw new Error('duplicate lib');
      },
    };
    const fake = app({}, hub);
    await expect(new Provider(fake as never).boot()).resolves.toBeUndefined();
    expect(fake.booted).toHaveBeenCalled();
  });
});

describe('anyAuthorize', () => {
  const ctx = (header?: string) => ({ request: { header: () => header } }) as never;

  it('allows when any authorizer allows, tried in order', async () => {
    const authorize = anyAuthorize(authorizeByToken({ token: 't' }), () => false);
    expect(await authorize(ctx('Bearer t'))).toEqual({ allowed: true });
  });

  it('prefers a redirect, then unauthenticated, then forbidden', async () => {
    expect(
      await anyAuthorize(
        () => false,
        () => ({ redirectTo: '/login' }),
      )(ctx()),
    ).toEqual({
      redirectTo: '/login',
    });
    expect(await anyAuthorize(() => false, authorizeByToken({ token: 't' }))(ctx())).toEqual({
      allowed: false,
      reason: 'unauthenticated',
    });
    const throwing = () => {
      throw new Error('boom');
    };
    expect(await anyAuthorize(throwing, () => false)(ctx())).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
  });

  it('needs at least one authorizer', () => {
    expect(() => anyAuthorize()).toThrow('at least one');
  });
});
