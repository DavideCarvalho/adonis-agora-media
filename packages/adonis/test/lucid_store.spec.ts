import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MediaLibrary } from '../src/media_library.js';
import type { MediaRecord } from '../src/media_record.js';
import { StorageManager } from '../src/storage_manager.js';
import { LucidMediaStore } from '../src/stores/lucid.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { makeMemoryDatabase, runMediaMigration } from './lucid_helpers.js';

function record(over: Partial<MediaRecord>): MediaRecord {
  return {
    id: 'id',
    ownerType: 'Post',
    ownerId: '1',
    collection: 'gallery',
    name: 'a',
    fileName: 'a.png',
    mimeType: 'image/png',
    size: 1,
    disk: 'fs',
    path: 'p',
    order: 0,
    customProperties: {},
    conversions: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  };
}

describe('LucidMediaStore (sqlite, real migration)', () => {
  let db: Database;
  let store: LucidMediaStore;

  beforeEach(async () => {
    db = makeMemoryDatabase();
    // Running the package's actual migration is what guards the `order` reserved word: if knex
    // failed to quote it, `CREATE TABLE` would throw here on sqlite.
    await runMediaMigration(db);
    store = new LucidMediaStore(db);
  });

  afterEach(async () => {
    await db.manager.closeAll();
  });

  it('saves a new record and finds it back (missing → null)', async () => {
    const saved = await store.save(
      record({
        id: 'a',
        name: 'photo',
        customProperties: { alt: 'hi' },
        conversions: { thumb: { path: 't.png', disk: 'fs' } },
        createdAt: new Date('2026-06-23T00:00:00.000Z'),
        updatedAt: new Date('2026-06-23T01:00:00.000Z'),
      }),
    );
    expect(saved.id).toBe('a');

    const found = await store.find('a');
    expect(found).not.toBeNull();
    expect(found?.name).toBe('photo');
    expect(found?.customProperties).toEqual({ alt: 'hi' });
    expect(found?.conversions).toEqual({ thumb: { path: 't.png', disk: 'fs' } });
    expect(found?.createdAt).toEqual(new Date('2026-06-23T00:00:00.000Z'));
    expect(found?.updatedAt).toEqual(new Date('2026-06-23T01:00:00.000Z'));
    expect(await store.find('missing')).toBeNull();
  });

  it('save upserts an existing record by id', async () => {
    await store.save(record({ id: 'a', name: 'first' }));
    await store.save(record({ id: 'a', name: 'second', order: 5 }));
    const found = await store.find('a');
    expect(found?.name).toBe('second');
    expect(found?.order).toBe(5);
    const all = await store.listByOwner('Post', '1');
    expect(all).toHaveLength(1);
  });

  it('the atomic upsert merges every mutable column on conflict (no duplicate row)', async () => {
    await store.save(
      record({
        id: 'a',
        name: 'first',
        path: 'p1',
        size: 1,
        customProperties: { alt: 'one' },
        conversions: {},
        updatedAt: new Date('2026-06-23T00:00:00.000Z'),
      }),
    );
    // Second save of the same id takes the ON CONFLICT (id) DO UPDATE branch.
    await store.save(
      record({
        id: 'a',
        name: 'second',
        path: 'p2',
        size: 42,
        customProperties: { alt: 'two' },
        conversions: { thumb: { path: 't.png', disk: 'fs' } },
        updatedAt: new Date('2026-06-24T00:00:00.000Z'),
      }),
    );

    const found = await store.find('a');
    expect(found?.name).toBe('second');
    expect(found?.path).toBe('p2');
    expect(found?.size).toBe(42);
    expect(found?.customProperties).toEqual({ alt: 'two' });
    expect(found?.conversions).toEqual({ thumb: { path: 't.png', disk: 'fs' } });
    expect(found?.updatedAt).toEqual(new Date('2026-06-24T00:00:00.000Z'));
    // Upsert, not a second insert.
    expect(await store.listByOwner('Post', '1')).toHaveLength(1);
  });

  it('lists by owner ordered by `order`, and filters by collection', async () => {
    await store.save(record({ id: 'a', order: 2 }));
    await store.save(record({ id: 'b', order: 0 }));
    await store.save(record({ id: 'c', order: 1 }));
    await store.save(record({ id: 'd', collection: 'docs', order: 0 }));

    const gallery = await store.listByOwner('Post', '1', 'gallery');
    expect(gallery.map((r) => r.id)).toEqual(['b', 'c', 'a']);

    const all = await store.listByOwner('Post', '1');
    expect(all).toHaveLength(4);

    const other = await store.listByOwner('Post', '999');
    expect(other).toHaveLength(0);
  });

  it('nextOrder is 0 when empty and max+1 otherwise (matches in-memory semantics)', async () => {
    expect(await store.nextOrder('Post', '1', 'gallery')).toBe(0);

    await store.save(record({ id: 'a', order: 0 }));
    await store.save(record({ id: 'b', order: 3 }));
    expect(await store.nextOrder('Post', '1', 'gallery')).toBe(4);

    // Scoped per collection.
    expect(await store.nextOrder('Post', '1', 'docs')).toBe(0);
  });

  it('deletes records', async () => {
    await store.save(record({ id: 'a' }));
    await store.delete('a');
    expect(await store.find('a')).toBeNull();
    // Deleting a missing id is a no-op.
    await store.delete('a');
  });

  it('single-file collection replace works end-to-end through the library', async () => {
    const { resolve, disks } = inMemoryDiskResolver(['fs']);
    const storage = new StorageManager({ default: 'fs', resolve });
    let counter = 0;
    const library = new MediaLibrary({
      storage,
      store,
      collections: [{ name: 'avatar', single: true }],
      idGenerator: () => `id-${++counter}`,
      clock: () => new Date('2026-06-23T00:00:00.000Z'),
      emitDiagnostics: false,
    });

    const first = await library.attach({
      ownerType: 'User',
      ownerId: '7',
      collection: 'avatar',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: Buffer.from('a'),
    });
    const second = await library.attach({
      ownerType: 'User',
      ownerId: '7',
      collection: 'avatar',
      fileName: 'b.png',
      mimeType: 'image/png',
      contents: Buffer.from('b'),
    });

    // The replace deleted the first record and its bytes; only the second remains.
    const list = await library.list('User', '7', 'avatar');
    expect(list.map((r) => r.id)).toEqual([second.id]);
    expect(await store.find(first.id)).toBeNull();
    expect(disks.fs.files.has(first.path)).toBe(false);
    expect(disks.fs.files.has(second.path)).toBe(true);
    // Order is reset to 0 since the collection is empty after the replace.
    expect(second.order).toBe(0);
  });
});
