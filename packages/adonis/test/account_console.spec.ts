import { readdirSync, readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizers } from '../src/access.js';
import type {
  AccountExtension,
  AccountExtensionContext,
  ListItem,
} from '../src/account_console/contract.js';
import {
  type MediaAccountConsoleOptions,
  mediaAccountExtension,
} from '../src/account_console/extension.js';
import { handleAccountUpload } from '../src/account_console/upload_endpoint.js';
import { issueUploadTicket, verifyUploadTicket } from '../src/account_console/upload_ticket.js';
import { resolveMediaTenancy, type TenantFilter } from '../src/agora/tenancy.js';
import { MediaManager } from '../src/media_manager.js';
import { InMemoryDisk } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

const SECRET = 'test-secret';
const own = {
  read: authorizers.owner({ ownerTypes: ['User'] }),
  write: authorizers.authenticated(),
};

function setup(
  options: Partial<MediaAccountConsoleOptions> = {},
  extra: { tenancy?: ReturnType<typeof resolveMediaTenancy> } = {},
) {
  const disk = new InMemoryDisk('https://cdn.test');
  const media = new MediaManager({
    defaultDisk: 'fs',
    resolve: () => disk,
    store: new InMemoryMediaStore(),
    emitDiagnostics: false,
    collections: [
      { name: 'documents', access: own },
      { name: 'avatar', single: true, access: own },
      { name: 'readonly', access: { read: authorizers.owner() } },
      { name: 'private', access: own },
    ],
    ...(extra.tenancy ? { tenancy: extra.tenancy } : {}),
  });
  const extension = mediaAccountExtension({
    media: async () => media,
    options: { collections: ['documents', 'avatar', 'readonly'], ...options },
    secret: SECRET,
  });
  return { media, extension, disk };
}

function ctx(over: Partial<AccountExtensionContext> = {}): AccountExtensionContext {
  return {
    account: { id: '42', email: 'a@b.c', name: 'A', roles: [] },
    activeOrg: null,
    impersonatedBy: null,
    locale: 'en',
    query: {},
    url: (id) => `/account/${id}`,
    make: async () => undefined,
    now: () => new Date(),
    ...over,
  };
}

const page = (extension: AccountExtension) => {
  const found = extension.pages[0];
  if (!found) throw new Error('no page');
  return found;
};

async function attach(media: MediaManager, ownerId: string, collection = 'documents') {
  return media.library.attach({
    ownerType: 'User',
    ownerId,
    collection,
    fileName: 'report.txt',
    mimeType: 'text/plain',
    contents: Buffer.from('hello'),
  });
}

function listItems(blocks: readonly { kind: string }[]): ListItem[] {
  const list = blocks.find((b) => b.kind === 'list') as { items: ListItem[] } | undefined;
  return list?.items ?? [];
}

describe('media account console: My files', () => {
  it('exposes nothing until collections are listed', () => {
    const ext = mediaAccountExtension({
      media: async () => ({}) as never,
      options: { collections: [] },
      secret: SECRET,
    });
    expect(ext.pages).toEqual([]);
    expect(ext.id).toBe('media');
    for (const locale of Object.values(ext.messages ?? {})) {
      for (const key of Object.keys(locale)) expect(key.startsWith('media.')).toBe(true);
    }
  });

  it("lists the account's own files in the active collection, with tabs, links and actions", async () => {
    const { media, extension } = setup();
    const mine = await attach(media, '42');
    await attach(media, '7');
    await attach(media, '42', 'private');
    const view = await page(extension).load(ctx());
    expect(view.tabs?.map((t) => t.id)).toEqual(['documents', 'avatar', 'readonly']);
    const items = listItems(view.blocks);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: mine.name,
      external: true,
      actions: [
        { action: 'rename', target: mine.id },
        { action: 'delete', target: mine.id },
      ],
    });
    expect(items[0]?.href).toMatch(/^https:\/\/cdn\.test\/.*signature/);
    const upload = view.blocks.find((b) => b.kind === 'component') as {
      provider: string;
      scripts: Array<{ src: string }>;
      props: { endpoint: string; ticket: string; sameOrigin: boolean };
      submit: { action: string };
    };
    expect(upload.provider).toBe('media-upload');
    expect(upload.scripts[0]?.src).toBe('/media/account/upload.js');
    expect(upload.props.endpoint).toBe('/media/account/uploads');
    expect(upload.submit).toEqual({ action: 'upload' });
    expect(verifyUploadTicket(SECRET, upload.props.ticket)).toMatchObject({
      ownerType: 'User',
      ownerId: '42',
      collection: 'documents',
    });
  });

  it("honours each collection's rules: no write rule, no upload/rename/delete", async () => {
    const { media, extension } = setup();
    const file = await attach(media, '42', 'readonly');
    const view = await page(extension).load(ctx({ query: { tab: 'readonly' } }));
    expect(view.blocks.some((b) => b.kind === 'component')).toBe(false);
    const items = listItems(view.blocks);
    expect(items[0]?.actions).toBeUndefined();
    const result = await page(extension).actions?.rename?.handle(ctx(), {
      target: file.id,
      fields: { name: 'x' },
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('per-collection switches turn single operations off', async () => {
    const { media, extension } = setup({
      collections: [{ name: 'documents', upload: false, delete: false, download: false }],
    });
    await attach(media, '42');
    const view = await page(extension).load(ctx());
    expect(view.tabs).toBeUndefined();
    expect(view.blocks.some((b) => b.kind === 'component')).toBe(false);
    const item = listItems(view.blocks)[0];
    expect(item?.href).toBeUndefined();
    expect(item?.actions?.map((a) => a.action)).toEqual(['rename']);
  });

  it('renames and deletes its own file; another account, an unlisted collection or no id is 404', async () => {
    const { media, extension } = setup();
    const mine = await attach(media, '42');
    const theirs = await attach(media, '7');
    const hidden = await attach(media, '42', 'private');
    const { rename, delete: remove } = page(extension).actions ?? {};
    expect(remove?.sudo).toBe(true);
    expect(remove?.confirm).toBeDefined();
    for (const target of [theirs.id, hidden.id, 'nope', null]) {
      expect(await rename?.handle(ctx(), { target, fields: { name: 'x' } })).toMatchObject({
        ok: false,
        status: 404,
      });
      expect(await remove?.handle(ctx(), { target, fields: {} })).toMatchObject({ status: 404 });
    }
    expect(await rename?.handle(ctx(), { target: mine.id, fields: { name: 'Q3' } })).toMatchObject({
      ok: true,
    });
    expect((await media.library.find(mine.id))?.name).toBe('Q3');
    expect(
      await remove?.handle(ctx({ impersonatedBy: 'admin' }), { target: mine.id, fields: {} }),
    ).toMatchObject({ status: 403 });
    expect(await remove?.handle(ctx(), { target: mine.id, fields: {} })).toMatchObject({
      ok: true,
    });
    expect(await media.library.find(mine.id)).toBeNull();
  });

  it('uses the subject authkit mapped, or the owner hook', async () => {
    const { media, extension } = setup();
    await attach(media, 'u-9');
    const viaSubject = await page(extension).load(ctx({ subject: { type: 'User', id: 'u-9' } }));
    expect(listItems(viaSubject.blocks)).toHaveLength(1);
    const hooked = setup({ owner: () => ({ type: 'User', id: 'u-9' }) });
    await attach(hooked.media, 'u-9');
    expect(listItems((await page(hooked.extension).load(ctx())).blocks)).toHaveLength(1);
  });

  it('pages with the cursor', async () => {
    const { media, extension } = setup({ pageSize: 1 });
    await attach(media, '42');
    await attach(media, '42');
    const first = await page(extension).load(ctx());
    const list = first.blocks.find((b) => b.kind === 'list') as { nextCursor: string | null };
    expect(list.nextCursor).not.toBeNull();
    const second = await page(extension).load(
      ctx({ query: { cursor: list.nextCursor as string } }),
    );
    expect(listItems(second.blocks)).toHaveLength(1);
  });

  it('points scripts, endpoint and links at publicUrl for remote pages', async () => {
    const { extension } = setup({ publicUrl: 'https://app.example.com/' });
    expect(extension.scriptOrigins).toEqual(['https://app.example.com']);
    const view = await page(extension).load(ctx());
    const upload = view.blocks.find((b) => b.kind === 'component') as {
      scripts: Array<{ src: string }>;
      props: { endpoint: string; sameOrigin: boolean };
    };
    expect(upload.scripts[0]?.src).toBe('https://app.example.com/media/account/upload.js');
    expect(upload.props).toMatchObject({
      endpoint: 'https://app.example.com/media/account/uploads',
      sameOrigin: false,
    });
  });
});

describe('account upload endpoint', () => {
  const request = (headers: Record<string, string>, body = 'hello') => ({
    header: (name: string) => headers[name.toLowerCase()],
    body: Readable.from([Buffer.from(body)]),
  });

  it('stores the file for the ticket owner, then the upload action confirms it', async () => {
    const { media, extension } = setup();
    const options = { collections: ['documents'] };
    const ticket = issueUploadTicket(SECRET, {
      ownerType: 'User',
      ownerId: '42',
      collection: 'documents',
      expiresAt: Date.now() + 60_000,
    });
    const res = await handleAccountUpload(
      request({
        'x-media-upload-ticket': ticket,
        'x-file-name': encodeURIComponent('notes é.txt'),
        'content-type': 'text/plain',
        'content-length': '5',
      }),
      { media: async () => media, options, secret: SECRET },
    );
    expect(res.status).toBe(201);
    const id = (res.body as { id: string }).id;
    const record = await media.library.find(id);
    expect(record).toMatchObject({
      ownerId: '42',
      collection: 'documents',
      fileName: 'notes é.txt',
    });
    expect(
      await page(extension).actions?.upload?.handle(ctx(), { target: null, fields: { media: id } }),
    ).toMatchObject({ ok: true });
    expect(
      await page(extension).actions?.upload?.handle(
        ctx({ account: { id: '7', email: null, name: null, roles: [] } }),
        {
          target: null,
          fields: { media: id },
        },
      ),
    ).toMatchObject({ status: 404 });
  });

  it('refuses a forged or expired ticket, an unlisted collection and an oversized file', async () => {
    const { media } = setup();
    const deps = {
      media: async () => media,
      options: { collections: ['documents'], maxUploadBytes: 4 },
      secret: SECRET,
    };
    const ticket = (collection = 'documents', expiresAt = Date.now() + 60_000) =>
      issueUploadTicket(SECRET, { ownerType: 'User', ownerId: '42', collection, expiresAt });
    const headers = (t: string, length = '3') => ({
      'x-media-upload-ticket': t,
      'content-length': length,
      'content-type': 'text/plain',
    });
    expect((await handleAccountUpload(request(headers(`${ticket()}x`)), deps)).status).toBe(401);
    expect(
      (await handleAccountUpload(request(headers(ticket('documents', Date.now() - 1))), deps))
        .status,
    ).toBe(401);
    expect(
      (
        await handleAccountUpload(
          request(
            headers(
              issueUploadTicket('other', {
                ownerType: 'User',
                ownerId: '1',
                collection: 'documents',
                expiresAt: Date.now() + 1000,
              }),
            ),
          ),
          deps,
        )
      ).status,
    ).toBe(401);
    expect((await handleAccountUpload(request(headers(ticket('private'))), deps)).status).toBe(403);
    expect((await handleAccountUpload(request(headers(ticket(), '5')), deps)).status).toBe(413);
  });
});

describe('account console with tenancy', () => {
  const SLOT = Symbol.for('@agora/context:tenancy');
  let filter: TenantFilter = { mode: 'system' };
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[SLOT];
  });

  it("shows only the active organization's files and stamps uploads with it", async () => {
    (globalThis as Record<symbol, unknown>)[SLOT] = {
      version: 1,
      tenancy: () => ({ enabled: true }),
      tenantFilter: () => filter,
      withTenant: <T>(tenant: { id: string; kind: string } | null, fn: () => T) => {
        const previous = filter;
        filter = tenant
          ? { mode: 'tenant', tenant: { ...tenant, source: 'app' } }
          : { mode: 'tenantless' };
        try {
          return fn();
        } finally {
          filter = previous;
        }
      },
    };
    const { media, extension } = setup({}, { tenancy: resolveMediaTenancy(undefined) });
    filter = { mode: 'tenant', tenant: { id: 'acme', kind: 'organization', source: 'app' } };
    const acme = await attach(media, '42');
    filter = { mode: 'tenantless' };
    await attach(media, '42');
    filter = { mode: 'system' };
    const inAcme = ctx({ tenant: { id: 'acme', kind: 'organization' } });
    const items = listItems((await page(extension).load(inAcme)).blocks);
    expect(items).toHaveLength(1);
    expect(items[0]?.actions?.[0]?.target).toBe(acme.id);
    expect(
      await page(extension).actions?.rename?.handle(ctx(), {
        target: acme.id,
        fields: { name: 'x' },
      }),
    ).toMatchObject({ status: 404 });

    const upload = (await page(extension).load(inAcme)).blocks.find(
      (b) => b.kind === 'component',
    ) as { props: { ticket: string } };
    expect(verifyUploadTicket(SECRET, upload.props.ticket)).toMatchObject({
      tenantId: 'acme',
      tenantKind: 'organization',
    });
    const res = await handleAccountUpload(
      {
        header: (name: string) =>
          ({
            'x-media-upload-ticket': upload.props.ticket,
            'content-length': '2',
            'content-type': 'text/plain',
          })[name.toLowerCase()],
        body: Readable.from([Buffer.from('hi')]),
      },
      { media: async () => media, options: { collections: ['documents'] }, secret: SECRET },
    );
    const stored = await media.store.find((res.body as { id: string }).id);
    expect(stored?.tenantId).toBe('acme');
    expect(stored?.path.startsWith('t/acme/')).toBe(true);
  });
});

describe('MediaProvider registers the page', () => {
  function app(config: Record<string, unknown>, registry?: unknown) {
    return {
      config: { get: (key: string, def: unknown) => (key === 'media' ? config : def) },
      container: {
        hasBinding: (key: string) => key === 'authkit.accountExtensions' && registry !== undefined,
        make: vi.fn(async (key: string) => (key === 'authkit.accountExtensions' ? registry : {})),
        singleton: vi.fn(),
      },
      booted: vi.fn(async () => {}),
    };
  }

  it('only with the registry and listed collections', async () => {
    const { default: MediaProvider } = await import('../providers/media_provider.js');
    const registry = { contract: 1, register: vi.fn() };
    await new MediaProvider(
      app({ accountConsole: { collections: ['documents'] } }, registry) as never,
    ).boot();
    expect(registry.register).toHaveBeenCalledTimes(1);
    expect(registry.register.mock.calls[0]?.[0]).toMatchObject({ id: 'media', contract: 1 });

    const none = { contract: 1, register: vi.fn() };
    await new MediaProvider(app({ accountConsole: false }, none) as never).boot();
    await new MediaProvider(app({ accountConsole: { collections: [] } }, none) as never).boot();
    await new MediaProvider(app({}, none) as never).boot();
    expect(none.register).not.toHaveBeenCalled();
    // Without authkit: no registry, nothing happens.
    await expect(
      new MediaProvider(app({ accountConsole: { collections: ['documents'] } }) as never).boot(),
    ).resolves.toBeUndefined();
  });

  it('never imports authkit at runtime', () => {
    const dir = new URL('../src/account_console/', import.meta.url);
    for (const file of readdirSync(dir)) {
      const source = readFileSync(new URL(file, dir), 'utf8');
      expect(source).not.toMatch(/from '@adonis-agora\/authkit/);
    }
  });
});

describe('MediaStore.listByOwnerPaged', () => {
  it('pages one owner across collections, newest first, on both stores', async () => {
    const { makeMemoryDatabase } = await import('./lucid_helpers.js');
    const { LucidMediaStore } = await import('../src/stores/lucid.js');
    const db = makeMemoryDatabase();
    try {
      for (const store of [new InMemoryMediaStore(), new LucidMediaStore(db)]) {
        const base = {
          ownerType: 'User',
          name: 'n',
          fileName: 'f',
          mimeType: 'text/plain',
          size: 1,
          disk: 'fs',
          order: 0,
          customProperties: {},
          conversions: {},
          updatedAt: new Date(),
        };
        let t = 0;
        const save = (id: string, ownerId: string, collection: string) =>
          store.save({
            ...base,
            id,
            ownerId,
            collection,
            path: id,
            createdAt: new Date(++t * 1000),
          });
        await save('a', '1', 'docs');
        await save('b', '1', 'avatar');
        await save('c', '1', 'other');
        await save('d', '2', 'docs');
        await save('e', '1', 'docs');
        const first = await store.listByOwnerPaged('User', '1', {
          collections: ['docs', 'avatar'],
          limit: 2,
        });
        expect(first.items.map((r) => r.id)).toEqual(['e', 'b']);
        const second = await store.listByOwnerPaged('User', '1', {
          collections: ['docs', 'avatar'],
          limit: 2,
          cursor: first.nextCursor as string,
        });
        expect(second.items.map((r) => r.id)).toEqual(['a']);
        expect(second.nextCursor).toBeNull();
        expect((await store.listByOwnerPaged('User', '1', { collections: [] })).items).toEqual([]);
      }
    } finally {
      await db.manager.closeAll();
    }
  });
});
