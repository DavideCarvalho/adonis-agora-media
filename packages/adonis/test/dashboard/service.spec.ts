import { describe, expect, it, vi } from 'vitest';
import { DashboardError, DashboardService } from '../../src/dashboard/service.js';
import type { MediaManagerLike } from '../../src/dashboard/service.js';

/** A fake extended (S3-like) disk with spied ops so the service's real-surface calls are asserted. */
function fakeDisk(overrides: Record<string, unknown> = {}) {
  return {
    capabilities: { presign: true, multipart: true, publicUrls: true, list: true },
    list: vi.fn(async () => ({
      folders: ['photos/2024/'],
      files: [
        {
          key: 'a.txt',
          name: 'a.txt',
          sizeBytes: 12,
          lastModified: new Date('2026-07-13T10:00:00Z'),
        },
        { key: 'b.bin', name: 'b.bin', sizeBytes: null, lastModified: null },
      ],
      cursor: 'next-token',
    })),
    stat: vi.fn(async () => ({
      size: 42,
      contentType: 'text/plain',
      lastModified: new Date('2026-07-13T10:00:00Z'),
    })),
    copy: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    deleteMany: vi.fn(async () => {}),
    size: vi.fn(async () => 42),
    getBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
    put: vi.fn(async () => {}),
    getSignedUrl: vi.fn(async () => 'https://signed.example/a.txt'),
    getMetaData: vi.fn(async () => ({ contentLength: 42 })),
    getUrl: vi.fn(async () => 'https://public.example/a.txt'),
    getStream: vi.fn(),
    exists: vi.fn(async () => true),
    delete: vi.fn(async () => {}),
    ...overrides,
  };
}

function managerWith(
  disks: Record<string, ReturnType<typeof fakeDisk>>,
  resumable?: unknown,
  store?: unknown,
): MediaManagerLike {
  return {
    storage: {
      defaultDisk: 's3',
      disk: (name?: string) => disks[name ?? 's3'] as never,
    },
    hasResumable: resumable !== undefined,
    resumable: (resumable ?? { list: vi.fn(async () => []) }) as never,
    store: (store ?? { list: vi.fn(async () => ({ items: [], nextCursor: null })) }) as never,
  };
}

/** A `ListEntry`-shaped file row for the folder-sweep tests. */
function entryOf(key: string) {
  return { key, name: key.split('/').pop() ?? key, sizeBytes: 1, lastModified: null };
}

/** A stored `MediaRecord`-shaped row for the collections projection tests. */
function mediaRecord(over: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    ownerType: 'Post',
    ownerId: '42',
    collection: 'gallery',
    name: 'sunset',
    fileName: 'sunset.jpg',
    mimeType: 'image/jpeg',
    size: 2048,
    disk: 's3',
    path: 'Post/42/gallery/m1/sunset.jpg',
    order: 0,
    customProperties: {},
    conversions: { thumb: { path: 't.jpg', disk: 's3' } },
    createdAt: new Date('2026-07-13T10:00:00Z'),
    updatedAt: new Date('2026-07-13T11:00:00Z'),
    ...over,
  };
}

describe('DashboardService', () => {
  it('reports topology from disk names + resumable availability', () => {
    const svc = new DashboardService(managerWith({ s3: fakeDisk() }), {
      diskNames: ['s3', 'backup'],
      actions: true,
    });
    expect(svc.topology()).toEqual({ disks: 2, hasUploads: false, actions: true });
  });

  it('lists disks with capabilities and marks the default', () => {
    const svc = new DashboardService(managerWith({ s3: fakeDisk(), backup: fakeDisk() }), {
      diskNames: ['s3', 'backup'],
      actions: false,
    });
    const { disks } = svc.disks();
    expect(disks[0]).toMatchObject({ name: 's3', default: true, capabilities: { list: true } });
    expect(disks[1]).toMatchObject({ name: 'backup', default: false });
  });

  it('maps object listings (folders + files) with ISO dates and cursor', async () => {
    const disk = fakeDisk();
    const svc = new DashboardService(managerWith({ s3: disk }), {
      diskNames: ['s3'],
      actions: false,
    });
    const res = await svc.objects('s3', { prefix: 'photos/', limit: 50 });
    expect(disk.list).toHaveBeenCalledWith('photos/', { delimiter: '/', limit: 50 });
    expect(res.folders).toEqual([{ name: '2024', prefix: 'photos/2024/' }]);
    expect(res.files[0]).toEqual({
      key: 'a.txt',
      name: 'a.txt',
      sizeBytes: 12,
      lastModified: '2026-07-13T10:00:00.000Z',
    });
    expect(res.files[1].lastModified).toBeNull();
    expect(res.cursor).toBe('next-token');
  });

  it('drops phantom empty-name folders (leading-slash CommonPrefix) from a listing', async () => {
    // A stray leading-slash key makes S3 emit a "/" CommonPrefix (empty name). The driver
    // normalizes an all-slash prefix back to root, so entering it re-lists root forever —
    // it must never reach the client.
    const disk = fakeDisk({
      list: vi.fn(async () => ({
        folders: ['/', 'bases/', 'templates/'],
        files: [],
      })),
    });
    const svc = new DashboardService(managerWith({ s3: disk }), {
      diskNames: ['s3'],
      actions: false,
    });
    const res = await svc.objects('s3', {});
    expect(res.folders.map((folder) => folder.prefix)).toEqual(['bases/', 'templates/']);
    expect(res.folders.every((folder) => folder.name !== '')).toBe(true);
  });

  it('returns object detail with a signed url', async () => {
    const disk = fakeDisk();
    const svc = new DashboardService(managerWith({ s3: disk }), {
      diskNames: ['s3'],
      actions: false,
    });
    const res = await svc.object('s3', 'a.txt');
    expect(disk.getSignedUrl).toHaveBeenCalledWith('a.txt', { expiresIn: 300 });
    expect(res).toMatchObject({
      key: 'a.txt',
      size: 42,
      contentType: 'text/plain',
      url: 'https://signed.example/a.txt',
    });
  });

  it('projects resumable upload sessions to UploadInfo', async () => {
    const resumable = {
      list: vi.fn(async () => [
        {
          id: 'u1',
          disk: 's3',
          key: 'big.mp4',
          offset: 50,
          size: 100,
          parts: 3,
          multipartUploadId: 'MP1',
          createdAt: new Date('2026-07-13T09:00:00Z'),
        },
        { id: 'u2', disk: 's3', key: 'unknown.bin', offset: 10, size: undefined, parts: 1 },
      ]),
    };
    const svc = new DashboardService(managerWith({ s3: fakeDisk() }, resumable), {
      diskNames: ['s3'],
      actions: false,
    });
    const res = await svc.uploads({ disk: 's3' });
    expect(resumable.list).toHaveBeenCalledWith({ disk: 's3' });
    expect(res.uploads[0]).toMatchObject({
      id: 'u1',
      percent: 50,
      multipart: true,
      createdAt: '2026-07-13T09:00:00.000Z',
    });
    expect(res.uploads[1]).toMatchObject({ id: 'u2', percent: null, size: null, multipart: false });
  });

  it('returns empty uploads when no resumable store is configured', async () => {
    const svc = new DashboardService(managerWith({ s3: fakeDisk() }), {
      diskNames: ['s3'],
      actions: false,
    });
    await expect(svc.uploads()).resolves.toEqual({ uploads: [] });
  });

  it('lists stored records via MediaStore.list, projecting conversions + ISO dates', async () => {
    const store = {
      list: vi.fn(async () => ({ items: [mediaRecord()], nextCursor: 'cursor-2' })),
    };
    const svc = new DashboardService(managerWith({ s3: fakeDisk() }, undefined, store), {
      diskNames: ['s3'],
      actions: false,
    });
    const res = await svc.collections({ ownerType: 'Post', ownerId: '42', limit: 25 });
    expect(store.list).toHaveBeenCalledWith({ ownerType: 'Post', ownerId: '42', limit: 25 });
    expect(res.nextCursor).toBe('cursor-2');
    expect(res.items[0]).toEqual({
      id: 'm1',
      ownerType: 'Post',
      ownerId: '42',
      collection: 'gallery',
      name: 'sunset',
      fileName: 'sunset.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 2048,
      disk: 's3',
      path: 'Post/42/gallery/m1/sunset.jpg',
      conversions: ['thumb'],
      createdAt: '2026-07-13T10:00:00.000Z',
      updatedAt: '2026-07-13T11:00:00.000Z',
    });
  });

  it('forwards only the provided collection filters to the store', async () => {
    const store = { list: vi.fn(async () => ({ items: [], nextCursor: null })) };
    const svc = new DashboardService(managerWith({ s3: fakeDisk() }, undefined, store), {
      diskNames: ['s3'],
      actions: false,
    });
    await svc.collections({ collection: 'gallery' });
    expect(store.list).toHaveBeenCalledWith({ collection: 'gallery' });
  });

  it('copies within the same disk via the driver', async () => {
    const disk = fakeDisk();
    const svc = new DashboardService(managerWith({ s3: disk }), {
      diskNames: ['s3'],
      actions: true,
    });
    await svc.copy({ disk: 's3', from: 'a.txt', to: 'b.txt' });
    expect(disk.copy).toHaveBeenCalledWith('a.txt', 'b.txt');
    expect(disk.getBytes).not.toHaveBeenCalled();
  });

  it('moves across disks by streaming bytes then deleting the source', async () => {
    const source = fakeDisk();
    const dest = fakeDisk({ put: vi.fn(async () => {}) });
    const svc = new DashboardService(managerWith({ s3: source, backup: dest }), {
      diskNames: ['s3', 'backup'],
      actions: true,
    });
    await svc.move({ disk: 's3', from: 'a.txt', to: 'a.txt', toDisk: 'backup' });
    expect(source.getBytes).toHaveBeenCalledWith('a.txt');
    expect(dest.put).toHaveBeenCalledWith('a.txt', new Uint8Array([1, 2, 3]), {
      contentType: 'text/plain',
    });
    expect(source.deleteMany).toHaveBeenCalledWith(['a.txt']);
  });

  it('deletes many keys via the driver', async () => {
    const disk = fakeDisk();
    const svc = new DashboardService(managerWith({ s3: disk }), {
      diskNames: ['s3'],
      actions: true,
    });
    await svc.remove({ disk: 's3', keys: ['a.txt', 'b.bin'] });
    expect(disk.deleteMany).toHaveBeenCalledWith(['a.txt', 'b.bin']);
  });

  it('refuses mutations when actions are disabled', async () => {
    const svc = new DashboardService(managerWith({ s3: fakeDisk() }), {
      diskNames: ['s3'],
      actions: false,
    });
    await expect(svc.remove({ disk: 's3', keys: ['a.txt'] })).rejects.toBeInstanceOf(
      DashboardError,
    );
    await expect(svc.copy({ disk: 's3', from: 'a', to: 'b' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('createFolder writes a zero-byte marker with exactly one trailing slash (no double-slash)', async () => {
    const disk = fakeDisk({ put: vi.fn(async () => {}) });
    const svc = new DashboardService(managerWith({ s3: disk }), {
      diskNames: ['s3'],
      actions: true,
    });
    // A trailing slash on the input must not double up in the key.
    await svc.createFolder({ disk: 's3', prefix: 'reports/' });
    expect(disk.put).toHaveBeenCalledWith('reports/', new Uint8Array(0));
  });

  it('createFolder rejects an empty prefix and is actions-gated', async () => {
    const open = new DashboardService(managerWith({ s3: fakeDisk() }), {
      diskNames: ['s3'],
      actions: true,
    });
    await expect(open.createFolder({ disk: 's3', prefix: '///' })).rejects.toMatchObject({
      status: 400,
    });
    const gated = new DashboardService(managerWith({ s3: fakeDisk() }), {
      diskNames: ['s3'],
      actions: false,
    });
    await expect(gated.createFolder({ disk: 's3', prefix: 'reports' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('deleteFolder is truly recursive: flat delimiter, paginated, nested keys gone, marker last', async () => {
    const listCalls: Array<{ prefix: string; delimiter?: string; cursor?: string }> = [];
    const deletedMany: string[][] = [];
    const deletedSingle: string[] = [];
    const disk = fakeDisk({
      list: vi.fn(async (prefix: string, opts?: { delimiter?: string; cursor?: string }) => {
        listCalls.push({ prefix, delimiter: opts?.delimiter, cursor: opts?.cursor });
        if (opts?.cursor === undefined) {
          // First page includes a NESTED key — only reachable with a flat (empty-delimiter) sweep.
          return { folders: [], files: [entryOf('reports/deep/a.txt')], cursor: 'p2' };
        }
        return { folders: [], files: [entryOf('reports/b.txt')] };
      }),
      deleteMany: vi.fn(async (keys: string[]) => {
        deletedMany.push(keys);
      }),
      delete: vi.fn(async (key: string) => {
        deletedSingle.push(key);
      }),
    });
    const svc = new DashboardService(managerWith({ s3: disk }), {
      diskNames: ['s3'],
      actions: true,
    });

    await svc.deleteFolder({ disk: 's3', prefix: 'reports' });

    // Every sweep used the folder prefix with an EMPTY delimiter (flat → nested keys surface).
    expect(listCalls.every((c) => c.prefix === 'reports/' && c.delimiter === '')).toBe(true);
    expect(listCalls.map((c) => c.cursor)).toEqual([undefined, 'p2']);
    // Nested key from page one is deleted; the marker is deleted LAST and only after the sweep.
    expect(deletedMany).toEqual([['reports/deep/a.txt'], ['reports/b.txt']]);
    expect(deletedMany.flat()).toContain('reports/deep/a.txt');
    expect(deletedSingle).toEqual(['reports/']);
  });

  it('moveFolder relocates every key preserving relative path, writes dest marker, drops source marker', async () => {
    const listCalls: Array<{ delimiter?: string }> = [];
    const disk = fakeDisk({
      list: vi.fn(async (_prefix: string, opts?: { delimiter?: string; cursor?: string }) => {
        listCalls.push({ delimiter: opts?.delimiter });
        return { folders: [], files: [entryOf('src/deep/a.txt'), entryOf('src/b.txt')] };
      }),
      move: vi.fn(async () => {}),
      put: vi.fn(async () => {}),
      delete: vi.fn(async () => {}),
    });
    const svc = new DashboardService(managerWith({ s3: disk }), {
      diskNames: ['s3'],
      actions: true,
    });

    await svc.moveFolder({ disk: 's3', from: 'src', to: 'dst' });

    expect(listCalls.every((c) => c.delimiter === '')).toBe(true);
    // Each key keeps its path relative to the source prefix.
    expect(disk.move).toHaveBeenCalledWith('src/deep/a.txt', 'dst/deep/a.txt');
    expect(disk.move).toHaveBeenCalledWith('src/b.txt', 'dst/b.txt');
    // Destination marker written, source marker removed.
    expect(disk.put).toHaveBeenCalledWith('dst/', new Uint8Array(0));
    expect(disk.delete).toHaveBeenCalledWith('src/');
  });

  it('rejects moving/copying a folder into itself on the same disk', async () => {
    const svc = new DashboardService(managerWith({ s3: fakeDisk() }), {
      diskNames: ['s3'],
      actions: true,
    });
    await expect(svc.moveFolder({ disk: 's3', from: 'a', to: 'a/child' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(svc.copyFolder({ disk: 's3', from: 'a', to: 'a' })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('rejects listing on a non-extended disk', async () => {
    const plain = { getSignedUrl: vi.fn(), getMetaData: vi.fn() } as unknown as ReturnType<
      typeof fakeDisk
    >;
    const svc = new DashboardService(managerWith({ s3: plain }), {
      diskNames: ['s3'],
      actions: false,
    });
    await expect(svc.objects('s3')).rejects.toMatchObject({ status: 400 });
  });

  it('streams an object with its content type and size for the inline preview proxy', async () => {
    const disk = fakeDisk({ getStream: vi.fn(async () => 'the-stream' as never) });
    const svc = new DashboardService(managerWith({ s3: disk }), {
      diskNames: ['s3'],
      actions: false,
    });
    const result = await svc.objectStream('s3', 'a.txt');
    expect(result).toMatchObject({ stream: 'the-stream', contentType: 'text/plain', size: 42 });
  });

  it('returns empty insights when no providers are registered', async () => {
    const svc = new DashboardService(managerWith({ s3: fakeDisk() }), {
      diskNames: ['s3'],
      actions: false,
    });
    await expect(svc.objectInsights('s3', 'a.txt')).resolves.toEqual({ insights: [] });
  });

  it('collects insights from every registered provider, dropping ones that throw', async () => {
    const svc = new DashboardService(
      managerWith({ s3: fakeDisk() }),
      { diskNames: ['s3'], actions: false },
      [
        {
          id: 'good',
          resolve: async () => ({ title: 'RAG', facts: [{ label: 'k', value: 'v' }] }),
        },
        {
          id: 'bad',
          resolve: async () => {
            throw new Error('boom');
          },
        },
        { id: 'nothing-to-say', resolve: () => null },
      ],
    );
    const result = await svc.objectInsights('s3', 'a.txt');
    expect(result.insights).toEqual([{ title: 'RAG', facts: [{ label: 'k', value: 'v' }] }]);
  });

  it('sanitizes unsafe insight links (javascript:, protocol-relative) while keeping safe ones', async () => {
    const svc = new DashboardService(
      managerWith({ s3: fakeDisk() }),
      { diskNames: ['s3'], actions: false },
      [
        {
          id: 'p',
          resolve: () => ({
            title: 'RAG',
            links: [
              { label: 'safe relative', href: '/app/docs/1' },
              { label: 'safe absolute', href: 'https://example.com' },
              { label: 'protocol-relative', href: '//evil.example' },
              { label: 'javascript', href: 'javascript:alert(1)' },
            ],
          }),
        },
      ],
    );
    const result = await svc.objectInsights('s3', 'a.txt');
    expect(result.insights[0]?.links?.map((l) => l.label)).toEqual([
      'safe relative',
      'safe absolute',
    ]);
  });

  it('uploadDetail finds the session by id and returns its recorded parts', async () => {
    const resumable = {
      list: vi.fn(async () => [{ id: 'u1', disk: 's3', key: 'a', offset: 5, size: 10, parts: 1 }]),
      abort: vi.fn(async () => {}),
      listParts: vi.fn(async () => [{ partNumber: 1, etag: 'e1' }]),
    };
    const svc = new DashboardService(managerWith({ s3: fakeDisk() }, resumable), {
      diskNames: ['s3'],
      actions: false,
    });
    const result = await svc.uploadDetail('u1');
    expect(result.upload).toMatchObject({ id: 'u1', percent: 50 });
    expect(result.parts).toEqual([{ partNumber: 1, etag: 'e1' }]);
  });

  it('uploadDetail 404s for an unknown id, and when no upload store is configured', async () => {
    const resumable = { list: vi.fn(async () => []), abort: vi.fn(), listParts: vi.fn() };
    const withStore = new DashboardService(managerWith({ s3: fakeDisk() }, resumable), {
      diskNames: ['s3'],
      actions: false,
    });
    await expect(withStore.uploadDetail('missing')).rejects.toMatchObject({ status: 404 });

    const withoutStore = new DashboardService(managerWith({ s3: fakeDisk() }), {
      diskNames: ['s3'],
      actions: false,
    });
    await expect(withoutStore.uploadDetail('u1')).rejects.toMatchObject({ status: 404 });
  });

  it('abortUpload delegates to the resumable manager and is actions-gated', async () => {
    const resumable = {
      list: vi.fn(async () => []),
      abort: vi.fn(async () => {}),
      listParts: vi.fn(),
    };
    const gated = new DashboardService(managerWith({ s3: fakeDisk() }, resumable), {
      diskNames: ['s3'],
      actions: false,
    });
    await expect(gated.abortUpload('u1')).rejects.toMatchObject({ status: 403 });
    expect(resumable.abort).not.toHaveBeenCalled();

    const allowed = new DashboardService(managerWith({ s3: fakeDisk() }, resumable), {
      diskNames: ['s3'],
      actions: true,
    });
    await allowed.abortUpload('u1');
    expect(resumable.abort).toHaveBeenCalledWith('u1');
  });

  it('collectionsSummary rolls up count + total size per collection across pages', async () => {
    const pages = [
      { items: [mediaRecord({ id: 'a', collection: 'gallery', size: 100 })], nextCursor: 'p2' },
      {
        items: [
          mediaRecord({ id: 'b', collection: 'gallery', size: 50 }),
          mediaRecord({ id: 'c', collection: 'docs', size: 10 }),
        ],
        nextCursor: null,
      },
    ];
    let call = 0;
    const store = { list: vi.fn(async () => pages[call++]) };
    const svc = new DashboardService(managerWith({ s3: fakeDisk() }, undefined, store), {
      diskNames: ['s3'],
      actions: false,
    });
    const result = await svc.collectionsSummary();
    expect(result.collections).toEqual(
      expect.arrayContaining([
        { key: 'gallery', count: 2, sumSize: 150 },
        { key: 'docs', count: 1, sumSize: 10 },
      ]),
    );
  });

  it('mediaRecord returns signed variant URLs only for conversions with a concrete artifact', async () => {
    const disk = fakeDisk({ getSignedUrl: vi.fn(async () => 'https://signed.example/thumb.jpg') });
    const store = {
      find: vi.fn(async () =>
        mediaRecord({
          conversions: {
            thumb: { path: 't.jpg', disk: 's3' },
            probe: { meta: { duration: 12 } }, // no path/disk — metadata-only, not linkable
          },
        }),
      ),
      delete: vi.fn(),
    };
    const svc = new DashboardService(managerWith({ s3: disk }, undefined, store), {
      diskNames: ['s3'],
      actions: false,
    });
    const result = await svc.mediaRecord('m1');
    expect(result.variants).toEqual([{ name: 'thumb', url: 'https://signed.example/thumb.jpg' }]);
  });

  it('mediaRecord 404s for an unknown id', async () => {
    const store = { find: vi.fn(async () => null), delete: vi.fn() };
    const svc = new DashboardService(managerWith({ s3: fakeDisk() }, undefined, store), {
      diskNames: ['s3'],
      actions: false,
    });
    await expect(svc.mediaRecord('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('putObject buffers the stream and writes it, and is actions-gated', async () => {
    const disk = fakeDisk({ put: vi.fn(async () => {}) });
    async function* body() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3]);
    }
    const gated = new DashboardService(managerWith({ s3: disk }), {
      diskNames: ['s3'],
      actions: false,
    });
    await expect(gated.putObject('s3', 'a.txt', body())).rejects.toMatchObject({ status: 403 });

    const allowed = new DashboardService(managerWith({ s3: disk }), {
      diskNames: ['s3'],
      actions: true,
    });
    await allowed.putObject('s3', 'a.txt', body(), 'text/plain');
    expect(disk.put).toHaveBeenCalledWith('a.txt', new Uint8Array([1, 2, 3]), {
      contentType: 'text/plain',
    });
  });

  it('putObject rejects a stream over the console upload cap', async () => {
    const disk = fakeDisk({ put: vi.fn(async () => {}) });
    async function* bigBody() {
      yield new Uint8Array(101 * 1024 * 1024);
    }
    const svc = new DashboardService(managerWith({ s3: disk }), {
      diskNames: ['s3'],
      actions: true,
    });
    await expect(svc.putObject('s3', 'a.txt', bigBody())).rejects.toMatchObject({ status: 413 });
  });

  it('deleteMediaRecord is actions-gated and 404s for an unknown id', async () => {
    const store = { find: vi.fn(async () => mediaRecord()), delete: vi.fn(async () => {}) };
    const gated = new DashboardService(managerWith({ s3: fakeDisk() }, undefined, store), {
      diskNames: ['s3'],
      actions: false,
    });
    await expect(gated.deleteMediaRecord('m1')).rejects.toMatchObject({ status: 403 });
    expect(store.delete).not.toHaveBeenCalled();

    const allowed = new DashboardService(managerWith({ s3: fakeDisk() }, undefined, store), {
      diskNames: ['s3'],
      actions: true,
    });
    await allowed.deleteMediaRecord('m1');
    expect(store.delete).toHaveBeenCalledWith('m1');
  });
});
