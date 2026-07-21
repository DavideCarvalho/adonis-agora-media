import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  SIGNATURE_HEAD_BYTES,
  detectMimeType,
  isClosedSignatureWhitelist,
  isDetectableMimeType,
} from '../src/content_type.js';
import {
  ContentSignatureUnrecognizedError,
  ContentTypeMismatchError,
  MimeNotAllowedError,
} from '../src/errors.js';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaManager } from '../src/media_manager.js';
import { InMemoryDisk, inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

/** Real magic-byte prefixes, padded so each sample is a plausible file rather than a bare header. */
const samples = {
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 1),
  ]),
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]),
  gif87a: Buffer.concat([Buffer.from('GIF87a', 'latin1'), Buffer.alloc(64, 3)]),
  gif89a: Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 3)]),
  webp: Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x20, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'latin1'),
    Buffer.alloc(64, 4),
  ]),
  pdf: Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 5)]),
  /** No signature in the table — an SVG is a real, legitimate example. */
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'),
  csv: Buffer.from('id,name\n1,ana\n', 'utf8'),
};

function makeManager(collections: MediaCollectionConfig[]) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const store = new InMemoryMediaStore();
  const manager = new MediaManager({
    defaultDisk: 'fs',
    resolve,
    store,
    collections,
    emitDiagnostics: false,
  });
  return { manager, store, disks };
}

describe('detectMimeType', () => {
  it('identifies every format in the embedded signature table', () => {
    expect(detectMimeType(samples.png)).toBe('image/png');
    expect(detectMimeType(samples.jpeg)).toBe('image/jpeg');
    expect(detectMimeType(samples.gif87a)).toBe('image/gif');
    expect(detectMimeType(samples.gif89a)).toBe('image/gif');
    expect(detectMimeType(samples.webp)).toBe('image/webp');
    expect(detectMimeType(samples.pdf)).toBe('application/pdf');
  });

  it('needs no more than SIGNATURE_HEAD_BYTES to decide', () => {
    for (const sample of [samples.png, samples.jpeg, samples.webp, samples.pdf]) {
      expect(detectMimeType(sample.subarray(0, SIGNATURE_HEAD_BYTES))).toBe(detectMimeType(sample));
    }
  });

  it('returns undefined for content with no known signature', () => {
    expect(detectMimeType(samples.svg)).toBeUndefined();
    expect(detectMimeType(samples.csv)).toBeUndefined();
  });

  it('returns undefined rather than reading past the end of a truncated head', () => {
    expect(detectMimeType(samples.png.subarray(0, 3))).toBeUndefined();
    // `RIFF` alone is not WEBP — the form type at offset 8 is missing.
    expect(detectMimeType(Buffer.from('RIFF', 'latin1'))).toBeUndefined();
  });

  it('does not mistake a RIFF container of another form type for WEBP', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x20, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'latin1'),
    ]);
    expect(detectMimeType(wav)).toBeUndefined();
  });
});

describe('MediaLibrary.attach — real content validation', () => {
  const collections: MediaCollectionConfig[] = [
    { name: 'exams', acceptsMimeTypes: ['application/pdf'] },
    { name: 'images', acceptsMimeTypes: ['image/png', 'image/jpeg'] },
    { name: 'anything' },
  ];

  const attach = (
    manager: MediaManager,
    input: Partial<Parameters<typeof manager.library.attach>[0]> = {},
  ) =>
    manager.library.attach({
      ownerType: 'Patient',
      ownerId: 7,
      collection: 'exams',
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      contents: samples.pdf,
      ...input,
    });

  it('accepts a buffer whose signature matches the declared type', async () => {
    const { manager, disks } = makeManager(collections);
    const record = await attach(manager);
    expect(record.mimeType).toBe('application/pdf');
    expect(disks.fs?.files.get(record.path)?.data).toEqual(samples.pdf);
  });

  it('rejects a PNG announced as a PDF, even though the declared type is whitelisted', async () => {
    const { manager, disks } = makeManager(collections);

    await expect(attach(manager, { contents: samples.png })).rejects.toBeInstanceOf(
      ContentTypeMismatchError,
    );
    // Nothing was written: validation happens before the object lands.
    expect(disks.fs?.files.size).toBe(0);
  });

  it('reports both the declared and the detected type in the error', async () => {
    const { manager } = makeManager(collections);

    await expect(attach(manager, { contents: samples.png })).rejects.toMatchObject({
      code: 'E_MEDIA_CONTENT_TYPE_MISMATCH',
      declaredMimeType: 'application/pdf',
      detectedMimeType: 'image/png',
      collection: 'exams',
      message: expect.stringContaining('image/png'),
    });
  });

  it('rejects content that contradicts the declared type even when BOTH are accepted', async () => {
    const { manager } = makeManager(collections);

    await expect(
      attach(manager, {
        collection: 'images',
        fileName: 'photo.png',
        mimeType: 'image/png',
        contents: samples.jpeg,
      }),
    ).rejects.toBeInstanceOf(ContentTypeMismatchError);
  });

  it('still rejects an unaccepted DECLARED type up front, without reading a byte', async () => {
    const { manager } = makeManager(collections);

    await expect(
      attach(manager, { mimeType: 'image/png', contents: samples.png }),
    ).rejects.toBeInstanceOf(MimeNotAllowedError);
  });

  it('falls back to the declared type for content with no known signature', async () => {
    const { manager } = makeManager([
      { name: 'vectors', acceptsMimeTypes: ['image/svg+xml', 'text/csv'] },
    ]);

    const svg = await attach(manager, {
      collection: 'vectors',
      fileName: 'logo.svg',
      mimeType: 'image/svg+xml',
      contents: samples.svg,
    });
    const csv = await attach(manager, {
      collection: 'vectors',
      fileName: 'rows.csv',
      mimeType: 'text/csv',
      contents: samples.csv,
    });

    expect(svg.mimeType).toBe('image/svg+xml');
    expect(csv.mimeType).toBe('text/csv');
  });

  it('does not sniff at all when the collection declares no acceptsMimeTypes', async () => {
    const { manager } = makeManager(collections);

    const record = await attach(manager, {
      collection: 'anything',
      mimeType: 'application/pdf',
      contents: samples.png,
    });

    expect(record.mimeType).toBe('application/pdf');
  });

  it('validates a Readable payload and still writes every byte, unbuffered', async () => {
    const { manager, disks } = makeManager(collections);
    const putStream = vi.spyOn(disks.fs as InMemoryDisk, 'putStream');

    const record = await attach(manager, {
      contents: Readable.from([samples.pdf.subarray(0, 4), samples.pdf.subarray(4)]),
      size: samples.pdf.byteLength,
    });

    // Peeking the head must not knock the attach off the streaming path.
    expect(putStream).toHaveBeenCalledOnce();
    expect(disks.fs?.files.get(record.path)?.data).toEqual(samples.pdf);
  });

  it('rejects a lying Readable payload before writing anything', async () => {
    const { manager, disks } = makeManager(collections);

    await expect(
      attach(manager, {
        contents: Readable.from([samples.png]),
        size: samples.png.byteLength,
      }),
    ).rejects.toBeInstanceOf(ContentTypeMismatchError);
    expect(disks.fs?.files.size).toBe(0);
  });

  it('validates a payload shorter than the signature window without hanging', async () => {
    const { manager } = makeManager([{ name: 'tiny', acceptsMimeTypes: ['text/plain'] }]);

    const record = await attach(manager, {
      collection: 'tiny',
      fileName: 'hi.txt',
      mimeType: 'text/plain',
      contents: Readable.from([Buffer.from('hi')]),
    });

    expect(record.size).toBe(2);
  });
});

/** A disk whose `getStream` yields one byte at a time and counts what was actually pulled. */
class ChunkCountingDisk extends InMemoryDisk {
  bytesRead = 0;

  override async getStream(key: string): Promise<Readable> {
    // Read the backing map directly, so a `getBytes` spy stays a pure signal of the library
    // downloading the object.
    const stored = this.files.get(key);
    if (!stored) throw new Error(`ChunkCountingDisk: file not found: ${key}`);
    const data = stored.data;
    const self = this;
    return Readable.from(
      (async function* () {
        for (const byte of data) {
          self.bytesRead += 1;
          yield Buffer.from([byte]);
        }
      })(),
    );
  }
}

describe('MediaLibrary.attachExisting — real content validation', () => {
  function makeCountingManager(collections: MediaCollectionConfig[]) {
    const disk = new ChunkCountingDisk('memory://fs');
    const manager = new MediaManager({
      defaultDisk: 'fs',
      resolve: () => disk,
      store: new InMemoryMediaStore(),
      collections,
      emitDiagnostics: false,
    });
    return { manager, disk };
  }

  const collections: MediaCollectionConfig[] = [
    { name: 'exams', acceptsMimeTypes: ['application/pdf'] },
  ];

  const adopt = (manager: MediaManager, key: string, mimeType = 'application/pdf') =>
    manager.library.attachExisting({
      ownerType: 'Patient',
      ownerId: 7,
      collection: 'exams',
      key,
      fileName: 'scan.pdf',
      mimeType,
    });

  it('accepts an object on the disk whose signature matches the declared type', async () => {
    const { manager, disk } = makeCountingManager(collections);
    await disk.put('incoming/scan.pdf', samples.pdf);

    const record = await adopt(manager, 'incoming/scan.pdf');

    expect(record.path).toBe('incoming/scan.pdf');
    expect(record.mimeType).toBe('application/pdf');
  });

  it('rejects an object whose real content contradicts the declared type', async () => {
    const { manager, disk } = makeCountingManager(collections);
    await disk.put('incoming/scan.pdf', samples.png);

    await expect(adopt(manager, 'incoming/scan.pdf')).rejects.toBeInstanceOf(
      ContentTypeMismatchError,
    );
  });

  /**
   * The whole point of `attachExisting` is not moving the bytes. Validation must stay a short head
   * read: a 100 KiB object may cost at most the signature window, never a download.
   */
  it('reads only the signature head, never the whole object', async () => {
    const { manager, disk } = makeCountingManager(collections);
    const big = Buffer.concat([samples.pdf, Buffer.alloc(100_000, 7)]);
    await disk.put('incoming/big.pdf', big);
    const getBytes = vi.spyOn(disk, 'getBytes');

    await adopt(manager, 'incoming/big.pdf');

    // Bounded by the signature window, NOT by the object size. The `+ 1` is Node's one-chunk
    // read-ahead in `Readable.from`, which produces a byte the validator never consumes.
    expect(disk.bytesRead).toBeGreaterThan(0);
    expect(disk.bytesRead).toBeLessThanOrEqual(SIGNATURE_HEAD_BYTES + 1);
    expect(disk.bytesRead / big.byteLength).toBeLessThan(0.001);
    // And it never fell back to downloading the object.
    expect(getBytes).not.toHaveBeenCalled();
  });

  it('does not open a stream at all when the collection declares no acceptsMimeTypes', async () => {
    const { manager, disk } = makeCountingManager([{ name: 'exams' }]);
    await disk.put('incoming/scan.pdf', samples.pdf);
    const getStream = vi.spyOn(disk, 'getStream');

    await adopt(manager, 'incoming/scan.pdf');

    expect(getStream).not.toHaveBeenCalled();
  });

  it('falls back to the declared type for an object with no known signature', async () => {
    const { manager, disk } = makeCountingManager([
      { name: 'exams', acceptsMimeTypes: ['text/csv'] },
    ]);
    await disk.put('incoming/rows.csv', samples.csv);

    const record = await adopt(manager, 'incoming/rows.csv', 'text/csv');

    expect(record.mimeType).toBe('text/csv');
  });
});

describe('closed vs open signature whitelists', () => {
  it('knows which types the signature table can prove', () => {
    expect(isDetectableMimeType('application/pdf')).toBe(true);
    expect(isDetectableMimeType('image/png')).toBe(true);
    expect(isDetectableMimeType('image/svg+xml')).toBe(false);
    expect(isDetectableMimeType('text/plain')).toBe(false);
  });

  it('is closed only when EVERY accepted type is detectable', () => {
    expect(isClosedSignatureWhitelist(['application/pdf'])).toBe(true);
    expect(isClosedSignatureWhitelist(['image/png', 'image/jpeg'])).toBe(true);
    expect(isClosedSignatureWhitelist(['application/pdf', 'image/svg+xml'])).toBe(false);
    expect(isClosedSignatureWhitelist(['text/csv'])).toBe(false);
    // An empty list whitelists nothing to reason from, so it proves nothing either.
    expect(isClosedSignatureWhitelist([])).toBe(false);
  });
});

/**
 * The refinement over "unrecognised ⇒ accept". Under a whitelist whose every type IS detectable,
 * content matching no signature cannot be any accepted type — so the library rejects it instead of
 * leaving each consuming app to reimplement the same `detectMimeType(...) === undefined` check.
 */
describe('unrecognised signature under a closed whitelist', () => {
  const txt = Buffer.from('a plain text file pretending to be a PDF\n', 'utf8');

  it('attach rejects unrecognised content when every accepted type is detectable', async () => {
    const { manager, disks } = makeManager([
      { name: 'exams', acceptsMimeTypes: ['application/pdf'] },
    ]);

    await expect(
      manager.library.attach({
        ownerType: 'Patient',
        ownerId: 7,
        collection: 'exams',
        fileName: 'scan.pdf',
        mimeType: 'application/pdf',
        contents: txt,
      }),
    ).rejects.toBeInstanceOf(ContentSignatureUnrecognizedError);
    // Rejected before the object landed.
    expect(disks.fs?.files.size).toBe(0);
  });

  it('reports a distinct code, separate from a positive mismatch', async () => {
    const { manager } = makeManager([{ name: 'exams', acceptsMimeTypes: ['application/pdf'] }]);

    await expect(
      manager.library.attach({
        ownerType: 'Patient',
        ownerId: 7,
        collection: 'exams',
        fileName: 'scan.pdf',
        mimeType: 'application/pdf',
        contents: txt,
      }),
    ).rejects.toMatchObject({
      code: 'E_MEDIA_CONTENT_SIGNATURE_UNRECOGNIZED',
      collection: 'exams',
      declaredMimeType: 'application/pdf',
    });
  });

  it('attachExisting rejects it too — the app no longer needs its own check', async () => {
    const { manager, disks } = makeManager([
      { name: 'exams', acceptsMimeTypes: ['application/pdf'] },
    ]);
    await disks.fs?.put('incoming/note.pdf', txt);

    await expect(
      manager.library.attachExisting({
        ownerType: 'Patient',
        ownerId: 7,
        collection: 'exams',
        key: 'incoming/note.pdf',
        fileName: 'note.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(ContentSignatureUnrecognizedError);
    // The object was never ours to delete.
    expect(disks.fs?.files.has('incoming/note.pdf')).toBe(true);
  });

  it('still accepts unrecognised content when ONE accepted type has no signature', async () => {
    const { manager } = makeManager([
      { name: 'mixed', acceptsMimeTypes: ['application/pdf', 'image/svg+xml'] },
    ]);

    const record = await manager.library.attach({
      ownerType: 'Patient',
      ownerId: 7,
      collection: 'mixed',
      fileName: 'logo.svg',
      mimeType: 'image/svg+xml',
      contents: samples.svg,
    });

    expect(record.mimeType).toBe('image/svg+xml');
  });

  it('never sniffs a collection with no acceptsMimeTypes, closed or not', async () => {
    const { manager } = makeManager([{ name: 'anything' }]);

    const record = await manager.library.attach({
      ownerType: 'Patient',
      ownerId: 7,
      collection: 'anything',
      fileName: 'note.pdf',
      mimeType: 'application/pdf',
      contents: txt,
    });

    expect(record.mimeType).toBe('application/pdf');
  });
});
