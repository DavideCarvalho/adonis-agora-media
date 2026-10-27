import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { FakeImageProcessor } from '../src/testing/fake_image_processor.js';
import { CountingDisk, CountingStore } from './counting_doubles.js';

/** A processor whose `stripMetadata` always rewrites, so the strip path is exercised. */
class StrippingProcessor extends FakeImageProcessor {
  stripped = 0;
  async stripMetadata(input: Buffer): Promise<Buffer> {
    this.stripped += 1;
    return Buffer.concat([Buffer.from('clean:'), input]);
  }
}

function makeLibrary(collection: MediaCollectionConfig) {
  const disk = new CountingDisk();
  const store = new CountingStore();
  const processor = new StrippingProcessor();
  const library = new MediaLibrary({
    storage: new StorageManager({ default: 'fs', resolve: () => disk }),
    store,
    collections: [collection],
    imageProcessor: processor,
    idGenerator: () => 'id-1',
    emitDiagnostics: false,
  });
  return { library, disk, store, processor };
}

const original = 'User/1/photos/id-1/p.jpg';
const eager = [
  { name: 'sm', width: 100, eager: true },
  { name: 'md', width: 200, eager: true },
  { name: 'lg', width: 400, eager: true },
];

describe('attach — eager conversions read and persist the original once', () => {
  it('buffered attach: the original is written once, never read back, and one save records every preset', async () => {
    const { library, disk, store, processor } = makeLibrary({
      name: 'photos',
      conversions: eager,
    });

    const record = await library.attach({
      ownerType: 'User',
      ownerId: '1',
      collection: 'photos',
      fileName: 'p.jpg',
      mimeType: 'image/jpeg',
      contents: Buffer.from('jpeg-bytes'),
    });

    expect(Object.keys(record.conversions).sort()).toEqual(['lg', 'md', 'sm']);
    expect(processor.calls.map((c) => c.inputSize)).toEqual([10, 10, 10]);
    expect(disk.count('getBytes')).toBe(0);
    expect(disk.count('put', original)).toBe(1);
    // The record row, then one save carrying all three conversions.
    expect(store.calls.save).toBe(2);
    expect(store.calls.find).toBeLessThanOrEqual(1);
    expect((await store.find('id-1'))?.conversions).toEqual(record.conversions);
  });

  it('stripMetadata: strips the bytes in hand before the single write, and converts from them', async () => {
    const { library, disk, store, processor } = makeLibrary({
      name: 'photos',
      stripMetadata: true,
      conversions: eager,
    });

    const record = await library.attach({
      ownerType: 'User',
      ownerId: '1',
      collection: 'photos',
      fileName: 'p.jpg',
      mimeType: 'image/jpeg',
      contents: Buffer.from('jpeg-bytes'),
    });

    expect(processor.stripped).toBe(1);
    expect(disk.count('getBytes')).toBe(0);
    expect(disk.count('put', original)).toBe(1);
    expect(Buffer.from(await disk.getBytes(original)).toString()).toBe('clean:jpeg-bytes');
    expect(record.size).toBe('clean:jpeg-bytes'.length);
    // Conversions derive from the stripped original.
    expect(processor.calls.map((c) => c.inputSize)).toEqual([16, 16, 16]);
    expect(store.calls.save).toBe(2);
  });

  it('attachExisting: reads the existing object once for every eager preset', async () => {
    const { library, disk, store } = makeLibrary({ name: 'photos', conversions: eager });
    await disk.put('uploads/p.jpg', Buffer.from('jpeg-bytes'), { contentType: 'image/jpeg' });
    disk.log.length = 0;

    const record = await library.attachExisting({
      ownerType: 'User',
      ownerId: '1',
      collection: 'photos',
      fileName: 'p.jpg',
      mimeType: 'image/jpeg',
      key: 'uploads/p.jpg',
      size: 10,
    });

    expect(Object.keys(record.conversions).sort()).toEqual(['lg', 'md', 'sm']);
    expect(disk.count('getBytes', 'uploads/p.jpg')).toBe(1);
    expect(store.calls.save).toBe(2);
  });

  it('a streamed stripMetadata attach strips what landed, and conversions reuse the stripped bytes', async () => {
    const { library, disk, processor } = makeLibrary({ name: 'photos', stripMetadata: true });

    await library.attach({
      ownerType: 'User',
      ownerId: '1',
      collection: 'photos',
      fileName: 'p.jpg',
      mimeType: 'image/jpeg',
      contents: Readable.from([Buffer.from('jpeg-bytes')]),
      size: 10,
    });

    expect(processor.stripped).toBe(1);
    expect(disk.count('putStream', original)).toBe(1);
    expect(disk.count('getBytes', original)).toBe(1);
    expect(Buffer.from(await disk.getBytes(original)).toString()).toBe('clean:jpeg-bytes');
  });

  it('a failing preset rolls back the conversions already rendered before the single save', async () => {
    const { library, disk, store, processor } = makeLibrary({ name: 'photos', conversions: eager });
    const convert = processor.convert.bind(processor);
    processor.convert = async (input, preset, options) => {
      if (preset.name === 'lg') throw new Error('boom');
      return convert(input, preset, options);
    };

    await expect(
      library.attach({
        ownerType: 'User',
        ownerId: '1',
        collection: 'photos',
        fileName: 'p.jpg',
        mimeType: 'image/jpeg',
        contents: Buffer.from('jpeg-bytes'),
      }),
    ).rejects.toThrow('boom');

    expect([...disk.files.keys()]).toEqual([]);
    expect(await store.find('id-1')).toBeNull();
  });
});
