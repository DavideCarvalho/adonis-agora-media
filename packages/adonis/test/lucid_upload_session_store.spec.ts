import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UploadSession } from '../src/resumable_upload.js';
import { ResumableUploadManager } from '../src/resumable_upload.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryUploadSessionStore } from '../src/testing/in_memory_upload_session_store.js';
import { LucidUploadSessionStore } from '../src/upload_sessions/lucid.js';
import {
  makeMemoryDatabase,
  runMigrationStub,
  runUploadSessionsMigration,
} from './lucid_helpers.js';

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

describe('upload session timestamps', () => {
  let db: Database;

  beforeEach(() => {
    db = makeMemoryDatabase();
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  async function roundTrip(store: LucidUploadSessionStore | InMemoryUploadSessionStore) {
    const created = new Date('2026-07-12T00:00:00.000Z');
    const made = await store.create(session({ id: 't', createdAt: created }));
    expect(made.updatedAt).toEqual(created);
    expect((await store.get('t'))?.updatedAt).toEqual(created);

    // The caller's copy may lack createdAt (or carry another one): it never moves.
    await store.update(session({ id: 't', offset: 3, parts: 1, createdAt: undefined }));
    const after = await store.get('t');
    expect(after?.createdAt).toEqual(created);
    expect(after?.updatedAt?.getTime()).toBeGreaterThan(created.getTime());
    expect((await store.list())[0]?.updatedAt).toEqual(after?.updatedAt);
  }

  it('in-memory: created set once, updated moves on update', async () => {
    await roundTrip(new InMemoryUploadSessionStore());
  });

  it('lucid: created set once, updated moves on update', async () => {
    await runUploadSessionsMigration(db);
    const store = new LucidUploadSessionStore(db);
    expect(await store.hasUpdatedAtColumn()).toBe(true);
    await roundTrip(store);
  });

  it('lucid: a table without updated_at keeps working, and the timestamps migration adds it', async () => {
    await runUploadSessionsMigration(db);
    await db.connection().schema.alterTable('media_upload_sessions', (table) => {
      table.dropColumn('updated_at');
    });
    const legacy = new LucidUploadSessionStore(db);
    expect(await legacy.hasUpdatedAtColumn()).toBe(false);
    await legacy.create(session({ id: 'old' }));
    await legacy.update(session({ id: 'old', offset: 2 }));
    const old = await legacy.get('old');
    expect(old?.offset).toBe(2);
    expect(old?.updatedAt).toBeUndefined();

    await runMigrationStub(db, 'add_media_upload_sessions_updated_at.stub');
    // Re-running is a no-op once the column is there.
    await runMigrationStub(db, 'add_media_upload_sessions_updated_at.stub');
    const store = new LucidUploadSessionStore(db);
    expect(await store.hasUpdatedAtColumn()).toBe(true);
    // Rows stored before the column existed stay NULL (no backfill) until their next write.
    expect((await store.get('old'))?.updatedAt).toBeUndefined();
    await store.update(session({ id: 'old', offset: 4 }));
    expect((await store.get('old'))?.updatedAt).toBeInstanceOf(Date);

    await runMigrationStub(db, 'add_media_upload_sessions_updated_at.stub', { direction: 'down' });
    expect(await new LucidUploadSessionStore(db).hasUpdatedAtColumn()).toBe(false);
  });

  it('lucid: probes again while the table does not exist yet', async () => {
    const store = new LucidUploadSessionStore(db);
    expect(await store.hasUpdatedAtColumn()).toBe(false);
    await runUploadSessionsMigration(db);
    expect(await store.hasUpdatedAtColumn()).toBe(true);
  });
});
