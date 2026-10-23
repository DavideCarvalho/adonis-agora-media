import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MediaDeliveryHandler, type OnDemandImageConfig } from '../src/delivery.js';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaLibrary } from '../src/media_library.js';
import { SharpImageProcessor } from '../src/processors/sharp.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

function makeLibrary(deliveryImages?: OnDemandImageConfig) {
  const collections: MediaCollectionConfig[] = [{ name: 'photos' }];
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
    deliveryMode: 'public',
    ...(deliveryImages ? { deliveryImages } : {}),
  });
  return { library, disk: disks.fs };
}

function png(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .png()
    .toBuffer();
}

function attach(
  library: MediaLibrary,
  contents: Buffer,
  mimeType = 'image/png',
  fileName = 'a.png',
) {
  return library.attach({
    ownerType: 'User',
    ownerId: '1',
    collection: 'photos',
    fileName,
    mimeType,
    contents,
  });
}

async function widthOf(
  disk: { files: Map<string, { data: Uint8Array } | Uint8Array> },
  key: string,
) {
  const entry = disk.files.get(key);
  const bytes = entry instanceof Uint8Array ? entry : entry?.data;
  return (await sharp(Buffer.from(bytes!)).metadata()).width;
}

const resizedKey = (name: string) => `User/1/photos/id-1/conversions/${name}.webp`;

describe('on-demand resize (deliver with ?w=)', () => {
  it('resizes to a whitelisted width once, then serves the cached conversion', async () => {
    const { library, disk } = makeLibrary();
    const record = await attach(library, await png(2000, 1000));

    const first = await library.deliver(record.id, { width: '640' });
    expect(first).toEqual({ kind: 'redirect', url: `memory://fs/${resizedKey('@w640q75')}` });
    expect(await widthOf(disk as never, resizedKey('@w640q75'))).toBe(640);

    const stored = await library.find(record.id);
    expect(stored?.conversions['@w640q75']?.meta).toEqual({ width: 640, height: 320 });

    // second request: no re-encode — same object, untouched
    const before = disk.files.get(resizedKey('@w640q75'));
    await library.deliver(record.id, { width: 640, quality: 75 });
    expect(disk.files.get(resizedKey('@w640q75'))).toBe(before);
  });

  it('never enlarges: past the original width it keeps the original size', async () => {
    const { library, disk } = makeLibrary();
    const record = await attach(library, await png(300, 150));
    await library.deliver(record.id, { width: 1080 });
    expect(await widthOf(disk as never, resizedKey('@w1080q75'))).toBe(300);
  });

  it('refuses widths and qualities outside the whitelist', async () => {
    const { library } = makeLibrary();
    const record = await attach(library, await png(100, 100));
    for (const width of ['641', '640px', '-1', 641]) {
      await expect(library.deliver(record.id, { width })).rejects.toMatchObject({
        code: 'E_MEDIA_IMAGE_SIZE_NOT_ALLOWED',
        field: 'width',
      });
    }
    await expect(library.deliver(record.id, { width: 640, quality: '50' })).rejects.toMatchObject({
      code: 'E_MEDIA_IMAGE_SIZE_NOT_ALLOWED',
      field: 'quality',
    });
  });

  it('honours delivery.images: widths, qualities (first is the default) and format', async () => {
    const { library } = makeLibrary({ widths: [100], qualities: [60, 90], format: 'jpeg' });
    const record = await attach(library, await png(400, 400));

    const result = await library.deliver(record.id, { width: 100 });
    expect(result).toEqual({
      kind: 'redirect',
      url: 'memory://fs/User/1/photos/id-1/conversions/@w100q60.jpeg',
    });
    await expect(library.deliver(record.id, { width: 640 })).rejects.toMatchObject({
      code: 'E_MEDIA_IMAGE_SIZE_NOT_ALLOWED',
    });
  });

  it('serves an SVG as is and refuses non-images', async () => {
    const { library } = makeLibrary();
    const svg = await attach(
      library,
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
      'image/svg+xml',
      'logo.svg',
    );
    expect(await library.deliver(svg.id, { width: 640 })).toEqual({
      kind: 'redirect',
      url: 'memory://fs/User/1/photos/id-1/logo.svg',
    });

    const pdf = await attach(library, Buffer.from('%PDF-1.7'), 'application/pdf', 'doc.pdf');
    await expect(library.deliver(pdf.id, { width: 640 })).rejects.toMatchObject({
      code: 'E_MEDIA_NOT_AN_IMAGE',
    });
  });

  it('delete() removes the resized variants with the record', async () => {
    const { library, disk } = makeLibrary();
    const record = await attach(library, await png(1000, 500));
    await library.deliver(record.id, { width: 640 });
    await library.deliver(record.id, { width: 256 });

    await library.delete(record.id);

    expect([...disk.files.keys()]).toEqual([]);
  });

  it('MediaDeliveryHandler passes ?w=/?q= through; an empty ?w= means the original', async () => {
    const { library } = makeLibrary();
    const record = await attach(library, await png(1000, 500));
    const handler = new MediaDeliveryHandler({ library });

    expect(await handler.handle({ mediaId: record.id, width: '384', quality: '75' })).toEqual({
      kind: 'redirect',
      url: `memory://fs/${resizedKey('@w384q75')}`,
    });
    expect(await handler.handle({ mediaId: record.id, width: '' })).toEqual({
      kind: 'redirect',
      url: 'memory://fs/User/1/photos/id-1/a.png',
    });
  });
});
