import { describe, expect, it, vi } from 'vitest';
import { DashboardError, DashboardService } from './service';
import type { MediaManagerLike } from './service';

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
});
