import type { Database } from '@adonisjs/lucid/database';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardService, type MediaManagerLike } from '../src/dashboard/service.js';
import type { MediaRecord } from '../src/media_record.js';
import type { MediaStore } from '../src/media_store.js';
import { LucidMediaStore } from '../src/stores/lucid.js';
import { createMediaTables } from '../src/stores/lucid-schema.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import { makeMemoryDatabase, runMediaMigration } from './lucid_helpers.js';

async function indexesOf(db: Database, table = 'media'): Promise<Record<string, string[]>> {
  const rows = (await db.rawQuery(
    `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
    [table],
  )) as Array<{ name: string }>;
  const result: Record<string, string[]> = {};
  for (const { name } of rows) {
    const columns = (await db.rawQuery(`PRAGMA index_info(${name})`)) as Array<{
      seqno: number;
      name: string;
    }>;
    result[name] = columns.sort((a, b) => a.seqno - b.seqno).map((c) => c.name);
  }
  return result;
}

async function planOf(db: Database, sql: string): Promise<string> {
  const rows = (await db.rawQuery(`EXPLAIN QUERY PLAN ${sql}`)) as Array<{ detail: string }>;
  return rows.map((r) => r.detail).join('\n');
}

function record(index: number, collection: string, size: number): MediaRecord {
  return {
    id: `m-${String(index).padStart(6, '0')}`,
    ownerType: 'Post',
    ownerId: String(index % 37),
    collection,
    name: 'n',
    fileName: 'n.png',
    mimeType: 'image/png',
    size,
    disk: 'fs',
    path: `p/${index}`,
    order: 0,
    customProperties: {},
    conversions: {},
    createdAt: new Date(1_000_000 + index),
    updatedAt: new Date(1_000_000 + index),
  };
}

function dashboardOver(store: MediaStore): DashboardService {
  const manager = {
    storage: { defaultDisk: 'fs', disk: () => ({}) as never },
    hasResumable: false,
    resumable: { list: async () => [], abort: async () => {}, listParts: async () => [] },
    store,
  } as unknown as MediaManagerLike;
  return new DashboardService(manager, { diskNames: ['fs'], actions: false });
}

let db: Database | undefined;
afterEach(async () => {
  await db?.manager.closeAll();
  db = undefined;
});

describe('media table indexes', () => {
  const expected = {
    media_owner_collection_idx: ['owner_type', 'owner_id', 'collection'],
    media_created_idx: ['created_at', 'id'],
    media_collection_created_idx: ['collection', 'created_at', 'id'],
  };

  it('createMediaTables (the auto-created schema) indexes the list() keyset', async () => {
    db = makeMemoryDatabase();
    await createMediaTables(db);
    expect(await indexesOf(db)).toEqual(expected);
  });

  it('the published migration creates the same indexes', async () => {
    db = makeMemoryDatabase();
    await runMediaMigration(db);
    expect(await indexesOf(db)).toEqual(expected);
  });

  it('a custom table name prefixes its indexes', async () => {
    db = makeMemoryDatabase();
    await createMediaTables(db, { table: 'assets' });
    expect(Object.keys(await indexesOf(db, 'assets')).sort()).toEqual([
      'assets_collection_created_idx',
      'assets_created_idx',
      'assets_owner_collection_idx',
    ]);
  });

  it('the newest-first list() pages walk an index instead of sorting the table', async () => {
    db = makeMemoryDatabase();
    await createMediaTables(db);
    const unfiltered = await planOf(
      db,
      'SELECT * FROM media ORDER BY created_at DESC, id DESC LIMIT 51',
    );
    expect(unfiltered).toContain('media_created_idx');
    expect(unfiltered).not.toContain('TEMP B-TREE');

    const byCollection = await planOf(
      db,
      `SELECT * FROM media WHERE collection = 'gallery' ORDER BY created_at DESC, id DESC LIMIT 51`,
    );
    expect(byCollection).toContain('media_collection_created_idx');
    expect(byCollection).not.toContain('TEMP B-TREE');
  });
});

describe('collectionsSummary — exact totals over a large library', () => {
  const RECORDS = 6200;

  function expectedTotals(records: MediaRecord[]) {
    const totals = new Map<string, { key: string; count: number; sumSize: number }>();
    for (const r of [...records].reverse()) {
      const entry = totals.get(r.collection) ?? { key: r.collection, count: 0, sumSize: 0 };
      entry.count += 1;
      entry.sumSize += r.size;
      totals.set(r.collection, entry);
    }
    return [...totals.values()];
  }

  const records = Array.from({ length: RECORDS }, (_, i) =>
    record(i, i % 3 === 0 ? 'docs' : i % 3 === 1 ? 'gallery' : 'avatars', (i % 11) + 1),
  );

  it('Lucid store: one GROUP BY, counting every record past 5000', async () => {
    db = makeMemoryDatabase();
    const store = new LucidMediaStore(db);
    await store.ensureSchema();
    for (let i = 0; i < records.length; i += 500) {
      await db.table('media').multiInsert(
        records.slice(i, i + 500).map((r) => ({
          id: r.id,
          owner_type: r.ownerType,
          owner_id: r.ownerId,
          collection: r.collection,
          name: r.name,
          file_name: r.fileName,
          mime_type: r.mimeType,
          size: r.size,
          disk: r.disk,
          path: r.path,
          order: r.order,
          custom_properties: '{}',
          conversions: '{}',
          created_at: r.createdAt.getTime(),
          updated_at: r.updatedAt.getTime(),
        })),
      );
    }
    let listCalls = 0;
    const list = store.list.bind(store);
    store.list = async (options) => {
      listCalls += 1;
      return list(options);
    };

    const summary = await dashboardOver(store).collectionsSummary();

    expect(summary.collections).toEqual(expectedTotals(records));
    expect(summary.collections.reduce((n, c) => n + c.count, 0)).toBe(RECORDS);
    expect(listCalls).toBe(0);
  });

  it('in-memory store: the same exact totals, in the same order', async () => {
    const store = new InMemoryMediaStore();
    for (const r of records) await store.save(r);

    const summary = await dashboardOver(store).collectionsSummary();

    expect(summary.collections).toEqual(expectedTotals(records));
  });
});
