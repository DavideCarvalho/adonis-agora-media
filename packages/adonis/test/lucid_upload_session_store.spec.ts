import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UploadSession } from '../src/resumable_upload.js';
import { ResumableUploadManager } from '../src/resumable_upload.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { LucidUploadSessionStore } from '../src/upload_sessions/lucid.js';
import { makeMemoryDatabase, runUploadSessionsMigration } from './lucid_helpers.js';

function session(over: Partial<UploadSession>): UploadSession {
  return {
    id: 'id',
    disk: 'fs',
    key: 'k.bin',
    contentType: undefined,
    size: undefined,
    offset: 0,
    parts: 0,
    createdAt: new Date('2026-07-12T00:00:00.000Z'),
    ...over,
  };
}

describe('LucidUploadSessionStore (sqlite, real migration)', () => {
  let db: Database;
  let store: LucidUploadSessionStore;

  beforeEach(async () => {
    db = makeMemoryDatabase();
    await runUploadSessionsMigration(db);
    store = new LucidUploadSessionStore(db);
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('creates, finds, updates, and deletes a session (missing → null)', async () => {
    await store.create(
      session({
        id: 'a',
        key: 'up/a.bin',
        contentType: 'application/octet-stream',
        size: 10,
        metadata: { filename: 'a.bin' },
        expiresAt: new Date('2026-07-13T00:00:00.000Z'),
      }),
    );

    const found = await store.get('a');
    expect(found?.key).toBe('up/a.bin');
    expect(found?.size).toBe(10);
    expect(found?.contentType).toBe('application/octet-stream');
    expect(found?.metadata).toEqual({ filename: 'a.bin' });
    expect(found?.expiresAt).toEqual(new Date('2026-07-13T00:00:00.000Z'));
    expect(await store.get('missing')).toBeNull();

    await store.update(session({ id: 'a', key: 'up/a.bin', offset: 4, parts: 1 }));
    const updated = await store.get('a');
    expect(updated?.offset).toBe(4);
    expect(updated?.parts).toBe(1);
    // A no-longer-present size/metadata after update round-trips as undefined, not null.
    expect(updated?.size).toBeUndefined();

    await store.delete('a');
    expect(await store.get('a')).toBeNull();
  });

  it('records and lists multipart parts, and delete cascades them', async () => {
    await store.create(session({ id: 'a', multipartUploadId: 'uid-1' }));
    await store.addPart('a', { partNumber: 2, etag: 'etag-2' });
    await store.addPart('a', { partNumber: 1, etag: 'etag-1' });
    // Retried part overwrites, not duplicates.
    await store.addPart('a', { partNumber: 1, etag: 'etag-1b' });

    const parts = await store.listParts('a');
    expect(parts).toEqual([
      { partNumber: 1, etag: 'etag-1b' },
      { partNumber: 2, etag: 'etag-2' },
    ]);

    await store.delete('a');
    expect(await store.listParts('a')).toEqual([]);
  });

  it('lists in-progress sessions filtered by disk and key prefix', async () => {
    await store.create(session({ id: 'a', disk: 'fs', key: 'up/one' }));
    await store.create(session({ id: 'b', disk: 'fs', key: 'up/two' }));
    await store.create(session({ id: 'c', disk: 's3', key: 'other/three' }));

    expect((await store.list({ disk: 'fs' })).map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect((await store.list({ keyPrefix: 'up/' })).map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect((await store.list()).length).toBe(3);
  });

  it('drives an end-to-end resumable upload through the manager and Lucid store', async () => {
    const { resolve, disks } = inMemoryDiskResolver(['fs']);
    const storage = new StorageManager({ default: 'fs', resolve });
    const manager = new ResumableUploadManager({
      storage,
      sessions: store,
      idGenerator: () => 's-1',
      emitDiagnostics: false,
    });

    await manager.createUpload({ disk: 'fs', key: 'r.bin', size: 6 });
    await manager.writeChunk('s-1', 0, Buffer.from('abc'));
    // Offset persisted in SQL — a resume reads it back.
    expect((await manager.status('s-1')).offset).toBe(3);
    await manager.writeChunk('s-1', 3, Buffer.from('def'));
    await manager.complete('s-1');

    expect(disks.fs.files.get('r.bin')?.data.toString()).toBe('abcdef');
    expect(await store.get('s-1')).toBeNull();
  });
});
