import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authorizers } from '../src/access.js';
import {
  type ResolvedMediaTenancy,
  resolveMediaTenancy,
  type TenantFilter,
} from '../src/agora/tenancy.js';
import { normalizeConsoleAuthorizeResult } from '../src/dashboard/console_authorize.js';
import { DashboardService } from '../src/dashboard/service.js';
import {
  consoleKeyPrefixes,
  resolveConsoleTenantScope,
  scopedManager,
} from '../src/dashboard/tenant_scope.js';
import { findUnscoped } from '../src/internal_symbols.js';
import { MediaLibrary } from '../src/media_library.js';
import { MediaManager } from '../src/media_manager.js';
import { StorageManager } from '../src/storage_manager.js';
import { LucidMediaStore, MediaTenancySchemaError } from '../src/stores/lucid.js';
import { tenantScopedSessionStore, tenantScopedStore } from '../src/tenant_scoped_store.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import { InMemoryUploadSessionStore } from '../src/testing/in_memory_upload_session_store.js';
import { makeMemoryDatabase, runMediaMigration, runTenancyMigration } from './lucid_helpers.js';

const SLOT = Symbol.for('@agora/context:tenancy');
let filter: TenantFilter = { mode: 'system' };
let enabled = true;

function inTenant(id: string | null) {
  filter =
    id === null
      ? { mode: 'tenantless' }
      : { mode: 'tenant', tenant: { id, kind: 'organization', source: 'authkit' } };
}

beforeEach(() => {
  enabled = true;
  filter = { mode: 'system' };
  (globalThis as Record<symbol, unknown>)[SLOT] = {
    version: 1,
    tenancy: () => ({ enabled }),
    tenantFilter: () => filter,
    withTenant: <T>(_t: unknown, fn: () => T) => fn(),
    allTenants: <T>(fn: () => T) => {
      const previous = filter;
      filter = { mode: 'all' };
      try {
        return fn();
      } finally {
        filter = previous;
      }
    },
  };
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SLOT];
});

function library(tenancy: ResolvedMediaTenancy, store = new InMemoryMediaStore()) {
  const { resolve } = inMemoryDiskResolver(['fs']);
  let n = 0;
  const lib = new MediaLibrary({
    storage: new StorageManager({ default: 'fs', resolve }),
    store,
    idGenerator: () => `m${++n}`,
    emitDiagnostics: false,
    tenancy,
    collections: [
      { name: 'docs' },
      { name: 'logos', access: { read: 'public' } },
      { name: 'avatar', single: true },
    ],
  });
  return { lib, store };
}

const file = (collection = 'docs', extra: Record<string, unknown> = {}) => ({
  ownerType: 'User',
  ownerId: '1',
  collection,
  fileName: 'a.txt',
  mimeType: 'text/plain',
  contents: Buffer.from('hi'),
  ...extra,
});

describe('resolveMediaTenancy', () => {
  it('is off without context, when context is off, or with tenancy: false', () => {
    delete (globalThis as Record<symbol, unknown>)[SLOT];
    expect(resolveMediaTenancy(undefined).enabled).toBe(false);
    beforeEachSlot();
    enabled = false;
    expect(resolveMediaTenancy('inherit').enabled).toBe(false);
    enabled = true;
    expect(resolveMediaTenancy(false).enabled).toBe(false);
    expect(resolveMediaTenancy({ enabled: false }).enabled).toBe(false);
  });

  it('inherits context and defaults to prefixed paths and tenantless null rows', () => {
    expect(resolveMediaTenancy(undefined)).toEqual({
      enabled: true,
      nullRows: 'tenantless',
      pathPrefix: true,
    });
    expect(resolveMediaTenancy({ pathPrefix: false, nullRows: 'shared', kinds: ['org'] })).toEqual({
      enabled: true,
      kinds: ['org'],
      nullRows: 'shared',
      pathPrefix: false,
    });
  });
});

function beforeEachSlot() {
  (globalThis as Record<symbol, unknown>)[SLOT] = {
    version: 1,
    tenancy: () => ({ enabled }),
    tenantFilter: () => filter,
  };
}

describe('MediaLibrary with tenancy', () => {
  const on = (): ResolvedMediaTenancy => resolveMediaTenancy(undefined);

  it('stamps the active tenant and stores new files under t/<tenant>/', async () => {
    const { lib } = library(on());
    inTenant('acme');
    const record = await lib.attach(file());
    expect(record.tenantId).toBe('acme');
    expect(record.path).toBe('t/acme/User/1/docs/m1/a.txt');
  });

  it("matches §4: another tenant's file is not found, tenantless sees only no-tenant files", async () => {
    const { lib } = library(on());
    inTenant('acme');
    const a = await lib.attach(file());
    inTenant(null);
    const none = await lib.attach(file());
    expect(none.tenantId).toBeNull();
    expect(none.path).toBe('User/1/docs/m2/a.txt');

    inTenant('globex');
    expect(await lib.find(a.id)).toBeNull();
    expect(await lib.find(none.id)).toBeNull();
    expect(await lib.list('User', '1')).toEqual([]);
    inTenant(null);
    expect((await lib.list('User', '1')).map((r) => r.id)).toEqual([none.id]);
    inTenant('acme');
    expect((await lib.list('User', '1')).map((r) => r.id)).toEqual([a.id]);
    // Inside allTenants / system: everything.
    filter = { mode: 'all' };
    expect(await lib.list('User', '1')).toHaveLength(2);
    // A signed delivery looks across tenants.
    inTenant('globex');
    expect((await lib[findUnscoped](a.id))?.id).toBe(a.id);
  });

  it('keeps public collections readable from every tenant', async () => {
    const { lib } = library(on());
    inTenant('acme');
    const logo = await lib.attach(file('logos'));
    inTenant(null);
    expect((await lib.find(logo.id))?.id).toBe(logo.id);
  });

  it('an explicit tenantId wins; delete of an invisible file is a no-op', async () => {
    const { lib, store } = library(on());
    inTenant('acme');
    const r = await lib.attach(file('docs', { tenantId: 'other' }));
    expect(r.tenantId).toBe('other');
    expect(r.path.startsWith('t/other/')).toBe(true);
    await lib.delete(r.id);
    expect(await store.find(r.id)).not.toBeNull();
  });

  it('replaces a single-file collection only inside the tenant', async () => {
    const { lib, store } = library(on());
    inTenant('acme');
    await lib.attach(file('avatar'));
    inTenant('globex');
    await lib.attach(file('avatar'));
    const all = await store.listByOwner('User', '1', 'avatar');
    expect(all.map((r) => r.tenantId).sort()).toEqual(['acme', 'globex']);
  });

  it("orders a tenant's files without counting other tenants'", async () => {
    const { lib } = library(on());
    inTenant('acme');
    await lib.attach(file());
    await lib.attach(file());
    inTenant('globex');
    expect((await lib.attach(file())).order).toBe(0);
  });

  it('with pathPrefix: false, paths stay as before', async () => {
    const { lib } = library(resolveMediaTenancy({ pathPrefix: false }));
    inTenant('acme');
    expect((await lib.attach(file())).path).toBe('User/1/docs/m1/a.txt');
  });

  it('tenancy off: nothing stamped, filtered or prefixed', async () => {
    const { lib } = library(resolveMediaTenancy(false));
    inTenant('acme');
    const r = await lib.attach(file());
    expect('tenantId' in r).toBe(false);
    inTenant('globex');
    expect((await lib.find(r.id))?.id).toBe(r.id);
  });
});

describe('tenant-scoped stores', () => {
  it('confine list and totals, and hide sessions of other tenants', async () => {
    const store = new InMemoryMediaStore();
    const base = {
      ownerType: 'U',
      ownerId: '1',
      name: 'n',
      fileName: 'f',
      mimeType: 'text/plain',
      size: 1,
      disk: 'fs',
      order: 0,
      customProperties: {},
      conversions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await store.save({ ...base, id: 'a', collection: 'docs', path: 'a', tenantId: 'acme' });
    await store.save({ ...base, id: 'b', collection: 'docs', path: 'b', tenantId: 'globex' });
    await store.save({ ...base, id: 'c', collection: 'docs', path: 'c', tenantId: null });
    const scoped = tenantScopedStore(store, {
      scope: () => ({ tenants: ['acme'], includeNull: true }),
    });
    expect((await scoped.list()).items.map((r) => r.id).sort()).toEqual(['a', 'c']);
    expect(await scoped.collectionTotals?.()).toEqual([
      { collection: 'docs', count: 2, sumSize: 2 },
    ]);
    expect(await store.listTenants()).toEqual(['acme', 'globex']);

    const sessions = new InMemoryUploadSessionStore();
    let stamp: string | null = 'acme';
    const scopedSessions = tenantScopedSessionStore(sessions, {
      scope: () => ({ tenants: [stamp ?? ''], includeNull: false }),
      stamp: () => stamp,
    });
    const s = await scopedSessions.create({
      id: 's1',
      disk: 'fs',
      key: 'k',
      contentType: undefined,
      size: 1,
      offset: 0,
      parts: 0,
    });
    expect(s.tenantId).toBe('acme');
    stamp = 'globex';
    expect(await scopedSessions.get('s1')).toBeNull();
    expect(await scopedSessions.list?.()).toEqual([]);
  });
});

describe('MediaManager upload sessions with tenancy', () => {
  it('stamps resumable sessions and hides them from other tenants', async () => {
    const { resolve } = inMemoryDiskResolver(['fs']);
    const media = new MediaManager({
      defaultDisk: 'fs',
      resolve,
      store: new InMemoryMediaStore(),
      uploadSessions: new InMemoryUploadSessionStore(),
      emitDiagnostics: false,
      tenancy: resolveMediaTenancy(undefined),
    });
    inTenant('acme');
    const session = await media.resumable.createUpload({ disk: 'fs', key: 'x.bin', size: 2 });
    expect(session.tenantId).toBe('acme');
    inTenant('globex');
    expect(await media.resumable.list()).toEqual([]);
    expect(media.tenancy.enabled).toBe(true);
  });
});

describe('authorizers.sameTenant', () => {
  it('compares the record tenant with the identity tenant; writes pass', async () => {
    const rule = authorizers.sameTenant();
    const record = { tenantId: 'acme' } as never;
    const ask = (tenantId: string | null, action: 'read' | 'write' = 'read') =>
      rule({ ctx: {}, action, collection: 'c', record, subject: { id: '1', tenantId } });
    expect(await ask('acme')).toBe(true);
    expect(await ask('globex')).toBe(false);
    expect(await ask(null, 'write')).toBe(true);
  });
});

describe('console tenant scope', () => {
  it('resolves grant, own tenant and pick; a forged pick sees nothing', () => {
    expect(
      resolveConsoleTenantScope({ granted: undefined, own: { id: 'acme' }, selected: undefined })
        .ids,
    ).toEqual(['acme']);
    expect(
      resolveConsoleTenantScope({ granted: undefined, own: undefined, selected: undefined }),
    ).toMatchObject({ authorized: 'none', ids: [] });
    expect(
      resolveConsoleTenantScope({ granted: '*', own: undefined, selected: undefined }).ids,
    ).toBeUndefined();
    expect(
      resolveConsoleTenantScope({ granted: '*', own: undefined, selected: 'globex' }).ids,
    ).toEqual(['globex']);
    expect(
      resolveConsoleTenantScope({ granted: ['acme'], own: undefined, selected: 'globex' }),
    ).toMatchObject({ ids: [], forged: true });
  });

  it('authorize may grant tenants', () => {
    expect(normalizeConsoleAuthorizeResult({ allowed: true, tenants: '*' })).toEqual({
      allowed: true,
      tenants: '*',
    });
    expect(
      normalizeConsoleAuthorizeResult({ allowed: true, tenants: ['a', 3, '', ' a ', ' b'] }),
    ).toEqual({
      allowed: true,
      tenants: ['a', 'b'],
    });
  });

  it("confines the console: other tenants' records and keys read as missing", async () => {
    const store = new InMemoryMediaStore();
    const now = new Date();
    await store.save({
      id: 'a',
      ownerType: 'U',
      ownerId: '1',
      collection: 'docs',
      name: 'n',
      fileName: 'f',
      mimeType: 'text/plain',
      size: 1,
      disk: 'fs',
      path: 't/globex/x',
      order: 0,
      customProperties: {},
      conversions: {},
      createdAt: now,
      updatedAt: now,
      tenantId: 'globex',
    });
    const disk = {
      capabilities: { presign: true, multipart: false, publicUrls: false, list: true },
      list: async () => ({ folders: [], files: [] }),
      stat: async () => ({ size: 1 }),
      copy: async () => {},
      move: async () => {},
      deleteMany: async () => {},
      size: async () => 1,
    };
    const manager = {
      storage: { defaultDisk: 'fs', disk: () => disk as never },
      hasResumable: false,
      resumable: { list: async () => [], abort: async () => {}, listParts: async () => [] },
      store,
    };
    const ids = ['acme'];
    const svc = new DashboardService(scopedManager(manager, ids), {
      diskNames: ['fs'],
      actions: true,
      keyPrefixes: consoleKeyPrefixes(ids) as string[],
    });
    await expect(svc.mediaRecord('a')).rejects.toThrow('unknown media record');
    expect((await svc.collections()).items).toEqual([]);
    expect((await svc.objects('fs')).folders).toEqual([{ name: 't', prefix: 't/' }]);
    expect((await svc.objects('fs', { prefix: 't/' })).folders).toEqual([
      { name: 'acme', prefix: 't/acme/' },
    ]);
    await expect(svc.objects('fs', { prefix: 't/globex/' })).rejects.toThrow('not found');
    await expect(svc.remove({ disk: 'fs', keys: ['t/globex/x'] })).rejects.toThrow('not found');
    await expect(svc.objectMeta('fs', 't/acme/y')).resolves.toMatchObject({ key: 't/acme/y' });
    const none = new DashboardService(scopedManager(manager, []), {
      diskNames: ['fs'],
      actions: false,
      keyPrefixes: [],
    });
    expect((await none.objects('fs')).folders).toEqual([]);
  });
});

describe('LucidMediaStore with the tenant column', () => {
  it('round-trips tenant_id and filters by tenantIds after the tenancy migration', async () => {
    const db = makeMemoryDatabase();
    try {
      await runMediaMigration(db);
      const store = new LucidMediaStore(db, { autoCreateSchema: false, tenantColumn: true });
      const now = new Date();
      const base = {
        ownerType: 'U',
        ownerId: '1',
        collection: 'docs',
        name: 'n',
        fileName: 'f',
        mimeType: 'text/plain',
        size: 1,
        disk: 'fs',
        order: 0,
        customProperties: {},
        conversions: {},
        createdAt: now,
        updatedAt: now,
      };
      await expect(store.save({ ...base, id: 'x', path: 'x' })).rejects.toBeInstanceOf(
        MediaTenancySchemaError,
      );
      await runTenancyMigration(db);
      await store.save({ ...base, id: 'a', path: 'a', tenantId: 'acme' });
      await store.save({ ...base, id: 'b', path: 'b', tenantId: null });
      expect((await store.find('a'))?.tenantId).toBe('acme');
      expect((await store.list({ tenantIds: ['acme'] })).items.map((r) => r.id)).toEqual(['a']);
      expect((await store.list({ tenantIds: [null] })).items.map((r) => r.id)).toEqual(['b']);
      expect(await store.list({ tenantIds: [] })).toMatchObject({ items: [] });
      expect(await store.collectionTotals({ tenantIds: ['acme'] })).toEqual([
        { collection: 'docs', count: 1, sumSize: 1 },
      ]);
      expect(await store.listTenants()).toEqual(['acme']);
    } finally {
      await db.manager.closeAll();
    }
  });

  it('auto-creates the column with autoCreateSchema; never touches it with tenancy off', async () => {
    const db = makeMemoryDatabase();
    try {
      const store = new LucidMediaStore(db, { tenantColumn: true });
      const now = new Date();
      await store.save({
        id: 'a',
        ownerType: 'U',
        ownerId: '1',
        collection: 'docs',
        name: 'n',
        fileName: 'f',
        mimeType: 'text/plain',
        size: 1,
        disk: 'fs',
        path: 'a',
        order: 0,
        customProperties: {},
        conversions: {},
        createdAt: now,
        updatedAt: now,
        tenantId: 'acme',
      });
      expect((await store.find('a'))?.tenantId).toBe('acme');
      const off = new LucidMediaStore(db, { table: 'media_off' });
      await off.save({ ...(await store.find('a'))!, id: 'b' });
      expect('tenantId' in ((await off.find('b')) ?? {})).toBe(false);
    } finally {
      await db.manager.closeAll();
    }
  });
});

describe('signed delivery across tenants', () => {
  it('only a verified signature widens the lookup; a bogus one stays not found', async () => {
    (globalThis as Record<symbol, unknown>)[SLOT] = {
      version: 1,
      tenancy: () => ({ enabled: true }),
      tenantFilter: () => filter,
    };
    const { resolve } = inMemoryDiskResolver(['fs']);
    const media = new MediaManager({
      defaultDisk: 'fs',
      resolve,
      store: new InMemoryMediaStore(),
      emitDiagnostics: false,
      tenancy: resolveMediaTenancy(undefined),
      collections: [{ name: 'docs', access: { read: () => false } }],
      deliverySigning: { secret: 'shh' },
    });
    inTenant('acme');
    const record = await media.library.attach(file());
    const url = media.library.deliveryUrl(record.id);
    const query = Object.fromEntries(new URL(url, 'http://x').searchParams);
    inTenant('globex');
    const answer = (qs: Record<string, string>) => {
      const out: { status?: number } = {};
      const response = {
        status: (code: number) => {
          out.status = code;
          return { json: () => undefined };
        },
        header: () => undefined,
        redirect: () => {
          out.status = 302;
        },
        stream: () => {
          out.status = 200;
        },
      };
      return media.access
        .serve(
          { params: {}, request: { qs: () => qs, header: () => undefined }, response },
          record.id,
        )
        .then(() => out.status);
    };
    expect(await answer({ ...query, sig: 'bogus' })).toBe(404);
    expect(await answer({})).toBe(404);
    expect([200, 302]).toContain(await answer(query));
  });
});
