import { describe, expect, it, vi } from 'vitest';
import { MediaObjectMissingError, MimeNotAllowedError } from '../src/errors.js';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaManager } from '../src/media_manager.js';
import { FakeImageProcessor } from '../src/testing/fake_image_processor.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import { InMemoryUploadSessionStore } from '../src/testing/in_memory_upload_session_store.js';

/** In-memory {@link MediaManager} (memory store + in-memory `fs` disk, resumable enabled). */
function makeManager(
  collections: MediaCollectionConfig[] = [],
  imageProcessor?: FakeImageProcessor,
) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const store = new InMemoryMediaStore();
  const sessions = new InMemoryUploadSessionStore();
  const manager = new MediaManager({
    defaultDisk: 'fs',
    resolve,
    store,
    collections,
    uploadSessions: sessions,
    ...(imageProcessor !== undefined ? { imageProcessor } : {}),
    emitDiagnostics: false,
  });
  return { manager, store, disks, sessions };
}

const bytes = Buffer.from('already-uploaded-bytes');

/** Land an object on the `fs` disk the way a resumable upload would, outside the library. */
function landObject(
  disks: Record<string, { put(k: string, c: Uint8Array): Promise<void> }>,
  key: string,
  contents: Buffer = bytes,
) {
  return disks.fs?.put(key, new Uint8Array(contents));
}

describe('MediaLibrary.attachExisting', () => {
  it('registers a pre-existing object in place without reading or rewriting its bytes', async () => {
    const { manager, disks } = makeManager([{ name: 'exams' }]);
    await landObject(disks, 'incoming/scan.pdf');
    const before = disks.fs.files.get('incoming/scan.pdf');
    const getBytes = vi.spyOn(disks.fs, 'getBytes');
    const put = vi.spyOn(disks.fs, 'put');
    const putStream = vi.spyOn(disks.fs, 'putStream');

    const record = await manager.library.attachExisting({
      ownerType: 'Patient',
      ownerId: 7,
      collection: 'exams',
      key: 'incoming/scan.pdf',
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      size: bytes.byteLength,
    });

    expect(record.disk).toBe('fs');
    expect(record.path).toBe('incoming/scan.pdf');
    expect(record.ownerId).toBe('7');
    expect(record.name).toBe('scan');
    expect(record.size).toBe(bytes.byteLength);
    expect(record.order).toBe(0);
    // Zero-copy: the object was never downloaded nor written again — it is the very same entry.
    expect(getBytes).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(putStream).not.toHaveBeenCalled();
    expect(disks.fs.files.get('incoming/scan.pdf')).toBe(before);
    expect(await manager.library.url(record.id)).toBe('memory://fs/incoming/scan.pdf');
  });

  it('resolves the size from disk metadata when the caller omits it, still without a download', async () => {
    const { manager, disks } = makeManager([{ name: 'exams' }]);
    await landObject(disks, 'incoming/scan.pdf');
    const getBytes = vi.spyOn(disks.fs, 'getBytes');

    const record = await manager.library.attachExisting({
      ownerType: 'Patient',
      ownerId: '7',
      collection: 'exams',
      key: 'incoming/scan.pdf',
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
    });

    expect(record.size).toBe(bytes.byteLength);
    expect(getBytes).not.toHaveBeenCalled();
  });

  it('throws MediaObjectMissingError when nothing is stored at the key', async () => {
    const { manager, store } = makeManager([{ name: 'exams' }]);

    await expect(
      manager.library.attachExisting({
        ownerType: 'Patient',
        ownerId: '7',
        collection: 'exams',
        key: 'incoming/ghost.pdf',
        fileName: 'ghost.pdf',
        mimeType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(MediaObjectMissingError);
    // Nothing was persisted for the missing object.
    expect(await store.listByOwner('Patient', '7', 'exams')).toHaveLength(0);
  });

  it("enforces the collection's acceptsMimeTypes on this path too", async () => {
    const { manager, disks } = makeManager([
      { name: 'exams', acceptsMimeTypes: ['application/pdf'] },
    ]);
    await landObject(disks, 'incoming/note.txt');

    await expect(
      manager.library.attachExisting({
        ownerType: 'Patient',
        ownerId: '7',
        collection: 'exams',
        key: 'incoming/note.txt',
        fileName: 'note.txt',
        mimeType: 'text/plain',
      }),
    ).rejects.toBeInstanceOf(MimeNotAllowedError);
    // The rejected object is left alone — the library never owned it.
    expect(disks.fs.files.has('incoming/note.txt')).toBe(true);
  });

  it('normalizes a truncated top-level MIME from the file extension on this path too', async () => {
    const { manager, disks } = makeManager([{ name: 'exams', acceptsMimeTypes: ['text/csv'] }]);
    await landObject(disks, 'incoming/rows.csv');

    const record = await manager.library.attachExisting({
      ownerType: 'Patient',
      ownerId: '7',
      collection: 'exams',
      key: 'incoming/rows.csv',
      fileName: 'rows.csv',
      mimeType: 'text', // a truncated multipart header — normalized from the .csv extension
    });

    expect(record.mimeType).toBe('text/csv');
  });

  it('replaces the previous media of a single-file collection and drops its object', async () => {
    const { manager, store, disks } = makeManager([{ name: 'avatar', single: true }]);
    await landObject(disks, 'incoming/first.png', Buffer.from('first'));
    await landObject(disks, 'incoming/second.png', Buffer.from('second'));

    const first = await manager.library.attachExisting({
      ownerType: 'AuthAccount',
      ownerId: 'acc-1',
      collection: 'avatar',
      key: 'incoming/first.png',
      fileName: 'first.png',
      mimeType: 'image/png',
    });
    const second = await manager.library.attachExisting({
      ownerType: 'AuthAccount',
      ownerId: 'acc-1',
      collection: 'avatar',
      key: 'incoming/second.png',
      fileName: 'second.png',
      mimeType: 'image/png',
    });

    const records = await store.listByOwner('AuthAccount', 'acc-1', 'avatar');
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe(second.id);
    expect(second.order).toBe(0);
    expect(await store.find(first.id)).toBeNull();
    // The superseded object is cleaned up; the surviving one is untouched.
    expect(disks.fs.files.has('incoming/first.png')).toBe(false);
    expect(disks.fs.files.has('incoming/second.png')).toBe(true);
  });

  it('generates eager conversions declared by the collection', async () => {
    const processor = new FakeImageProcessor();
    const { manager, disks } = makeManager(
      [{ name: 'avatar', conversions: [{ name: 'thumb', width: 64, height: 64, eager: true }] }],
      processor,
    );
    await landObject(disks, 'incoming/me.png');

    const record = await manager.library.attachExisting({
      ownerType: 'AuthAccount',
      ownerId: 'acc-1',
      collection: 'avatar',
      key: 'incoming/me.png',
      fileName: 'me.png',
      mimeType: 'image/png',
    });

    expect(processor.calls).toHaveLength(1);
    const thumb = record.conversions.thumb;
    expect(thumb?.path).toBe('incoming/conversions/thumb.webp');
    expect(disks.fs.files.has(thumb?.path ?? '')).toBe(true);
    // The original is still the object the caller uploaded.
    expect(disks.fs.files.get('incoming/me.png')?.data.toString()).toBe(bytes.toString());
  });

  it('moves the object into the library layout only when asked, and only server-side', async () => {
    const { manager, disks } = makeManager([{ name: 'exams' }]);
    await landObject(disks, 'incoming/scan.pdf');

    // The in-memory disk is not an ExtendedDisk: no server-side move, and the library refuses to
    // emulate one by streaming the bytes.
    await expect(
      manager.library.attachExisting({
        ownerType: 'Patient',
        ownerId: '7',
        collection: 'exams',
        key: 'incoming/scan.pdf',
        fileName: 'scan.pdf',
        mimeType: 'application/pdf',
        moveIntoLayout: true,
      }),
    ).rejects.toThrow(/server-side move/);
    expect(disks.fs.files.has('incoming/scan.pdf')).toBe(true);
  });

  it('uses the disk-native move when the disk supports it, without touching the bytes', async () => {
    const { manager, disks } = makeManager([{ name: 'exams' }]);
    await landObject(disks, 'incoming/scan.pdf');
    // Minimal ExtendedDisk surface over the in-memory disk (as `disks.s3()` provides natively).
    const moved: Array<[string, string]> = [];
    Object.assign(disks.fs, {
      capabilities: { presign: true, multipart: true, publicUrls: true, list: true },
      copy: async () => {},
      deleteMany: async () => {},
      list: async () => ({ folders: [], files: [] }),
      size: async (key: string) => (await disks.fs.getMetaData(key)).contentLength,
      stat: async (key: string) => ({ size: (await disks.fs.getMetaData(key)).contentLength }),
      move: async (from: string, to: string) => {
        moved.push([from, to]);
        const file = disks.fs.files.get(from);
        if (file) {
          disks.fs.files.set(to, file);
          disks.fs.files.delete(from);
        }
      },
    });
    const getBytes = vi.spyOn(disks.fs, 'getBytes');

    const record = await manager.library.attachExisting({
      ownerType: 'Patient',
      ownerId: '7',
      collection: 'exams',
      key: 'incoming/scan.pdf',
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
      moveIntoLayout: true,
    });

    expect(record.path).toBe(`Patient/7/exams/${record.id}/scan.pdf`);
    expect(moved).toEqual([['incoming/scan.pdf', record.path]]);
    expect(getBytes).not.toHaveBeenCalled();
    expect(disks.fs.files.has('incoming/scan.pdf')).toBe(false);
  });

  it('is reachable through the owner binding', async () => {
    const { manager, disks } = makeManager([{ name: 'exams' }]);
    await landObject(disks, 'incoming/scan.pdf');

    const record = await manager.library.for('Patient', 7).attachExisting({
      collection: 'exams',
      key: 'incoming/scan.pdf',
      fileName: 'scan.pdf',
      mimeType: 'application/pdf',
    });

    expect(record.ownerType).toBe('Patient');
    expect(record.ownerId).toBe('7');
  });
});

describe('MediaManager.completeUploadToLibrary', () => {
  it('completes a resumable session straight into a media record', async () => {
    const { manager, store, disks, sessions } = makeManager([{ name: 'exams' }]);
    const chunk = Buffer.from('chunk-one/');
    const rest = Buffer.from('chunk-two');

    const session = await manager.resumable.createUpload({
      disk: 'fs',
      key: 'uploads/exam-1.pdf',
      size: chunk.byteLength + rest.byteLength,
      contentType: 'application/pdf',
    });
    await manager.resumable.writeChunk(session.id, 0, new Uint8Array(chunk));
    await manager.resumable.writeChunk(session.id, chunk.byteLength, new Uint8Array(rest));

    const getBytes = vi.spyOn(disks.fs, 'getBytes');
    const record = await manager.completeUploadToLibrary(session.id, {
      ownerType: 'Patient',
      ownerId: '7',
      collection: 'exams',
      fileName: 'exam-1.pdf',
      mimeType: 'application/pdf',
    });

    expect(record.disk).toBe('fs');
    expect(record.path).toBe('uploads/exam-1.pdf');
    expect(record.size).toBe(chunk.byteLength + rest.byteLength);
    expect(await store.find(record.id)).not.toBeNull();
    expect(await manager.library.url(record.id)).toBe('memory://fs/uploads/exam-1.pdf');
    expect(disks.fs.files.get('uploads/exam-1.pdf')?.data.toString()).toBe('chunk-one/chunk-two');
    // The session is consumed by `complete()`.
    expect(await sessions.get(session.id)).toBeNull();
    // The assembled object is never read back: the only reads are the session's own temporary
    // chunk parts, which `complete()` concatenates into it.
    expect(getBytes.mock.calls.map(([key]) => key)).not.toContain('uploads/exam-1.pdf');
  });

  it('leaves the raw resumable.complete() path untouched (no record created)', async () => {
    const { manager, store } = makeManager([{ name: 'exams' }]);
    const session = await manager.resumable.createUpload({ disk: 'fs', key: 'uploads/blob.bin' });
    await manager.resumable.writeChunk(session.id, 0, new Uint8Array(Buffer.from('raw')));

    const result = await manager.resumable.complete(session.id);

    expect(result).toEqual({ key: 'uploads/blob.bin', disk: 'fs', size: 3 });
    expect((await store.list()).items).toHaveLength(0);
  });
});
