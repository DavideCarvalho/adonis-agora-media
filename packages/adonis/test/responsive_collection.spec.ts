import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { transformers } from '../src/define_config.js';
import { type MediaCollectionConfig, MediaCollectionRegistry } from '../src/media_collection.js';
import { MediaLibrary } from '../src/media_library.js';
import { SharpImageProcessor } from '../src/processors/sharp.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

function makeLibrary(collection: MediaCollectionConfig) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const library = new MediaLibrary({
    storage: new StorageManager({ default: 'fs', resolve }),
    store: new InMemoryMediaStore(),
    collections: [collection],
    imageProcessor: new SharpImageProcessor(),
    idGenerator: () => 'id-1',
    emitDiagnostics: false,
  });
  return { library, disk: disks.fs };
}

async function attach(library: MediaLibrary, width: number, height: number) {
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: 80, g: 160, b: 40 } },
  })
    .png()
    .toBuffer();
  return library.attach({
    ownerType: 'Course',
    ownerId: '1',
    collection: 'banner',
    fileName: 'b.png',
    mimeType: 'image/png',
    contents: png,
  });
}

const url = (name: string) => `memory://fs/Course/1/banner/id-1/conversions/${name}.webp`;

describe('responsive collections', () => {
  it('generate every width below the original, skip the rest, and add the placeholder', async () => {
    const { library, disk } = makeLibrary({ name: 'banner', responsive: true });
    const record = await attach(library, 1000, 500);

    expect(record.conversions['responsive-640']?.meta).toEqual({ width: 640, height: 320 });
    expect(record.conversions['responsive-1280']).toEqual({
      meta: { skipped: 'not-smaller-than-original', width: 1000, height: 500 },
    });
    const stored = [...disk.files.keys()].filter((k) => k.includes('/conversions/')).sort();
    expect(stored).toEqual([
      'Course/1/banner/id-1/conversions/responsive-320.webp',
      'Course/1/banner/id-1/conversions/responsive-640.webp',
      'Course/1/banner/id-1/conversions/responsive-960.webp',
    ]);
    expect(record.conversions.placeholder?.meta).toMatchObject({ width: 1000, height: 500 });

    const image = await library.image(record.id);
    expect(image.srcSet).toBe(
      `${url('responsive-320')} 320w, ${url('responsive-640')} 640w, ${url('responsive-960')} 960w, memory://fs/Course/1/banner/id-1/b.png 1000w`,
    );
  });

  it('take widths, format and quality', async () => {
    const { library } = makeLibrary({
      name: 'banner',
      responsive: { widths: [100, 200], format: 'avif', quality: 50 },
    });
    const record = await attach(library, 300, 300);
    expect(Object.keys(record.conversions).sort()).toEqual([
      'placeholder',
      'responsive-100',
      'responsive-200',
    ]);
    expect(record.conversions['responsive-100']?.path).toMatch(/\.avif$/);
  });

  it('keep an existing placeholder transformer, even renamed', () => {
    const registry = new MediaCollectionRegistry([
      {
        name: 'banner',
        responsive: true,
        transformers: [transformers.placeholder({ name: 'lqip' })],
      },
    ]);
    expect(registry.get('banner').transformers?.map((t) => t.name)).toEqual(['lqip']);
  });

  it('a hand-written preset with a responsive name is a conflict at boot', () => {
    expect(
      () =>
        new MediaCollectionRegistry([
          {
            name: 'banner',
            responsive: true,
            conversions: [{ name: 'responsive-640', width: 640 }],
          },
        ]),
    ).toThrow(/responsive-640/);
  });

  it('a skipped width has no artifact to serve', async () => {
    const { library } = makeLibrary({ name: 'banner', responsive: true });
    await attach(library, 500, 500);
    await expect(library.url('id-1', 'responsive-1920')).rejects.toMatchObject({
      code: 'E_MEDIA_CONVERSION_ARTIFACT_MISSING',
    });
  });
});
