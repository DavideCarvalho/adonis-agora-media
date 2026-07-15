import { describe, expect, it } from 'vitest';
import { ConversionNotDefinedError, ImageProcessorMissingError } from '../src/errors.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { FakeImageProcessor } from '../src/testing/fake_image_processor.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

function makeLibrary(collections: any[], imageProcessor?: any) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const storage = new StorageManager({ default: 'fs', resolve });
  const store = new InMemoryMediaStore();
  let counter = 0;
  const library = new MediaLibrary({
    storage,
    store,
    collections,
    imageProcessor,
    idGenerator: () => `id-${++counter}`,
    clock: () => new Date('2026-06-23T00:00:00.000Z'),
    emitDiagnostics: false,
  });
  return { library, store, disks };
}

const png = Buffer.from('fake-png-bytes');

describe('conversions', () => {
  it('generates a lazy conversion only on first url() and caches the path', async () => {
    const ip = new FakeImageProcessor();
    const { library, disks } = makeLibrary(
      [
        {
          name: 'gallery',
          conversions: [{ name: 'thumb', width: 200, height: 200, format: 'webp' }],
        },
      ],
      ip,
    );
    const record = await library.attach({
      ownerType: 'Post',
      ownerId: '1',
      collection: 'gallery',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: png,
    });

    // not generated on attach (lazy)
    expect(ip.calls).toHaveLength(0);

    const url1 = await library.url(record.id, 'thumb');
    expect(ip.calls).toHaveLength(1);

    const expectedPath = `Post/1/gallery/${record.id}/conversions/thumb.webp`;
    expect(url1).toBe(`memory://fs/${expectedPath}`);
    expect(disks.fs.files.has(expectedPath)).toBe(true);

    // second call uses the cached conversion (no new processor call)
    const url2 = await library.url(record.id, 'thumb');
    expect(ip.calls).toHaveLength(1);
    expect(url2).toBe(url1);
  });

  it('generates eager conversions synchronously on attach', async () => {
    const ip = new FakeImageProcessor();
    const { library } = makeLibrary(
      [{ name: 'gallery', conversions: [{ name: 'og', width: 1200, eager: true }] }],
      ip,
    );
    const record = await library.attach({
      ownerType: 'Post',
      ownerId: '1',
      collection: 'gallery',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: png,
    });
    expect(ip.calls).toHaveLength(1);
    const stored = await library.find(record.id);
    expect(stored?.conversions.og?.path).toBe(`Post/1/gallery/${record.id}/conversions/og.webp`);
  });

  it('throws when a conversion is not defined', async () => {
    const { library } = makeLibrary(
      [{ name: 'gallery', conversions: [] }],
      new FakeImageProcessor(),
    );
    const record = await library.attach({
      ownerType: 'Post',
      ownerId: '1',
      collection: 'gallery',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: png,
    });
    await expect(library.url(record.id, 'missing')).rejects.toBeInstanceOf(
      ConversionNotDefinedError,
    );
  });

  it('throws when no image processor is configured', async () => {
    const { library } = makeLibrary([
      { name: 'gallery', conversions: [{ name: 'thumb', width: 200 }] },
    ]);
    const record = await library.attach({
      ownerType: 'Post',
      ownerId: '1',
      collection: 'gallery',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: png,
    });
    await expect(library.url(record.id, 'thumb')).rejects.toBeInstanceOf(
      ImageProcessorMissingError,
    );
  });

  it('resolves the plain url and signed url for the original', async () => {
    const { library } = makeLibrary([{ name: 'gallery' }]);
    const record = await library.attach({
      ownerType: 'Post',
      ownerId: '1',
      collection: 'gallery',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: png,
    });
    expect(await library.url(record.id)).toBe(`memory://fs/${record.path}`);
    const signed = await library.signedUrl(record.id, '30m');
    expect(signed).toContain('signature=fake');
    expect(signed).toContain('expires=30m');
  });

  it('forwards contentDisposition to the disk when signing', async () => {
    const { library, disks } = makeLibrary([{ name: 'recordings' }]);
    const record = await library.attach({
      ownerType: 'Meeting',
      ownerId: '1',
      collection: 'recordings',
      fileName: 'rec.mp4',
      mimeType: 'video/mp4',
      contents: Buffer.from('bytes'),
    });

    await library.signedUrl(record.id, 300, {
      contentDisposition: 'attachment; filename="gravacao-1.mp4"',
    });

    expect(disks.fs.lastSignedUrlOptions).toEqual({
      expiresIn: 300,
      contentDisposition: 'attachment; filename="gravacao-1.mp4"',
    });
  });
});

/**
 * `attach` documents that a single-file collection only drops the old media once the new one is
 * "safely written and persisted". Eager conversions ran AFTER that delete, so a processor failure
 * destroyed the previous media and threw — the caller never persisted the new id either, leaving
 * the owner with nothing. A corrupt upload that sharp cannot decode is enough to trigger it.
 */
describe('attach: single-file replace vs eager conversion failure', () => {
  const collections = [
    { name: 'avatar', single: true, conversions: [{ name: 'thumbnail', width: 300, eager: true }] },
  ];

  it('keeps the previous media when an eager conversion throws', async () => {
    const ip = new FakeImageProcessor();
    const { library, store, disks } = makeLibrary(collections, ip);

    const first = await library.attach({
      ownerType: 'AppUser', ownerId: 'u1', collection: 'avatar',
      fileName: 'a.png', mimeType: 'image/png', contents: png,
    });
    expect(first.conversions.thumbnail).toBeDefined();

    // O upload seguinte e um arquivo que o processador nao consegue decodificar.
    ip.convert = async () => {
      throw new Error('Input buffer contains unsupported image format');
    };

    await expect(
      library.attach({
        ownerType: 'AppUser', ownerId: 'u1', collection: 'avatar',
        fileName: 'b.png', mimeType: 'image/png', contents: Buffer.from('corrupt'),
      })
    ).rejects.toThrow(/unsupported image format/);

    // O avatar anterior tem que continuar de pe: registro, bytes e a conversion dele.
    expect(await store.find(first.id)).not.toBeNull();
    expect(disks.fs.files.has(first.path)).toBe(true);
    expect(disks.fs.files.has(first.conversions.thumbnail!.path)).toBe(true);

    // E o owner nao pode ficar com dois registros numa collection single.
    expect(await library.list('AppUser', 'u1', 'avatar')).toHaveLength(1);
  });
})
