import { describe, expect, it } from 'vitest';
import { DashboardError, DashboardService } from '../../src/dashboard/service.js';
import {
  FederatedApp,
  FederatedAppError,
  FederatedConsoleService,
  mediaConsoleCommandHandler,
} from '../../src/federation/console.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import type { MediaRecord } from '../../src/media_record.js';
import { InMemoryMediaStore } from '../../src/testing/in_memory_media_store.js';
import { InMemoryUploadSessionStore } from '../../src/testing/in_memory_upload_session_store.js';
import { RedisBus } from '../support/redis_bus.js';

function record(over: Partial<MediaRecord>): MediaRecord {
  return {
    id: 'r1',
    ownerType: 'User',
    ownerId: '1',
    collection: 'avatar',
    name: 'me',
    fileName: 'me.png',
    mimeType: 'image/png',
    size: 10,
    disk: 'fs',
    path: 'avatars/me.png',
    order: 0,
    customProperties: {},
    conversions: {},
    createdAt: new Date(1_000),
    updatedAt: new Date(1_000),
    ...over,
  };
}

/** An extended disk (list/stat/copy/move/deleteMany) over a Map: the owning app's storage. */
function memoryDisk() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    capabilities: { presign: true, multipart: false, publicUrls: false, list: true },
    async put(key: string, bytes: Uint8Array) {
      files.set(key, bytes);
    },
    async list(prefix: string) {
      const keys = [...files.keys()].filter((k) => k.startsWith(prefix));
      return {
        folders: [],
        files: keys.map((key) => ({ key, name: key.split('/').pop() ?? key, sizeBytes: 1 })),
      };
    },
    async size(key: string) {
      return files.get(key)?.length ?? 0;
    },
    async stat(key: string) {
      if (!files.has(key)) throw new Error(`ENOENT ${key}`);
      return { size: files.get(key)?.length ?? 0, contentType: 'image/png' };
    },
    async getSignedUrl(key: string) {
      return `https://bucket.invalid/${key}?sig=1`;
    },
    async copy(from: string, to: string) {
      files.set(to, files.get(from) as Uint8Array);
    },
    async move(from: string, to: string) {
      files.set(to, files.get(from) as Uint8Array);
      files.delete(from);
    },
    async deleteMany(keys: string[]) {
      for (const key of keys) files.delete(key);
    },
    async delete(key: string) {
      files.delete(key);
    },
  };
}

/**
 * The owning app ("Entre Textos"): its store, its disk, and `instances` processes answering on the
 * bus. `objectUrls: 'proxy'` like the real one: its URLs are paths on its own console.
 */
async function owningApp(
  bus: RedisBus,
  options: { actions: boolean; instances?: number; strategy?: 'proxy' | 'auto' },
) {
  const store = new InMemoryMediaStore();
  const disk = memoryDisk();
  const runs: string[] = [];
  const log: string[] = [];
  const service = async () =>
    new DashboardService(
      {
        storage: { defaultDisk: 'fs', disk: () => disk as never },
        hasResumable: false,
        resumable: { list: async () => [], abort: async () => {}, listParts: async () => [] },
        store,
      },
      {
        diskNames: ['fs'],
        actions: options.actions,
        objectUrls: { strategy: options.strategy ?? 'proxy', apiBasePath: '/media/api' },
      },
    );
  for (let i = 0; i < (options.instances ?? 1); i++) {
    const handler = mediaConsoleCommandHandler({
      service,
      actions: options.actions,
      log: (line) => log.push(line),
    });
    await new RedisConsoleChannel({ client: bus.connection(), prefix: 'entretextos' }).answer(
      async (command) => {
        runs.push(`${i}:${command.verb}`);
        return handler(command);
      },
    );
  }
  return { store, disk, runs, log };
}

function hubConsole(
  bus: RedisBus,
  store: InMemoryMediaStore,
  options: {
    actions?: boolean;
    origin?: string;
    timeoutMs?: number;
    proxyObjects?: ConstructorParameters<typeof FederatedApp>[0]['proxyObjects'];
    fetch?: typeof fetch;
  } = {},
) {
  const sessions = new InMemoryUploadSessionStore();
  const app = new FederatedApp({
    id: 'entre-textos',
    label: 'Entre Textos',
    store,
    sessions,
    channel: new RedisConsoleChannel({ client: bus.connection(), prefix: 'entretextos' }),
    ...(options.origin !== undefined ? { origin: options.origin } : {}),
    timeoutMs: options.timeoutMs ?? 2_000,
    ...(options.proxyObjects !== undefined ? { proxyObjects: options.proxyObjects } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
  });
  return {
    app,
    sessions,
    console: new FederatedConsoleService(app, {
      actions: options.actions ?? true,
      actor: 'ana@hub',
      rawUrl: (disk, key) =>
        `/media/api/object/raw?${new URLSearchParams({ app: 'entre-textos', disk, key })}`,
    }),
  };
}

const commandsSent = (bus: RedisBus) =>
  bus.published.filter((p) => p.channel === 'entretextos-media-console');

describe('federated media console', () => {
  it('reads records and collections from the app store, without asking the app', async () => {
    const bus = new RedisBus();
    const store = new InMemoryMediaStore();
    await store.save(record({ id: 'a', collection: 'avatar', size: 3 }));
    await store.save(record({ id: 'b', collection: 'documents', size: 7 }));
    const { console } = hubConsole(bus, store);

    const page = await console.collections({ collection: 'documents' });
    expect(page.data.map((e) => e.id)).toEqual(['b']);
    expect((await console.collectionsSummary()).data).toEqual(
      expect.arrayContaining([
        { key: 'avatar', count: 1, sumSize: 3 },
        { key: 'documents', count: 1, sumSize: 7 },
      ]),
    );
    expect((await console.mediaEntry('a')).collection).toBe('avatar');
    expect(await console.uploads()).toEqual({ data: [] });
    expect(commandsSent(bus)).toEqual([]);
  });

  it('asks the app for its disks, objects and URLs, made absolute on its origin', async () => {
    const bus = new RedisBus();
    const owner = await owningApp(bus, { actions: false });
    await owner.disk.put('avatars/me.png', new Uint8Array([1]));
    await owner.store.save(
      record({
        id: 'r1',
        conversions: { thumbnail: { disk: 'fs', path: 'avatars/me-thumb.png' } as never },
      }),
    );
    const { console } = hubConsole(bus, owner.store, { origin: 'https://et.example/' });

    expect(await console.topology()).toEqual({
      disks: 1,
      hasUploads: true,
      actions: true,
      storage: true,
      app: 'entre-textos',
    });
    expect((await console.disks()).data.map((d) => d.name)).toEqual(['fs']);
    expect((await console.objects('fs', { prefix: 'avatars/' })).data).toMatchObject([
      { type: 'file', key: 'avatars/me.png' },
    ]);
    const object = await console.object('fs', 'avatars/me.png');
    expect(object.url).toBe('https://et.example/media/api/object/raw?disk=fs&key=avatars%2Fme.png');
    expect(await console.objectRedirect('fs', 'avatars/me.png')).toBe(object.url);
    const detail = await console.mediaRecord('r1');
    expect(detail.record.id).toBe('r1');
    expect(detail.variants).toEqual([
      {
        name: 'thumbnail',
        url: 'https://et.example/media/api/object/raw?disk=fs&key=avatars%2Fme-thumb.png',
      },
    ]);
  });

  it('keeps signed URLs as they are, and refuses a path with no origin to put it on', async () => {
    const bus = new RedisBus();
    const signer = await owningApp(bus, { actions: false, strategy: 'auto' });
    await signer.disk.put('a.png', new Uint8Array([1]));
    const { console } = hubConsole(bus, signer.store);
    expect(await console.objectRedirect('fs', 'a.png')).toBe('https://bucket.invalid/a.png?sig=1');

    const other = new RedisBus();
    const proxied = await owningApp(other, { actions: false });
    await proxied.disk.put('a.png', new Uint8Array([1]));
    const noOrigin = hubConsole(other, proxied.store).console;
    await expect(noOrigin.objectRedirect('fs', 'a.png')).rejects.toMatchObject({ status: 501 });
    expect((await noOrigin.object('fs', 'a.png')).url).toBe('');
  });

  it('serves the app objects itself with proxyObjects, sending the headers to its origin only', async () => {
    const bus = new RedisBus();
    const owner = await owningApp(bus, { actions: false });
    await owner.disk.put('avatars/me.png', new Uint8Array([1]));
    await owner.store.save(
      record({
        id: 'r1',
        conversions: { thumbnail: { disk: 'fs', path: 'avatars/me-thumb.png' } as never },
      }),
    );
    const calls: Array<{ url: string; auth: string | null; redirect: string | undefined }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        auth: new Headers(init?.headers).get('authorization'),
        redirect: init?.redirect,
      });
      if (url.includes('missing')) return new Response('nope', { status: 404 });
      if (url.includes('locked')) return new Response('no', { status: 403 });
      return new Response(new Uint8Array([7, 8, 9]), {
        headers: { 'content-type': 'image/png', 'content-length': '3' },
      });
    }) as typeof fetch;
    const { console } = hubConsole(bus, owner.store, {
      origin: 'https://et.example',
      proxyObjects: { headers: async () => ({ authorization: 'Bearer svc' }) },
      fetch: fakeFetch,
    });

    expect(console.servesBytes).toBe(true);
    // The browser is pointed at this console, not at the app.
    expect((await console.object('fs', 'avatars/me.png')).url).toBe(
      '/media/api/object/raw?app=entre-textos&disk=fs&key=avatars%2Fme.png',
    );
    expect((await console.mediaRecord('r1')).variants).toEqual([
      {
        name: 'thumbnail',
        url: '/media/api/object/raw?app=entre-textos&disk=fs&key=avatars%2Fme-thumb.png',
      },
    ]);

    const { stream, contentType, size } = await console.objectStream('fs', 'avatars/me.png');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect([...Buffer.concat(chunks)]).toEqual([7, 8, 9]);
    expect({ contentType, size }).toEqual({ contentType: 'image/png', size: 3 });
    expect(calls).toEqual([
      {
        url: 'https://et.example/media/api/object/raw?disk=fs&key=avatars%2Fme.png',
        auth: 'Bearer svc',
        redirect: 'manual',
      },
    ]);

    await owner.disk.put('missing.png', new Uint8Array([1]));
    await owner.disk.put('locked.png', new Uint8Array([1]));
    await expect(console.objectStream('fs', 'missing.png')).rejects.toMatchObject({ status: 404 });
    await expect(console.objectStream('fs', 'locked.png')).rejects.toMatchObject({
      status: 502,
      detail: expect.stringContaining('HTTP 403'),
    });
  });

  it('answers 503 with the cause when the proxy headers cannot be made', async () => {
    const bus = new RedisBus();
    const owner = await owningApp(bus, { actions: false });
    await owner.disk.put('a.png', new Uint8Array([1]));
    const { console } = hubConsole(bus, owner.store, {
      origin: 'https://et.example',
      proxyObjects: {
        headers: async () => {
          throw new Error('token endpoint down');
        },
      },
      fetch: (async () => new Response('x')) as typeof fetch,
    });
    await expect(console.objectStream('fs', 'a.png')).rejects.toMatchObject({
      status: 503,
      detail: 'token endpoint down',
    });
  });

  it('fetches a signed URL with proxyObjects without the headers', async () => {
    const bus = new RedisBus();
    const signer = await owningApp(bus, { actions: false, strategy: 'auto' });
    await signer.disk.put('a.png', new Uint8Array([1]));
    const auths: Array<string | null> = [];
    const { console } = hubConsole(bus, signer.store, {
      origin: 'https://et.example',
      proxyObjects: { headers: () => ({ authorization: 'Bearer svc' }) },
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        auths.push(new Headers(init?.headers).get('authorization'));
        return new Response('x');
      }) as typeof fetch,
    });
    const { size } = await console.objectStream('fs', 'a.png');
    expect(auths).toEqual([null]);
    expect(Number.isNaN(size)).toBe(true);

    // Without proxyObjects the console still refuses to serve another app's bytes.
    const plain = hubConsole(bus, signer.store).console;
    expect(plain.servesBytes).toBe(false);
    await expect(plain.objectStream('fs', 'a.png')).rejects.toMatchObject({ status: 501 });
  });

  it('runs an action once in the owning app, however many instances listen, and logs who', async () => {
    const bus = new RedisBus();
    const owner = await owningApp(bus, { actions: true, instances: 3 });
    await owner.store.save(record({ id: 'gone' }));
    await owner.disk.put('x/1.png', new Uint8Array([1]));
    const { console } = hubConsole(bus, owner.store);

    await console.deleteMediaRecord('gone');
    await console.remove({ disk: 'fs', keys: ['x/1.png'] });

    expect(await owner.store.find('gone')).toBeNull();
    expect(owner.disk.files.has('x/1.png')).toBe(false);
    expect(owner.runs.filter((r) => r.endsWith(':deleteMediaRecord'))).toHaveLength(1);
    expect(owner.runs.filter((r) => r.endsWith(':remove'))).toHaveLength(1);
    expect(owner.log).toContain('[media] federated console: deleteMediaRecord gone by ana@hub');
  });

  it("relays the app's own refusals, and never sends an action this console has off", async () => {
    const bus = new RedisBus();
    const owner = await owningApp(bus, { actions: false });
    await owner.store.save(record({ id: 'kept' }));

    const { console } = hubConsole(bus, owner.store);
    const refused = await console.deleteMediaRecord('kept').catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(DashboardError);
    expect(refused).toMatchObject({ status: 403 });
    expect(await owner.store.find('kept')).not.toBeNull();

    const readOnly = hubConsole(bus, owner.store, { actions: false }).console;
    const before = commandsSent(bus).length;
    await expect(readOnly.deleteMediaRecord('kept')).rejects.toMatchObject({ status: 403 });
    expect(commandsSent(bus).length).toBe(before);

    // Uploading stays this app's own: the console's upload goes nowhere for another app.
    await expect(console.putObject()).rejects.toMatchObject({ status: 501 });
  });

  it('answers 404 for a record the app does not have and 502 for its own failures', async () => {
    const bus = new RedisBus();
    const owner = await owningApp(bus, { actions: true });
    const { console } = hubConsole(bus, owner.store);
    await expect(console.deleteMediaRecord('nope')).rejects.toMatchObject({ status: 404 });
    const failed = (await console.object('fs', 'missing.png').catch((e: unknown) => e)) as
      | FederatedAppError
      | undefined;
    expect(failed).toBeInstanceOf(FederatedAppError);
    expect(failed?.status).toBe(502);
    expect(failed?.message).toBe('the Entre Textos app answered with an error');
    expect(failed?.detail).toContain('ENOENT');
  });

  it('answers 501 for a verb the app does not run', async () => {
    const bus = new RedisBus();
    const owner = await owningApp(bus, { actions: true });
    const { app } = hubConsole(bus, owner.store);
    await expect(app.send('objectStream' as never, [])).rejects.toMatchObject({ status: 501 });
  });

  it('with the app down: actions fail fast with 503 naming it, browsing keeps working', async () => {
    const bus = new RedisBus();
    const store = new InMemoryMediaStore();
    await store.save(
      record({ id: 'r1', conversions: { thumb: { disk: 'fs', path: 't.png' } as never } }),
    );
    const { console } = hubConsole(bus, store, { timeoutMs: 60_000 });

    const started = Date.now();
    const error = (await console.deleteMediaRecord('r1').catch((e: unknown) => e)) as Error & {
      status: number;
    };
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error.status).toBe(503);
    expect(error.message).toContain('Entre Textos');
    expect(error.message).toContain('consoleCommands');

    expect((await console.collections()).data).toHaveLength(1);
    expect((await console.mediaRecord('r1')).variants).toEqual([]);
    expect((await console.topology()).disks).toBe(0);
  });

  it('times out when the app hears the command but never answers', async () => {
    const bus = new RedisBus();
    const silent = bus.connection();
    await silent.subscribe('entretextos-media-console', () => {});
    const { console } = hubConsole(bus, new InMemoryMediaStore(), { timeoutMs: 50 });
    await expect(console.disks()).rejects.toMatchObject({ status: 503 });
  });

  it('retries the reply subscription on the next send after a first one fails', async () => {
    const bus = new RedisBus();
    await new RedisConsoleChannel({ client: bus.connection(), prefix: 'entretextos' }).answer(
      async () => ({ ok: true }),
    );
    const hub = bus.connection();
    let failures = 1;
    const subscribe = hub.subscribe;
    hub.subscribe = async (channel, handler) => {
      if (failures-- > 0) throw new Error('connection reset');
      return subscribe(channel, handler);
    };
    const channel = new RedisConsoleChannel({ client: hub, prefix: 'entretextos' });
    await expect(channel.send({ id: 'a', verb: 'disks', args: [] })).rejects.toMatchObject({
      code: 'federated-app-unreachable',
      message: expect.stringContaining('connection reset'),
    });
    const reply = await channel.send({ id: 'b', verb: 'disks', args: [] });
    expect(reply).toMatchObject({ ok: true, data: { ok: true } });
    await channel.close();
  });

  it('refuses to answer commands on a connection that cannot claim them', async () => {
    const bus = new RedisBus();
    const { set: _set, ...noSet } = bus.connection();
    const channel = new RedisConsoleChannel({ client: noSet, prefix: 'entretextos' });
    await expect(channel.answer(async () => null)).rejects.toThrow(/SET key value PX ms NX/);
  });
});
