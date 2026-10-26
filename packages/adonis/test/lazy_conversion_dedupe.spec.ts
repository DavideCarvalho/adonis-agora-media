import { describe, expect, it } from 'vitest';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { FakeImageProcessor } from '../src/testing/fake_image_processor.js';
import { CountingDisk, CountingStore } from './counting_doubles.js';

/** A processor that takes a moment per conversion, so concurrent requests overlap. */
class SlowProcessor extends FakeImageProcessor {
  override async convert(...args: Parameters<FakeImageProcessor['convert']>) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return super.convert(...args);
  }
}

/** A store whose reads take a moment, like a real database round trip. */
class SlowReadStore extends CountingStore {
  override async find(id: string) {
    const found = await super.find(id);
    await new Promise((resolve) => setTimeout(resolve, 2));
    return found;
  }
}

async function makeLibrary() {
  const disk = new CountingDisk();
  const store = new SlowReadStore();
  const processor = new SlowProcessor();
  const library = new MediaLibrary({
    storage: new StorageManager({ default: 'fs', resolve: () => disk }),
    store,
    collections: [
      {
        name: 'photos',
        conversions: [
          { name: 'thumb', width: 100 },
          { name: 'card', width: 400 },
          { name: 'hero', width: 1200 },
        ],
      },
    ],
    imageProcessor: processor,
    idGenerator: () => 'p-1',
    emitDiagnostics: false,
  });
  await library.attach({
    ownerType: 'User',
    ownerId: '1',
    collection: 'photos',
    fileName: 'a.png',
    mimeType: 'image/png',
    contents: Buffer.from('png'),
  });
  disk.log.length = 0;
  return { library, disk, store, processor };
}

describe('lazy conversions — concurrent requests in one process', () => {
  it('the same missing conversion requested at once is generated once', async () => {
    const { library, disk, processor } = await makeLibrary();

    const urls = await Promise.all(Array.from({ length: 8 }, () => library.url('p-1', 'thumb')));

    expect(new Set(urls).size).toBe(1);
    expect(processor.calls).toHaveLength(1);
    expect(disk.count('getBytes')).toBe(1);
    expect(disk.count('put')).toBe(1);
  });

  it('a failed generation is not cached: the next request tries again', async () => {
    const { library, processor } = await makeLibrary();
    const convert = processor.convert.bind(processor);
    let fail = true;
    processor.convert = async (...args) => {
      if (fail) throw new Error('decoder crashed');
      return convert(...args);
    };

    const failures = await Promise.allSettled([
      library.url('p-1', 'thumb'),
      library.url('p-1', 'thumb'),
    ]);
    expect(failures.map((r) => r.status)).toEqual(['rejected', 'rejected']);

    fail = false;
    await expect(library.url('p-1', 'thumb')).resolves.toContain('thumb');
  });

  it('different conversions generated at once all end up persisted', async () => {
    const { library, store } = await makeLibrary();

    await Promise.all([
      library.ensureConversion('p-1', 'thumb'),
      library.ensureConversion('p-1', 'card'),
      library.ensureConversion('p-1', 'hero'),
    ]);

    const stored = await store.find('p-1');
    expect(Object.keys(stored?.conversions ?? {}).sort()).toEqual(['card', 'hero', 'thumb']);
  });

  it('on-demand resizes of the same width are generated once', async () => {
    const { library, processor } = await makeLibrary();

    const results = await Promise.all(
      Array.from({ length: 5 }, () => library.resized('p-1', { width: 640 })),
    );

    expect(new Set(results.map((r) => r.conversion)).size).toBe(1);
    expect(processor.calls).toHaveLength(1);
  });
});
