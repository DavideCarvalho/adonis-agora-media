import type { Server } from 'node:http';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig } from '../../src/define_config.js';
import {
  MediaControlPlaneError,
  MediaNotFoundError,
  MediaTenantUnsupportedError,
} from '../../src/errors.js';
import { MediaManager } from '../../src/media_manager.js';
import { FakeImageProcessor } from '../../src/testing/fake_image_processor.js';
import { InMemoryDisk } from '../../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../../src/testing/in_memory_media_store.js';
import {
  resolveTenantVerifier,
  sharedSecretVerifier,
  type VerifiedUser,
} from '../../src/topology/auth.js';
import { MediaControlPlane } from '../../src/topology/control_plane.js';
import { partitionStore } from '../../src/topology/partition_store.js';
import { buildTenantManager, standaloneAccountsOf } from '../../src/topology/tenant_manager.js';
import { addressOf, close, serveControlPlane } from './http_harness.js';

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-bytes'),
]);

async function text(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** People's access tokens, as the Hub's issuer would verify them. */
const people: Record<string, VerifiedUser> = {
  'ana-token': { sub: 'ana', scopes: ['openid', 'profile'], clientId: 'entre-textos' },
  'ana-no-profile': { sub: 'ana', scopes: ['openid'], clientId: 'entre-textos' },
  'ana-as-admin': {
    sub: 'ana',
    scopes: ['profile'],
    clientId: 'entre-textos',
    actor: { sub: 'root' },
  },
  'ana-other-client': { sub: 'ana', scopes: ['profile'], clientId: 'lumen' },
};

describe('media topology: a control plane and its tenants, in process', () => {
  let server: Server;
  let base: string;
  const disk = new InMemoryDisk('memory://hub', 'private');
  const hubStore = new InMemoryMediaStore();
  const hub = new MediaManager({
    defaultDisk: 'hub',
    resolve: () => disk,
    store: hubStore,
    imageProcessor: new FakeImageProcessor(),
    topology: 'control-plane',
    deliveryMode: 'proxy',
    collections: [
      { name: 'documents' },
      {
        name: 'photos',
        acceptsMimeTypes: ['image/png', 'image/jpeg'],
        conversions: [
          { name: 'thumb', width: 64, eager: true },
          { name: 'lg', width: 512 },
        ],
      },
      {
        name: 'avatar',
        single: true,
        acceptsMimeTypes: ['image/png'],
        conversions: [{ name: 'md', width: 256, height: 256, eager: true }],
      },
      { name: 'internal' },
    ],
  });

  const tenant = (
    partition: string,
    token: string,
    extra: { urls?: 'app' | 'control-plane'; url?: string } = {},
  ) =>
    buildTenantManager(
      defineConfig({
        topology: 'tenant',
        tenant: {
          url: extra.url ?? `${base}/_media`,
          partition,
          token,
          timeoutMs: 2000,
          ...(extra.urls ? { urls: extra.urls } : {}),
        },
        delivery: { path: '/files/:id' },
      }),
    );

  beforeAll(async () => {
    const plane = new MediaControlPlane({
      library: (partition) => hub.controlPlaneLibrary(partition),
      store: (partition) => partitionStore(hub.store, partition),
      verifyTenant: resolveTenantVerifier(
        sharedSecretVerifier({
          partitions: {
            'entre-textos': 'et-secret',
            eduliberta: 'el-secret',
            reader: { secret: 'ro-secret', capabilities: ['media:read'] },
          },
        }),
      ),
      collections: ['documents', 'photos', 'avatar'],
      deliveryMode: 'proxy',
      maxBytes: 1024,
      accounts: {
        collections: ['avatar'],
        ownerType: 'HubAccount',
        clients: ['entre-textos', 'eduliberta'],
        verifyUser: (token) => people[token] ?? null,
      },
    });
    server = await serveControlPlane((router) => plane.register(router));
    base = addressOf(server);
  });

  afterAll(async () => {
    await close(server);
  });

  it('adds a file from a tenant: stored on the control plane, conversions run there', async () => {
    const et = tenant('entre-textos', 'et-secret');
    const record = await et.library.attach({
      ownerType: 'User',
      ownerId: 42,
      collection: 'photos',
      fileName: 'me.png',
      mimeType: 'image/png',
      contents: png,
    });
    // The tenant sees its own owner type...
    expect(record.ownerType).toBe('User');
    expect(record.ownerId).toBe('42');
    expect(Object.keys(record.conversions)).toEqual(['thumb']);
    // ...the control plane keeps it in the app's partition, files under `<partition>/`.
    const stored = await hubStore.find(record.id);
    expect(stored?.ownerType).toBe('entre-textos/User');
    expect(stored?.path.startsWith('entre-textos/User/42/photos/')).toBe(true);
    expect(disk.files.has(stored!.path)).toBe(true);
    expect(disk.files.has(stored!.conversions.thumb!.path!)).toBe(true);

    // The same API reads it back.
    expect((await et.library.find(record.id))?.fileName).toBe('me.png');
    const listed = await et.library.for('User', 42).list('photos');
    expect(listed.map((r) => r.id)).toEqual([record.id]);
    const page = await et.store.list({ collection: 'photos' });
    expect(page.items.map((r) => r.id)).toContain(record.id);
  });

  it('keeps apps apart: another partition cannot read, list or delete it', async () => {
    const et = tenant('entre-textos', 'et-secret');
    const el = tenant('eduliberta', 'el-secret');
    const record = await et.library.attach({
      ownerType: 'User',
      ownerId: 7,
      collection: 'documents',
      fileName: 'notes.txt',
      mimeType: 'text/plain',
      contents: Buffer.from('hello'),
    });
    expect(await el.library.find(record.id)).toBeNull();
    expect(await el.library.list('User', 7)).toEqual([]);
    await el.library.delete(record.id);
    expect(await et.library.find(record.id)).not.toBeNull();
    await expect(el.library.deliver(record.id)).rejects.toBeInstanceOf(MediaNotFoundError);
  });

  it('delivers the bytes and conversions, generating a lazy one on the control plane', async () => {
    const et = tenant('entre-textos', 'et-secret');
    const record = await et.library.attach({
      ownerType: 'Post',
      ownerId: 'p1',
      collection: 'photos',
      fileName: 'cover.png',
      mimeType: 'image/png',
      contents: png,
    });
    const original = await et.library.deliver(record.id);
    if (original.kind !== 'stream') throw new Error('expected bytes');
    expect(original.mimeType).toBe('image/png');
    expect(original.fileName).toBe('cover.png');
    expect(Buffer.from(await text(original.stream), 'utf8').length).toBeGreaterThan(0);

    const lazy = await et.library.deliver(record.id, { conversion: 'lg' });
    if (lazy.kind !== 'stream') throw new Error('expected bytes');
    expect(await text(lazy.stream)).toBe('fake:lg:512x');
    expect(Object.keys((await hubStore.find(record.id))!.conversions).sort()).toEqual([
      'lg',
      'thumb',
    ]);
  });

  it("points URLs at the app's own delivery route, and image() at the control plane's presets", async () => {
    const et = tenant('entre-textos', 'et-secret');
    const record = await et.library.attach({
      ownerType: 'Post',
      ownerId: 'p2',
      collection: 'photos',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: png,
    });
    expect(await et.library.url(record.id, 'thumb')).toBe(`/files/${record.id}?conversion=thumb`);
    const image = await et.library.image(record.id);
    expect(image.src).toBe(`/files/${record.id}?conversion=thumb`);
    expect(image.srcSet).toBe(`/files/${record.id}?conversion=thumb 64w`);
  });

  it('refuses storage URLs from a control plane that delivers by proxy, and falls back to bytes', async () => {
    const et = tenant('entre-textos', 'et-secret', { urls: 'control-plane' });
    const record = await et.library.attach({
      ownerType: 'Post',
      ownerId: 'p3',
      collection: 'documents',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      contents: Buffer.from('abc'),
    });
    await expect(et.library.signedUrl(record.id, '5m')).rejects.toMatchObject({
      status: 409,
      code: 'E_MEDIA_PROXY_ONLY',
    });
    const delivered = await et.library.deliver(record.id);
    expect(delivered.kind).toBe('stream');
  });

  it('streams an upload of a known size, and renames and deletes it', async () => {
    const et = tenant('entre-textos', 'et-secret');
    const record = await et.library.attach({
      ownerType: 'Post',
      ownerId: 'p4',
      collection: 'documents',
      fileName: 'stream.txt',
      mimeType: 'text/plain',
      contents: Readable.from([Buffer.from('chunk-1 '), Buffer.from('chunk-2')]),
      size: 15,
    });
    expect(record.size).toBe(15);
    // A declared size the body does not match is refused, never stored.
    await expect(
      et.library.attach({
        ownerType: 'Post',
        ownerId: 'p4',
        collection: 'documents',
        fileName: 'liar.txt',
        mimeType: 'text/plain',
        contents: Readable.from([Buffer.from('short')]),
        size: 500,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'E_MEDIA_SIZE_MISMATCH' });
    expect((await et.library.rename(record.id, 'Renamed')).name).toBe('Renamed');
    const stored = (await hubStore.find(record.id))!;
    await et.library.delete(record.id);
    expect(await hubStore.find(record.id)).toBeNull();
    expect(disk.files.has(stored.path)).toBe(false);
    await et.library.delete(record.id); // idempotent
  });

  it("replaces a single-file collection's previous file", async () => {
    const et = tenant('entre-textos', 'et-secret');
    const first = await et.library.attach({
      ownerType: 'User',
      ownerId: 'u1',
      collection: 'avatar',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: png,
    });
    const second = await et.library.attach({
      ownerType: 'User',
      ownerId: 'u1',
      collection: 'avatar',
      fileName: 'b.png',
      mimeType: 'image/png',
      contents: png,
    });
    expect((await et.library.list('User', 'u1', 'avatar')).map((r) => r.id)).toEqual([second.id]);
    expect(await et.library.find(first.id)).toBeNull();
  });

  it("keeps the control plane's refusals: content type, size, collections, capabilities, tokens", async () => {
    const et = tenant('entre-textos', 'et-secret');
    const input = {
      ownerType: 'User',
      ownerId: 1,
      collection: 'photos',
      fileName: 'x.png',
      mimeType: 'image/png',
      contents: Buffer.from('not a png at all'),
    };
    await expect(et.library.attach(input)).rejects.toMatchObject({
      status: 422,
      code: 'E_MEDIA_CONTENT_SIGNATURE_UNRECOGNIZED',
    });
    await expect(
      et.library.attach({ ...input, collection: 'documents', contents: Buffer.alloc(2048) }),
    ).rejects.toMatchObject({ status: 413 });
    await expect(
      et.library.attach({ ...input, collection: 'internal', contents: png }),
    ).rejects.toMatchObject({ status: 403, code: 'E_MEDIA_COLLECTION_NOT_OFFERED' });
    await expect(
      tenant('reader', 'ro-secret').library.attach({ ...input, contents: png }),
    ).rejects.toMatchObject({ status: 403, code: 'E_MEDIA_INSUFFICIENT_SCOPE' });
    await expect(tenant('entre-textos', 'wrong').library.find('x')).rejects.toMatchObject({
      status: 401,
    });
    // The token decides the partition: a secret of one app does not open another's.
    await expect(tenant('eduliberta', 'et-secret').library.find('x')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('fails fast with a clear 503 when the control plane is down', async () => {
    const down = tenant('entre-textos', 'et-secret', { url: 'http://127.0.0.1:9/_media' });
    const started = Date.now();
    await expect(
      down.library.attach({
        ownerType: 'User',
        ownerId: 1,
        collection: 'documents',
        fileName: 'a.txt',
        mimeType: 'text/plain',
        contents: Buffer.from('a'),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof MediaControlPlaneError &&
        error.status === 503 &&
        error.code === 'E_MEDIA_CONTROL_PLANE_UNAVAILABLE',
    );
    await expect(down.library.find('x')).rejects.toMatchObject({ status: 503 });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('looks the URL up again through discovery after a connection error', async () => {
    let calls = 0;
    const discovered = Object.assign(
      async () => {
        calls++;
        return calls === 1 ? 'http://127.0.0.1:9/_media' : `${base}/_media`;
      },
      { refresh: async () => `${base}/_media` },
    );
    const et = buildTenantManager(
      defineConfig({
        topology: 'tenant',
        tenant: { url: discovered, partition: 'entre-textos', token: 'et-secret' },
      }),
    );
    expect(await et.library.find('missing')).toBeNull();
  });

  it('says what a tenant cannot do itself', async () => {
    const et = tenant('entre-textos', 'et-secret');
    expect(() => et.disk()).toThrow(MediaTenantUnsupportedError);
    await expect(
      et.library.attachExisting({
        ownerType: 'User',
        ownerId: 1,
        collection: 'documents',
        key: 'k',
        fileName: 'a',
        mimeType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(MediaTenantUnsupportedError);
    expect(et.topology).toBe('tenant');
    expect(() => et.resumable).toThrow(MediaTenantUnsupportedError);
    expect(() => et.direct).toThrow(MediaTenantUnsupportedError);
  });

  it('fakes a tenant in memory like any other app', async () => {
    const et = tenant('entre-textos', 'et-secret');
    const fake = et.fake();
    await et.library.attach({
      ownerType: 'User',
      ownerId: 1,
      collection: 'documents',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      contents: Buffer.from('a'),
    });
    fake.assertCalled('attach');
    et.restore();
  });

  describe('request input never reaches a header unchecked', () => {
    const get = (path: string, token = 'et-secret', app = 'entre-textos') =>
      fetch(`${base}/_media/v1${path}`, {
        headers: { authorization: `Bearer ${token}`, 'x-media-app': app },
      });
    const photo = async () =>
      tenant('entre-textos', 'et-secret').library.attach({
        ownerType: 'User',
        ownerId: 'etag',
        collection: 'photos',
        fileName: 'e.png',
        mimeType: 'image/png',
        contents: png,
      });

    it('answers 400 for a conversion or a size a header cannot carry, and keeps running', async () => {
      const record = await photo();
      for (const query of [
        'conversion=%0A',
        'conversion=%01',
        'conversion=%E6%97%A5%E6%9C%AC',
        'conversion=a%0D%0Aset-cookie:%20x=1',
        'w=%0A',
        'w=%E6%97%A5%E6%9C%AC',
        'w=abc',
        'w=0',
        'w=99999',
        'w=64&q=%01',
        'w=64&q=500',
      ]) {
        const res = await get(`/records/${record.id}/file?${query}`);
        expect(res.status, query).toBe(400);
        expect(await res.json()).toMatchObject({ code: 'E_MEDIA_BAD_REQUEST' });
      }
      // Still serving, with a header-safe ETag (and one per size and quality).
      const ok = await get(`/records/${record.id}/file?conversion=thumb`);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('etag')).toMatch(/^"[A-Za-z0-9_~.-]+"$/);
      await ok.arrayBuffer();
    });

    it('a tenant delivering by proxy answers its visitor 400, never relays a crash', async () => {
      const record = await photo();
      const et = tenant('entre-textos', 'et-secret');
      for (const conversion of ['\n', '\u0001', '日本']) {
        await expect(et.library.deliver(record.id, { conversion })).rejects.toMatchObject({
          status: 400,
        });
      }
      await expect(et.library.deliver(record.id, { width: '日本' })).rejects.toMatchObject({
        status: 400,
      });
    });

    it('refuses a declared mimeType that is not a type/subtype (it may become a Content-Type)', async () => {
      for (const mimeType of [
        'text/plain\r\nset-cookie: x=1',
        '日本/x',
        'text',
        'text/plain; x=1',
      ]) {
        await expect(
          tenant('entre-textos', 'et-secret').library.attach({
            ownerType: 'User',
            ownerId: 'mime',
            collection: 'documents',
            fileName: 'a.txt',
            mimeType,
            contents: Buffer.from('hi'),
          }),
        ).rejects.toMatchObject({ status: 400 });
      }
    });

    it('generating a conversion needs media:write, a read-only token may not', async () => {
      const record = await photo();
      const post = (token: string, app: string) =>
        fetch(`${base}/_media/v1/records/${record.id}/conversions/lg`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'x-media-app': app },
        });
      expect((await post('ro-secret', 'reader')).status).toBe(403);
      expect(
        (await get(`/records/${record.id}/image?generate=1`, 'ro-secret', 'reader')).status,
      ).toBe(403);
      // The app that may write generates it.
      const made = await post('et-secret', 'entre-textos');
      expect(made.status).toBe(200);
    });
  });

  describe("a person's own files (accounts)", () => {
    it('writes with the person’s token, reads with the app’s, revalidates with the ETag', async () => {
      const et = tenant('entre-textos', 'et-secret');
      const el = tenant('eduliberta', 'el-secret');
      const record = await et.accounts.replace('ana-token', 'avatar', {
        contents: png,
        mimeType: 'image/png',
      });
      expect(record.ownerType).toBe('HubAccount');
      expect(record.ownerId).toBe('ana');
      expect(record.customProperties.source).toBe('entre-textos');

      // Every app reads it (it is the person's, not one app's).
      const read = await el.accounts.read('ana', 'avatar', { conversion: 'md' });
      if (read.kind !== 'file') throw new Error(`expected the file, got ${read.kind}`);
      expect(await text(read.stream)).toBe('fake:md:256x256');
      expect(read.etag).toBeTruthy();
      const again = await el.accounts.read('ana', 'avatar', {
        conversion: 'md',
        ifNoneMatch: read.etag!,
      });
      expect(again.kind).toBe('not-modified');
      expect((await el.accounts.records('ana', 'avatar')).map((r) => r.id)).toEqual([record.id]);

      // Replacing keeps one.
      const second = await el.accounts.replace('ana-token', 'avatar', {
        contents: Readable.from([png]),
        mimeType: 'image/png',
        size: png.length,
      });
      expect((await et.accounts.records('ana', 'avatar')).map((r) => r.id)).toEqual([second.id]);

      await et.accounts.remove('ana-token', 'avatar');
      expect((await et.accounts.read('ana', 'avatar')).kind).toBe('not-found');
      await et.accounts.remove('ana-token', 'avatar'); // idempotent
    });

    it('works from a standalone app that keeps its own media (`accounts`)', async () => {
      const config = defineConfig({
        accounts: { url: `${base}/_media`, partition: 'eduliberta', token: 'el-secret' },
      });
      const ownDisk = new InMemoryDisk('memory://el', 'private');
      const el = new MediaManager({
        defaultDisk: 'own',
        resolve: () => ownDisk,
        store: new InMemoryMediaStore(),
        accounts: standaloneAccountsOf(config)!,
      });
      // Its own files stay here...
      const own = await el.library.attach({
        ownerType: 'User',
        ownerId: 7,
        collection: 'documents',
        fileName: 'a.txt',
        mimeType: 'text/plain',
        contents: Buffer.from('mine'),
      });
      expect(own.ownerType).toBe('User');
      expect(el.topology).toBe('standalone');
      // ...and the person's avatar lives on the control plane.
      const record = await el.accounts.replace('ana-token', 'avatar', {
        contents: png,
        mimeType: 'image/png',
      });
      expect(record.ownerType).toBe('HubAccount');
      const read = await el.accounts.read('ana', 'avatar', { conversion: 'md' });
      expect(read.kind).toBe('file');
      await el.accounts.remove('ana-token', 'avatar');
      expect(standaloneAccountsOf(defineConfig({}))).toBeUndefined();
    });

    it('refuses a token without the scope, an impersonation, another client, or nobody', async () => {
      const et = tenant('entre-textos', 'et-secret');
      const input = { contents: png, mimeType: 'image/png' };
      await expect(et.accounts.replace('ana-no-profile', 'avatar', input)).rejects.toMatchObject({
        status: 403,
      });
      await expect(et.accounts.replace('ana-as-admin', 'avatar', input)).rejects.toMatchObject({
        status: 403,
      });
      await expect(et.accounts.replace('ana-other-client', 'avatar', input)).rejects.toMatchObject({
        status: 403,
      });
      await expect(et.accounts.replace('nobody', 'avatar', input)).rejects.toMatchObject({
        status: 401,
      });
      // Not an account collection.
      await expect(et.accounts.replace('ana-token', 'photos', input)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('serves the file from the app, with 304 and 404', async () => {
      const et = tenant('entre-textos', 'et-secret');
      await et.accounts.replace('ana-token', 'avatar', { contents: png, mimeType: 'image/png' });
      const reply = (ifNoneMatch?: string) => {
        const out: { status: number; headers: Record<string, string>; body?: unknown } = {
          status: 200,
          headers: {},
        };
        const ctx = {
          request: {
            header: (name: string) => (name === 'if-none-match' ? ifNoneMatch : undefined),
          },
          response: {
            status: (code: number) => {
              out.status = code;
            },
            header: (name: string, value: string) => {
              out.headers[name] = value;
            },
            send: (body: unknown) => {
              out.body = body;
            },
            stream: (stream: Readable) => {
              out.body = stream;
            },
          },
        };
        return { out, ctx };
      };
      const first = reply();
      await et.accounts.serve(first.ctx, 'ana', 'avatar', { conversion: 'md' });
      expect(first.out.status).toBe(200);
      expect(first.out.headers['content-type']).toBe('image/webp');
      expect(await text(first.out.body as Readable)).toBe('fake:md:256x256');
      const cached = reply(first.out.headers.etag);
      await et.accounts.serve(cached.ctx, 'ana', 'avatar', { conversion: 'md' });
      expect(cached.out.status).toBe(304);
      const missing = reply();
      await et.accounts.serve(missing.ctx, 'bob', 'avatar');
      expect(missing.out.status).toBe(404);
    });
  });
});
