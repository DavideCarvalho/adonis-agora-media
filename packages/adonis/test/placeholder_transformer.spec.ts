import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { transformers } from '../src/define_config.js';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaLibrary } from '../src/media_library.js';
import { SharpImageProcessor } from '../src/processors/sharp.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import type { PlaceholderEngine } from '../src/transformers/placeholder.js';

function makeLibrary(collections: MediaCollectionConfig[]) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const storage = new StorageManager({ default: 'fs', resolve });
  let counter = 0;
  const library = new MediaLibrary({
    storage,
    store: new InMemoryMediaStore(),
    collections,
    imageProcessor: new SharpImageProcessor(),
    idGenerator: () => `id-${++counter}`,
    emitDiagnostics: false,
  });
  return { library, disks };
}

/** A solid-colour PNG of the given size. */
function solidPng(width: number, height: number, rgb = { r: 200, g: 24, b: 56 }) {
  return sharp({ create: { width, height, channels: 3, background: rgb } })
    .png()
    .toBuffer();
}

async function attachImage(library: MediaLibrary, contents: Buffer, mimeType = 'image/png') {
  return library.attach({
    ownerType: 'User',
    ownerId: '1',
    collection: 'avatar',
    fileName: 'me.png',
    mimeType,
    contents,
  });
}

describe('transformers.placeholder()', () => {
  it('runs eagerly on attach and persists dataUrl, dimensions and dominant colour as meta', async () => {
    const { library, disks } = makeLibrary([
      { name: 'avatar', transformers: [transformers.placeholder()] },
    ]);
    const record = await attachImage(library, await solidPng(400, 200));

    const meta = record.conversions.placeholder?.meta;
    expect(meta).toMatchObject({ width: 400, height: 200, color: '#c81838' });
    expect(meta?.dataUrl).toMatch(/^data:image\/webp;base64,/);

    // metadata-only: no artifact written next to the original
    expect(record.conversions.placeholder?.path).toBeUndefined();
    expect([...disks.fs.files.keys()].filter((k) => k.includes('/conversions/'))).toEqual([]);

    // the tiny preview keeps the aspect ratio inside `size`
    const tiny = Buffer.from(String(meta?.dataUrl).split(',')[1] ?? '', 'base64');
    const tinyMeta = await sharp(tiny).metadata();
    expect([tinyMeta.width, tinyMeta.height]).toEqual([16, 8]);
  });

  it('honours size, name and eager options', async () => {
    const { library } = makeLibrary([
      {
        name: 'avatar',
        transformers: [transformers.placeholder({ name: 'lqip', size: 32, eager: false })],
      },
    ]);
    const record = await attachImage(library, await solidPng(100, 100));
    expect(record.conversions.lqip).toBeUndefined();

    const updated = await library.transform(record.id, 'lqip');
    const tiny = Buffer.from(
      String(updated.conversions.lqip?.meta?.dataUrl).split(',')[1] ?? '',
      'base64',
    );
    expect((await sharp(tiny).metadata()).width).toBe(32);
  });

  it('reports dimensions after EXIF orientation', async () => {
    // stored 300x100, orientation 6 (rotate 90° CW) ⇒ displays as 100x300
    const rotated = await sharp(await solidPng(300, 100))
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const { library } = makeLibrary([
      { name: 'avatar', transformers: [transformers.placeholder()] },
    ]);
    const record = await attachImage(library, rotated, 'image/jpeg');
    expect(record.conversions.placeholder?.meta).toMatchObject({ width: 100, height: 300 });
  });

  it('skips non-image records instead of failing the attach', async () => {
    const engine: PlaceholderEngine = {
      generate: () => Promise.reject(new Error('must not be called')),
    };
    const { library } = makeLibrary([
      { name: 'avatar', transformers: [transformers.placeholder({ engine })] },
    ]);
    const record = await attachImage(library, Buffer.from('%PDF-1.7'), 'application/pdf');
    expect(record.conversions.placeholder?.meta).toEqual({});
  });

  it('uses an injected engine with the configured options', async () => {
    const seen: unknown[] = [];
    const engine: PlaceholderEngine = {
      async generate(input, options) {
        seen.push({ bytes: input.byteLength, options });
        return { dataUrl: 'data:,', width: 1, height: 1, color: '#000000' };
      },
    };
    const { library } = makeLibrary([
      {
        name: 'avatar',
        transformers: [transformers.placeholder({ engine, size: 8, quality: 30 })],
      },
    ]);
    const png = await solidPng(10, 10);
    const record = await attachImage(library, png);
    expect(seen).toEqual([{ bytes: png.byteLength, options: { size: 8, quality: 30 } }]);
    expect(record.conversions.placeholder?.meta).toEqual({
      dataUrl: 'data:,',
      width: 1,
      height: 1,
      color: '#000000',
    });
  });
});

describe('SharpImageProcessor', () => {
  const processor = new SharpImageProcessor();

  it('applies the EXIF orientation before resizing', async () => {
    const rotated = await sharp(await solidPng(300, 100))
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const out = await processor.convert(rotated, { name: 'thumb', width: 50, fit: 'inside' });
    const meta = await sharp(out.data).metadata();
    expect([meta.width, meta.height]).toEqual([50, 150]);
  });

  it('blurs when the preset sets `blur`', async () => {
    // a hard black/white edge: blurring must introduce intermediate greys
    const edge = await sharp({
      create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([
        {
          input: {
            create: { width: 20, height: 40, channels: 3, background: { r: 255, g: 255, b: 255 } },
          },
          left: 20,
          top: 0,
        },
      ])
      .png()
      .toBuffer();

    const distinctGreys = async (blur?: number) => {
      const { data } = await processor.convert(edge, {
        name: 'x',
        format: 'png',
        ...(blur ? { blur } : {}),
      });
      const raw = await sharp(data).greyscale().raw().toBuffer();
      return new Set(raw).size;
    };

    expect(await distinctGreys()).toBe(2);
    expect(await distinctGreys(5)).toBeGreaterThan(10);
  });
});
