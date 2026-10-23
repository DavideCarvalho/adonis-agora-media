import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { MediaCollectionConfig } from '../src/media_collection.js';
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

/** A phone photo: 300×100 stored, orientation 6 (displays 100×300), camera and GPS in EXIF. */
async function phonePhoto() {
  return sharp({ create: { width: 300, height: 100, channels: 3, background: '#3a7' } })
    .jpeg()
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'Phone 9' },
      IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '23/1 33/1 0/1' },
    })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

function bytesOf(disk: ReturnType<typeof makeLibrary>['disk'], key: string) {
  const entry = disk.files.get(key) as { data?: Uint8Array } | Uint8Array | undefined;
  return Buffer.from(entry instanceof Uint8Array ? entry : entry!.data!);
}

async function attach(
  library: MediaLibrary,
  contents: Buffer,
  mimeType = 'image/jpeg',
  fileName = 'p.jpg',
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

const key = 'User/1/photos/id-1/p.jpg';

describe('stripMetadata collections', () => {
  it('drop EXIF (GPS, camera) from the original, bake the orientation, keep the format', async () => {
    const input = await phonePhoto();
    const before = await sharp(input).metadata();
    expect(before.exif?.toString('latin1')).toContain('TestCam');

    const { library, disk } = makeLibrary({
      name: 'photos',
      stripMetadata: true,
      conversions: [{ name: 'thumb', width: 50, eager: true }],
    });
    const record = await attach(library, input);

    const stored = bytesOf(disk, key);
    const after = await sharp(stored).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.format).toBe('jpeg');
    expect(after.orientation ?? 1).toBe(1);
    expect([after.width, after.height]).toEqual([100, 300]);
    expect(record.size).toBe(stored.byteLength);
    expect(record.mimeType).toBe('image/jpeg');
    // conversions derive from the cleaned original
    expect(record.conversions.thumb?.meta).toEqual({ width: 50, height: 150 });
  });

  it('leave an image with nothing to strip byte-for-byte untouched', async () => {
    const clean = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    const { library, disk } = makeLibrary({ name: 'photos', stripMetadata: true });
    await attach(library, clean, 'image/png', 'p.png');
    expect(bytesOf(disk, 'User/1/photos/id-1/p.png').equals(clean)).toBe(true);
  });

  it('leave non-images alone', async () => {
    const { library, disk } = makeLibrary({ name: 'photos', stripMetadata: true });
    const pdf = Buffer.from('%PDF-1.7 hello');
    await attach(library, pdf, 'application/pdf', 'p.pdf');
    expect(bytesOf(disk, 'User/1/photos/id-1/p.pdf').equals(pdf)).toBe(true);
  });

  it('are opt-in: without the flag the original is stored as uploaded', async () => {
    const input = await phonePhoto();
    const { library, disk } = makeLibrary({ name: 'photos' });
    await attach(library, input);
    expect(bytesOf(disk, key).equals(input)).toBe(true);
  });
});
