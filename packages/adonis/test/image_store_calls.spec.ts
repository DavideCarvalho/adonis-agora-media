import { describe, expect, it } from 'vitest';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { FakeImageProcessor } from '../src/testing/fake_image_processor.js';
import { CountingDisk, CountingStore } from './counting_doubles.js';

const presets = [
  { name: 'sm', width: 320, eager: true },
  { name: 'md', width: 640, eager: true },
  { name: 'lg', width: 1280, eager: true },
  { name: 'xl', width: 1920, eager: true },
];

async function makeLibrary(extra: { deliverySigning?: { secret: string } } = {}) {
  const disk = new CountingDisk();
  const store = new CountingStore();
  const library = new MediaLibrary({
    storage: new StorageManager({ default: 'fs', resolve: () => disk }),
    store,
    collections: [{ name: 'banner', conversions: presets }],
    imageProcessor: new FakeImageProcessor(),
    idGenerator: () => 'img-1',
    emitDiagnostics: false,
    ...extra,
  });
  await library.attach({
    ownerType: 'Course',
    ownerId: '1',
    collection: 'banner',
    fileName: 'b.png',
    mimeType: 'image/png',
    contents: Buffer.from('png'),
  });
  store.reset();
  return { library, store, disk };
}

describe('image() — one record fetch per image, however many srcset candidates', () => {
  it('public URLs: builds every candidate from the record in hand', async () => {
    const { library, store, disk } = await makeLibrary();

    const image = await library.image('img-1');

    expect(image.srcSet?.split(', ')).toHaveLength(presets.length);
    expect(store.calls.find).toBe(1);
    expect(disk.count('getUrl')).toBe(presets.length);
    expect(image.src).toBe(await library.url('img-1', 'xl'));
  });

  it('signed URLs (expiresIn): one fetch, and the same URLs signedUrl() gives', async () => {
    const { library, store } = await makeLibrary();

    const image = await library.image('img-1', { expiresIn: 600 });

    expect(store.calls.find).toBe(1);
    expect(image.src).toBe(await library.signedUrl('img-1', 600, { conversion: 'xl' }));
  });

  it('generate: missing presets are produced off the record in hand, then read without refetching', async () => {
    const { library, store } = await makeLibrary();
    const fresh = await store.find('img-1');
    await store.save({ ...fresh!, conversions: {} });
    store.reset();

    const image = await library.image('img-1', { generate: true });

    expect(image.srcSet?.split(', ')).toHaveLength(presets.length);
    // The initial fetch, plus each generated preset's re-read before its save.
    expect(store.calls.find).toBe(1 + presets.length);
    expect(store.calls.save).toBe(presets.length);
  });
});
