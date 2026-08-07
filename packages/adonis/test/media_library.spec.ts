import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MediaLibrary } from '../src/media_library.js';
import type { MediaRecord } from '../src/media_record.js';
import { StorageManager } from '../src/storage_manager.js';
import { FakeImageProcessor } from '../src/testing/fake_image_processor.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

/** In-memory store whose `save` can be armed to reject once, to exercise the orphan-cleanup path. */
class FlakyStore extends InMemoryMediaStore {
  failNextSave = false;
  override async save(record: MediaRecord): Promise<MediaRecord> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('store.save failed');
    }
    return super.save(record);
  }
}

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

/**
 * A real PNG magic-byte header (plus filler). It has to be real: a collection whose
 * `acceptsMimeTypes` are all signature-detectable rejects content carrying no recognisable
 * signature, so `Buffer.from('fake-png-bytes')` is — correctly — not a PNG.
 */
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-bytes'),
]);

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

  it('uses a caller-supplied id instead of the generated one, so re-attach overwrites the same key', async () => {
    const { library, store, disks } = makeLibrary();

    const first = await library.attach({
      ownerType: 'Post',
      ownerId: '42',
      collection: 'gallery',
      fileName: 'photo.png',
      mimeType: 'image/png',
      contents: Buffer.from('first-bytes'),
      id: 'insp-1',
    });
    // The generated id-N is bypassed entirely — path and record id are the supplied segment.
    expect(first.id).toBe('insp-1');
    expect(first.path).toBe('Post/42/gallery/insp-1/photo.png');

    const second = await library.attach({
      ownerType: 'Post',
      ownerId: '42',
      collection: 'gallery',
      fileName: 'photo.png',
      mimeType: 'image/png',
      contents: Buffer.from('second-bytes'),
      id: 'insp-1',
    });
    // Same deterministic key: the disk holds the latest bytes, not an orphan under a fresh uuid,
    // and the store still has exactly one row for the owner/collection.
    expect(second.path).toBe('Post/42/gallery/insp-1/photo.png');
    expect(disks.fs.files.get(second.path)?.data.toString()).toBe('second-bytes');
    expect(await store.listByOwner('Post', '42', 'gallery')).toHaveLength(1);
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
  it('rejects a disallowed MIME type, listing the allowed types', async () => {
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
    ).rejects.toMatchObject({
      code: 'E_MEDIA_MIME_NOT_ALLOWED',
      message: expect.stringContaining('Allowed: image/png'),
    });
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

  it('normalizes a bare top-level MIME from the file extension', async () => {
    const { library, disks } = makeLibrary({
      collections: [{ name: 'dataset', acceptsMimeTypes: ['text/csv', 'text/plain'] }],
    });
    const record = await library.attach({
      ownerType: 'Dataset',
      ownerId: '1',
      collection: 'dataset',
      fileName: 'rows.csv',
      mimeType: 'text', // a truncated multipart header — the fix for #27
      contents: Buffer.from('id,name\n1,ana\n'),
    });
    expect(record.mimeType).toBe('text/csv');
    expect(disks.fs.files.get(record.path)?.contentType).toBe('text/csv');
  });

  it('normalizes a concrete non-whitelisted MIME when the extension resolves to a whitelisted one', async () => {
    const { library } = makeLibrary({
      collections: [{ name: 'exams', acceptsMimeTypes: ['application/pdf'] }],
    });
    const record = await library.attach({
      ownerType: 'Patient',
      ownerId: '1',
      collection: 'exams',
      fileName: 'scan.pdf',
      mimeType: 'application/octet-stream', // not whitelisted, but the extension is
      contents: Buffer.from('%PDF-1.7\nfake-pdf-bytes'),
    });
    expect(record.mimeType).toBe('application/pdf');
  });

  it('rejects a generic MIME whose extension resolves to nothing, listing the allowed types', async () => {
    const { library, disks } = makeLibrary({
      collections: [{ name: 'dataset', acceptsMimeTypes: ['text/csv', 'text/plain'] }],
    });
    await expect(
      library.attach({
        ownerType: 'Dataset',
        ownerId: '1',
        collection: 'dataset',
        fileName: 'archive.xyz',
        mimeType: 'text',
        contents: Buffer.from('hello'),
      }),
    ).rejects.toMatchObject({
      code: 'E_MEDIA_MIME_NOT_ALLOWED',
      message: expect.stringContaining('Allowed: text/csv, text/plain'),
    });
    // nothing written
    expect(disks.fs.files.size).toBe(0);
  });

  it('does not rescue an extension whose MIME is not whitelisted', async () => {
    const { library } = makeLibrary({
      collections: [{ name: 'avatar', acceptsMimeTypes: ['image/png'] }],
    });
    await expect(
      library.attach({
        ownerType: 'User',
        ownerId: '1',
        collection: 'avatar',
        fileName: 'a.gif',
        mimeType: 'image', // generic top-level type, but .gif is not on the whitelist
        contents: png,
      }),
    ).rejects.toMatchObject({ code: 'E_MEDIA_MIME_NOT_ALLOWED' });
  });
});

describe('upload robustness', () => {
  it('cleans up the orphaned disk object when the store rejects the save', async () => {
    const { resolve, disks } = inMemoryDiskResolver(['fs']);
    const storage = new StorageManager({ default: 'fs', resolve });
    const store = new FlakyStore();
    store.failNextSave = true;
    const library = new MediaLibrary({
      storage,
      store,
      idGenerator: () => 'id-1',
      clock: () => new Date('2026-06-23T00:00:00.000Z'),
      emitDiagnostics: false,
    });

    await expect(
      library.attach({
        ownerType: 'Post',
        ownerId: '1',
        collection: 'gallery',
        fileName: 'a.png',
        mimeType: 'image/png',
        contents: png,
      }),
    ).rejects.toThrow('store.save failed');

    // The bytes were written before save was attempted, then removed by the compensation step.
    expect(disks.fs.files.size).toBe(0);
  });

  it('keeps the old media intact when replacing a single-file collection and the new save fails', async () => {
    const { resolve, disks } = inMemoryDiskResolver(['fs']);
    const storage = new StorageManager({ default: 'fs', resolve });
    const store = new FlakyStore();
    let counter = 0;
    const library = new MediaLibrary({
      storage,
      store,
      collections: [{ name: 'avatar', single: true }],
      idGenerator: () => `id-${++counter}`,
      clock: () => new Date('2026-06-23T00:00:00.000Z'),
      emitDiagnostics: false,
    });

    const first = await library.attach({
      ownerType: 'User',
      ownerId: '1',
      collection: 'avatar',
      fileName: 'old.png',
      mimeType: 'image/png',
      contents: png,
    });

    // Arm a failure for the replacement's save; the previous file must survive.
    store.failNextSave = true;
    await expect(
      library.attach({
        ownerType: 'User',
        ownerId: '1',
        collection: 'avatar',
        fileName: 'new.png',
        mimeType: 'image/png',
        contents: png,
      }),
    ).rejects.toThrow('store.save failed');

    // Old record + bytes intact; the failed replacement left nothing behind.
    const list = await library.list('User', '1', 'avatar');
    expect(list.map((r) => r.id)).toEqual([first.id]);
    expect(disks.fs.files.has(first.path)).toBe(true);
    expect(disks.fs.files.has('User/1/avatar/id-2/new.png')).toBe(false);
  });

  it('streams a Readable straight to the disk when the size is known and no conversions run', async () => {
    const { library, disks } = makeLibrary();
    const record = await library.attach({
      ownerType: 'Post',
      ownerId: '1',
      collection: 'gallery',
      fileName: 'big.bin',
      mimeType: 'application/octet-stream',
      contents: Readable.from([Buffer.from('streamed-'), Buffer.from('bytes')]),
      size: 13, // known up front → metadata read-back is skipped
    });

    expect(record.size).toBe(13);
    expect(disks.fs.files.get(record.path)?.data.toString()).toBe('streamed-bytes');
    // The size must REACH the disk, not just land on the record: a real S3 disk cannot write
    // a stream without it. This layer once dropped it, and every assertion above still passed
    // — the in-memory disk holds the bytes and never needs the declaration, so only a live
    // S3/MinIO surfaced it.
    expect(disks.fs.files.get(record.path)?.contentLength).toBe(13);
  });
});
