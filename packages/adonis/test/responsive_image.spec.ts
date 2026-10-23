import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { transformers } from '../src/define_config.js';
import type { ConversionPreset } from '../src/image_processor.js';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaLibrary } from '../src/media_library.js';
import type { MediaRecord } from '../src/media_record.js';
import { SharpImageProcessor } from '../src/processors/sharp.js';
import { imageCandidates } from '../src/responsive_image.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

function makeLibrary(collections: MediaCollectionConfig[]) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const storage = new StorageManager({ default: 'fs', resolve });
  const store = new InMemoryMediaStore();
  let counter = 0;
  const library = new MediaLibrary({
    storage,
    store,
    collections,
    imageProcessor: new SharpImageProcessor(),
    idGenerator: () => `id-${++counter}`,
    emitDiagnostics: false,
  });
  return { library, disks, store };
}

function png(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } } })
    .png()
    .toBuffer();
}

async function attach(library: MediaLibrary, contents: Buffer, mimeType = 'image/png') {
  return library.attach({
    ownerType: 'Course',
    ownerId: '1',
    collection: 'banner',
    fileName: 'banner.png',
    mimeType,
    contents,
  });
}

const url = (conversion: string) =>
  `memory://fs/Course/1/banner/id-1/conversions/${conversion}.webp`;
const original = 'memory://fs/Course/1/banner/id-1/banner.png';

describe('media.library.image()', () => {
  it('builds a srcset from the presets plus the original, with size and placeholder', async () => {
    const { library } = makeLibrary([
      {
        name: 'banner',
        conversions: [
          { name: 'sm', width: 320, eager: true },
          { name: 'lg', width: 800, eager: true },
        ],
        transformers: [transformers.placeholder()],
      },
    ]);
    const record = await attach(library, await png(1000, 500));

    const image = await library.image(record.id);

    expect(image.srcSet).toBe(`${url('sm')} 320w, ${url('lg')} 800w, ${original} 1000w`);
    expect(image.src).toBe(original);
    expect(image).toMatchObject({ width: 1000, height: 500 });
    expect(image.placeholder?.dataUrl).toMatch(/^data:image\/webp;base64,/);
    expect(image.placeholder?.color).toMatch(/^#[0-9a-f]{6}$/);
    // plain JSON: survives a round trip through a page prop
    expect(JSON.parse(JSON.stringify(image))).toEqual(image);
  });

  it('records the output size of each generated conversion', async () => {
    const { library } = makeLibrary([
      { name: 'banner', conversions: [{ name: 'sm', width: 320, eager: true }] },
    ]);
    const record = await attach(library, await png(1000, 500));
    expect(record.conversions.sm?.meta).toEqual({ width: 320, height: 160 });
  });

  it('leaves out presets that are not the same picture: blurred, or cropped to another aspect', async () => {
    const { library } = makeLibrary([
      {
        name: 'banner',
        conversions: [
          { name: 'thumb', width: 200, height: 200, fit: 'cover', eager: true },
          { name: 'lqip', width: 40, blur: 10, eager: true },
          { name: 'wide', width: 600, height: 300, fit: 'cover', eager: true },
        ],
        transformers: [transformers.placeholder()],
      },
    ]);
    const record = await attach(library, await png(1000, 500));

    const image = await library.image(record.id);

    // `wide` crops 2:1 out of a 2:1 original — the same picture, so it stays
    expect(image.srcSet).toBe(`${url('wide')} 600w, ${original} 1000w`);
  });

  it('skips presets that were never generated unless asked to generate them', async () => {
    const { library } = makeLibrary([
      {
        name: 'banner',
        conversions: [{ name: 'sm', width: 320 }],
        transformers: [transformers.placeholder()],
      },
    ]);
    const record = await attach(library, await png(1000, 500));

    expect((await library.image(record.id)).srcSet).toBe(`${original} 1000w`);
    expect((await library.image(record.id, { generate: true })).srcSet).toBe(
      `${url('sm')} 320w, ${original} 1000w`,
    );
    // generated once, cached on the record
    expect((await library.image(record.id)).srcSet).toBe(`${url('sm')} 320w, ${original} 1000w`);
  });

  it('limits the candidates to `conversions`', async () => {
    const { library } = makeLibrary([
      {
        name: 'banner',
        conversions: [
          { name: 'sm', width: 320, eager: true },
          { name: 'lg', width: 800, eager: true },
        ],
        transformers: [transformers.placeholder()],
      },
    ]);
    const record = await attach(library, await png(1000, 500));
    const image = await library.image(record.id, { conversions: ['lg'] });
    expect(image.srcSet).toBe(`${url('lg')} 800w, ${original} 1000w`);
  });

  it('without a placeholder: no intrinsic size, presets only, src is the widest', async () => {
    const { library } = makeLibrary([
      {
        name: 'banner',
        conversions: [
          { name: 'sm', width: 320, eager: true },
          { name: 'lg', width: 800, eager: true },
        ],
      },
    ]);
    const record = await attach(library, await png(1000, 500));

    const image = await library.image(record.id);

    expect(image).toEqual({ src: url('lg'), srcSet: `${url('sm')} 320w, ${url('lg')} 800w` });
  });

  it('with nothing to offer, src is the original and there is no srcset', async () => {
    const { library } = makeLibrary([{ name: 'banner' }]);
    const record = await attach(library, await png(10, 10));
    expect(await library.image(record.id)).toEqual({ src: original });
  });

  it('never offers an original browsers cannot decode, but keeps its size', async () => {
    const { library } = makeLibrary([
      {
        name: 'banner',
        conversions: [{ name: 'lg', width: 800, eager: true }],
        transformers: [transformers.placeholder()],
      },
    ]);
    const tiff = await sharp(await png(1000, 500))
      .tiff()
      .toBuffer();
    const record = await attach(library, tiff, 'image/tiff');

    const image = await library.image(record.id);

    expect(image.srcSet).toBe(`${url('lg')} 800w`);
    expect(image.src).toBe(url('lg'));
    expect(image).toMatchObject({ width: 1000, height: 500 });
  });

  it('signs every URL with `expiresIn`, and `url` overrides how URLs are built', async () => {
    const { library } = makeLibrary([
      {
        name: 'banner',
        conversions: [{ name: 'sm', width: 320, eager: true }],
        transformers: [transformers.placeholder()],
      },
    ]);
    const record = await attach(library, await png(1000, 500));

    const signed = await library.image(record.id, { expiresIn: 600 });
    expect(signed.srcSet).toBe(
      `${url('sm')}?signature=fake&expires=600 320w, ${original}?signature=fake&expires=600 1000w`,
    );

    const routed = await library.image(record.id, {
      expiresIn: 600,
      url: (conversion) => `/media/${record.id}${conversion ? `/${conversion}` : ''}`,
    });
    expect(routed.srcSet).toBe(`/media/id-1/sm 320w, /media/id-1 1000w`);
    expect(routed.src).toBe('/media/id-1');
  });

  it('throws MediaNotFoundError for an unknown id', async () => {
    const { library } = makeLibrary([{ name: 'banner' }]);
    await expect(library.image('nope')).rejects.toMatchObject({ code: 'E_MEDIA_RECORD_NOT_FOUND' });
  });
});

describe('media.library.image() for an art-directed group', () => {
  it('an explicit list of square crops is its own srcset, with its own size, without the original', async () => {
    const { library } = makeLibrary([
      {
        name: 'banner',
        conversions: [
          { name: 'sq-sm', width: 200, height: 200, eager: true },
          { name: 'sq-lg', width: 400, height: 400, eager: true },
          { name: 'wide', width: 640, eager: true },
        ],
        transformers: [transformers.placeholder()],
      },
    ]);
    const record = await attach(library, await png(1000, 500));

    const square = await library.image(record.id, { conversions: ['sq-sm', 'sq-lg'] });
    expect(square.srcSet).toBe(`${url('sq-sm')} 200w, ${url('sq-lg')} 400w`);
    expect(square).toMatchObject({ width: 400, height: 400 });
    expect(square.placeholder).toBeDefined();

    // the landscape default is unchanged: squares out, original in
    const wide = await library.image(record.id);
    expect(wide.srcSet).toBe(`${url('wide')} 640w, ${original} 1000w`);
    expect(wide).toMatchObject({ width: 1000, height: 500 });
  });
});

describe('imageCandidates (conversions generated before sizes were recorded)', () => {
  const record = (conversions: MediaRecord['conversions']): MediaRecord => ({
    id: 'm1',
    ownerType: 'Course',
    ownerId: '1',
    collection: 'banner',
    name: 'banner',
    fileName: 'banner.png',
    mimeType: 'image/png',
    size: 1,
    disk: 'fs',
    path: 'p/banner.png',
    order: 0,
    customProperties: {},
    conversions: {
      placeholder: { meta: { dataUrl: 'data:,', color: '#000000', width: 1000, height: 500 } },
      ...conversions,
    },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
  const presets: ConversionPreset[] = [
    { name: 'w', width: 320 },
    { name: 'cover', width: 600, height: 300, fit: 'cover' },
    { name: 'square', width: 200, height: 200, fit: 'cover' },
    { name: 'inside', width: 400, height: 400, fit: 'inside' },
    { name: 'tall', height: 300 },
  ];
  const generated = { path: 'x', disk: 'fs' };

  it('derives the width from the preset when it pins it down', () => {
    const candidates = imageCandidates(
      record({
        w: generated,
        cover: generated,
        square: generated,
        inside: generated,
        tall: generated,
      }),
      presets,
    );
    // `inside`/`tall` outputs depend on the original: unknown without the recorded size
    expect(candidates).toEqual([
      { conversion: 'w', width: 320, height: 160 },
      { conversion: 'cover', width: 600, height: 300 },
      { conversion: undefined, width: 1000, height: 500 },
    ]);
  });

  it('uses the recorded size when there is one, and dedupes equal widths', () => {
    const candidates = imageCandidates(
      record({
        inside: { ...generated, meta: { width: 400, height: 200 } },
        tall: { ...generated, meta: { width: 600, height: 300 } },
        cover: generated,
      }),
      presets,
    );
    expect(candidates).toEqual([
      { conversion: 'inside', width: 400, height: 200 },
      { conversion: 'cover', width: 600, height: 300 },
      { conversion: undefined, width: 1000, height: 500 },
    ]);
  });
});
