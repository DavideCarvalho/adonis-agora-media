import { describe, expect, it } from 'vitest';
import { MimeNotAllowedError } from '../src/errors.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { FakeImageProcessor } from '../src/testing/fake_image_processor.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

function makeLibrary(opts: Partial<ConstructorParameters<typeof MediaLibrary>[0]> = {}) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const storage = new StorageManager({ default: 'fs', resolve });
  const store = new InMemoryMediaStore();
  let counter = 0;
  const library = new MediaLibrary({
    storage,
    store,
    idGenerator: () => `id-${++counter}`,
    clock: () => new Date('2026-06-23T00:00:00.000Z'),
    emitDiagnostics: false,
    ...opts,
  });
  return { library, store, disks };
}

const png = Buffer.from('fake-png-bytes');

describe('MediaLibrary.attach / list / delete', () => {
  it('attaches a file, persists the record, and stores bytes on the disk', async () => {
    const { library, disks } = makeLibrary();

    const record = await library.attach({
      ownerType: 'Post',
      ownerId: '42',
      collection: 'gallery',
      fileName: 'photo.png',
      mimeType: 'image/png',
      contents: png,
    });

    expect(record.id).toBe('id-1');
    expect(record.ownerType).toBe('Post');
    expect(record.collection).toBe('gallery');
    expect(record.name).toBe('photo'); // extension stripped
    expect(record.size).toBe(png.byteLength);
    expect(record.disk).toBe('fs');
    expect(record.path).toBe('Post/42/gallery/id-1/photo.png');
    expect(record.order).toBe(0);
    expect(disks.fs.files.has(record.path)).toBe(true);
  });

  it('lists an owner records ordered by order, and filters by collection', async () => {
    const { library } = makeLibrary();
    await library.attach({
      ownerType: 'Post',
      ownerId: '1',
      collection: 'gallery',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: png,
    });
    await library.attach({
      ownerType: 'Post',
      ownerId: '1',
      collection: 'gallery',
      fileName: 'b.png',
      mimeType: 'image/png',
      contents: png,
    });
    await library.attach({
      ownerType: 'Post',
      ownerId: '1',
      collection: 'docs',
      fileName: 'c.pdf',
      mimeType: 'application/pdf',
      contents: png,
    });

    // Across all collections: 3 records, each collection orders independently from 0.
    const all = await library.list('Post', '1');
    expect(all).toHaveLength(3);
    expect(new Set(all.map((r) => r.fileName))).toEqual(new Set(['a.png', 'b.png', 'c.pdf']));

    // Within a collection, results are ordered by `order` asc.
    const gallery = await library.list('Post', '1', 'gallery');
    expect(gallery.map((r) => r.fileName)).toEqual(['a.png', 'b.png']);
    expect(gallery.map((r) => r.order)).toEqual([0, 1]);
  });

  it('deletes a record and removes its bytes (and conversions) from the disk', async () => {
    const { library, store, disks } = makeLibrary({ imageProcessor: new FakeImageProcessor() });
    const record = await library.attach({
      ownerType: 'Post',
      ownerId: '1',
      collection: 'gallery',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: png,
    });
    await library.delete(record.id);

    expect(await store.find(record.id)).toBeNull();
    expect(disks.fs.files.has(record.path)).toBe(false);
  });

  it('the for() binding does not repeat owner type/id and coerces numeric ids', async () => {
    const { library } = makeLibrary();
    const post = library.for('Post', 7);
    await post.attach({
      collection: 'gallery',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: png,
    });
    const list = await post.list('gallery');
    expect(list).toHaveLength(1);
    expect(list[0]?.ownerId).toBe('7');
  });
});

describe('single-file collections', () => {
  it('replaces the previous file when attaching to a single-file collection', async () => {
    const { library, store, disks } = makeLibrary({
      collections: [{ name: 'avatar', single: true }],
    });
    const first = await library.attach({
      ownerType: 'User',
      ownerId: '1',
      collection: 'avatar',
      fileName: 'old.png',
      mimeType: 'image/png',
      contents: png,
    });
    const second = await library.attach({
      ownerType: 'User',
      ownerId: '1',
      collection: 'avatar',
      fileName: 'new.png',
      mimeType: 'image/png',
      contents: png,
    });

    const list = await library.list('User', '1', 'avatar');
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(second.id);
    expect(await store.find(first.id)).toBeNull();
    expect(disks.fs.files.has(first.path)).toBe(false);
    expect(disks.fs.files.has(second.path)).toBe(true);
  });
});

describe('MIME whitelist', () => {
  it('rejects a disallowed MIME type', async () => {
    const { library, disks } = makeLibrary({
      collections: [{ name: 'avatar', acceptsMimeTypes: ['image/png'] }],
    });
    await expect(
      library.attach({
        ownerType: 'User',
        ownerId: '1',
        collection: 'avatar',
        fileName: 'a.gif',
        mimeType: 'image/gif',
        contents: png,
      }),
    ).rejects.toBeInstanceOf(MimeNotAllowedError);
    // nothing written
    expect(disks.fs.files.size).toBe(0);
  });

  it('accepts a whitelisted MIME type', async () => {
    const { library } = makeLibrary({
      collections: [{ name: 'avatar', acceptsMimeTypes: ['image/png'] }],
    });
    const record = await library.attach({
      ownerType: 'User',
      ownerId: '1',
      collection: 'avatar',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: png,
    });
    expect(record.id).toBeDefined();
  });
});
