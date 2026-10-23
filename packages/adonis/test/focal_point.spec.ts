import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaLibrary } from '../src/media_library.js';
import { SharpImageProcessor } from '../src/processors/sharp.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

const RED = { r: 230, g: 20, b: 20 };
const BLUE = { r: 20, g: 20, b: 230 };

/** 400×200: left half red, right half blue. */
async function halves(format: 'png' | 'jpeg' = 'png') {
  const half = (background: typeof RED) =>
    sharp({ create: { width: 200, height: 200, channels: 3, background } })
      .png()
      .toBuffer();
  const image = sharp({
    create: { width: 400, height: 200, channels: 3, background: '#000' },
  }).composite([
    { input: await half(RED), left: 0, top: 0 },
    { input: await half(BLUE), left: 200, top: 0 },
  ]);
  return format === 'png' ? image.png().toBuffer() : image.jpeg({ quality: 95 }).toBuffer();
}

/** `'red'`, `'blue'` or `'mixed'` by the average colour of the image. */
async function colourOf(bytes: Uint8Array) {
  const { channels } = await sharp(Buffer.from(bytes)).stats();
  const [r, , b] = channels.map((c) => c.mean);
  if (r! > 180 && b! < 70) return 'red';
  if (b! > 180 && r! < 70) return 'blue';
  return 'mixed';
}

const processor = new SharpImageProcessor();
const square = { name: 'square', width: 100, height: 100 } as const;

describe('crops: position and focal point', () => {
  it('crops around the centre by default, a gravity with `position`', async () => {
    const input = await halves();
    expect(await colourOf((await processor.convert(input, square)).data)).toBe('mixed');
    expect(
      await colourOf((await processor.convert(input, { ...square, position: 'left' })).data),
    ).toBe('red');
  });

  it('keeps the focal point, which wins over `position`', async () => {
    const input = await halves();
    const at = (x: number) =>
      processor.convert(input, { ...square, position: 'left' }, { focalPoint: { x, y: 0.5 } });
    expect(await colourOf((await at(0.9)).data)).toBe('blue');
    expect(await colourOf((await at(0.1)).data)).toBe('red');
    expect([(await at(0.9)).width, (await at(0.9)).height]).toEqual([100, 100]);
  });

  it('reads the focal point in displayed coordinates, after EXIF orientation', async () => {
    // orientation 6 = rotate 90° clockwise: the red left half is displayed on top
    const rotated = await sharp(await halves('jpeg'))
      .withMetadata({ orientation: 6 })
      .jpeg({ quality: 95 })
      .toBuffer();
    const top = await processor.convert(rotated, square, { focalPoint: { x: 0.5, y: 0.1 } });
    const bottom = await processor.convert(rotated, square, { focalPoint: { x: 0.5, y: 0.9 } });
    expect(await colourOf(top.data)).toBe('red');
    expect(await colourOf(bottom.data)).toBe('blue');
  });

  it('leaves presets that do not crop alone', async () => {
    const out = await processor.convert(
      await halves(),
      { name: 'w', width: 100 },
      { focalPoint: { x: 0.9, y: 0.5 } },
    );
    expect([out.width, out.height]).toEqual([100, 50]);
    expect(await colourOf(out.data)).toBe('mixed');
  });
});

describe('media.library.setFocalPoint()', () => {
  function makeLibrary() {
    const collections: MediaCollectionConfig[] = [
      {
        name: 'avatar',
        conversions: [
          { name: 'square', width: 100, height: 100, eager: true },
          { name: 'tiny', width: 40, height: 40 },
          { name: 'wide', width: 200, eager: true },
        ],
      },
    ];
    const { resolve, disks } = inMemoryDiskResolver(['fs']);
    const library = new MediaLibrary({
      storage: new StorageManager({ default: 'fs', resolve }),
      store: new InMemoryMediaStore(),
      collections,
      imageProcessor: processor,
      idGenerator: () => 'id-1',
      emitDiagnostics: false,
    });
    return { library, disk: disks.fs };
  }
  const bytesAt = (disk: ReturnType<typeof makeLibrary>['disk'], key: string) => {
    const entry = disk.files.get(key) as { data?: Uint8Array } | Uint8Array | undefined;
    return entry instanceof Uint8Array ? entry : entry!.data!;
  };
  const key = (name: string) => `User/1/avatar/id-1/conversions/${name}.webp`;

  it('stores the point, re-cuts the eager crops, drops the lazy ones, leaves the rest', async () => {
    const { library, disk } = makeLibrary();
    await library.attach({
      ownerType: 'User',
      ownerId: '1',
      collection: 'avatar',
      fileName: 'me.png',
      mimeType: 'image/png',
      contents: await halves(),
    });
    await library.url('id-1', 'tiny'); // generate the lazy crop
    const wideBefore = disk.files.get(key('wide'));
    expect(await colourOf(bytesAt(disk, key('square')))).toBe('mixed');

    const record = await library.setFocalPoint('id-1', { x: 0.9, y: 0.5 });

    expect(record.customProperties.focalPoint).toEqual({ x: 0.9, y: 0.5 });
    expect(await colourOf(bytesAt(disk, key('square')))).toBe('blue');
    expect(record.conversions.tiny).toBeUndefined();
    expect(disk.files.has(key('tiny'))).toBe(false);
    expect(disk.files.get(key('wide'))).toBe(wideBefore);

    // the lazy crop comes back cut around the point
    await library.url('id-1', 'tiny');
    expect(await colourOf(bytesAt(disk, key('tiny')))).toBe('blue');

    // and image() hands it to the client for CSS crops
    expect((await library.image('id-1')).focalPoint).toEqual({ x: 0.9, y: 0.5 });
  });

  it('null clears it; out-of-range points are refused', async () => {
    const { library } = makeLibrary();
    await library.attach({
      ownerType: 'User',
      ownerId: '1',
      collection: 'avatar',
      fileName: 'me.png',
      mimeType: 'image/png',
      contents: await halves(),
      customProperties: { alt: 'me', focalPoint: { x: 0.1, y: 0.5 } },
    });
    // set at attach, through customProperties: the eager crop was cut around it already
    const cleared = await library.setFocalPoint('id-1', null);
    expect(cleared.customProperties).toEqual({ alt: 'me' });
    await expect(library.setFocalPoint('id-1', { x: 1.2, y: 0 })).rejects.toBeInstanceOf(
      RangeError,
    );
  });
});
