import type { Database } from '@adonisjs/lucid/database';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MediaRecord } from '../src/media_record.js';
import type { MediaStore } from '../src/media_store.js';
import { LucidMediaStore } from '../src/stores/lucid.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
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

/**
 * Seed a fixed corpus across owners/collections/paths with two rows sharing a `createdAt` (d, e) so the
 * id tie-break is exercised. The stable (createdAt desc, id desc) order over the whole set is
 * `[e, d, c, b, a]`.
 */
async function seed(store: MediaStore): Promise<void> {
  await store.save(
    record({
      id: 'a',
      collection: 'gallery',
      path: 'Post/1/gallery/a.png',
      createdAt: new Date(1000),
    }),
  );
  await store.save(
    record({
      id: 'b',
      collection: 'gallery',
      path: 'Post/1/gallery/b.png',
      createdAt: new Date(2000),
    }),
  );
  await store.save(
    record({ id: 'c', collection: 'docs', path: 'Post/1/docs/c.pdf', createdAt: new Date(3000) }),
  );
  await store.save(
    record({
      id: 'd',
      ownerId: '2',
      collection: 'gallery',
      path: 'Post/2/gallery/d.png',
      createdAt: new Date(4000),
    }),
  );
  await store.save(
    record({
      id: 'e',
      ownerType: 'User',
      ownerId: '1',
      collection: 'avatar',
      path: 'User/1/avatar/e.png',
      createdAt: new Date(4000),
    }),
  );
}

interface StoreCtx {
  store: MediaStore;
  teardown: () => Promise<void>;
}

async function inMemoryCtx(): Promise<StoreCtx> {
  return { store: new InMemoryMediaStore(), teardown: async () => {} };
}

async function lucidCtx(): Promise<StoreCtx> {
  const db: Database = makeMemoryDatabase();
  await runMediaMigration(db);
  return { store: new LucidMediaStore(db), teardown: () => db.manager.closeAll() };
}

// Both drivers must produce byte-identical ordering, filtering and cursors, so the same scenarios run
// against the real SQLite Lucid store and its in-memory twin.
describe.each([
  ['InMemoryMediaStore', inMemoryCtx],
  ['LucidMediaStore', lucidCtx],
])('%s.list (cross-owner)', (_name, makeCtx) => {
  let ctx: StoreCtx;

  beforeEach(async () => {
    ctx = await makeCtx();
    await seed(ctx.store);
  });

  afterEach(async () => {
    await ctx.teardown();
  });

  it('lists newest-first across all owners, tie-broken by id desc', async () => {
    const page = await ctx.store.list();
    expect(page.items.map((r) => r.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
    expect(page.nextCursor).toBeNull();
  });

  it('filters by owner type + id', async () => {
    const page = await ctx.store.list({ ownerType: 'Post', ownerId: '1' });
    expect(page.items.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('filters by collection across owners', async () => {
    const page = await ctx.store.list({ collection: 'gallery' });
    expect(page.items.map((r) => r.id)).toEqual(['d', 'b', 'a']);
  });

  it('filters by path prefix', async () => {
    const page = await ctx.store.list({ prefix: 'Post/1/' });
    expect(page.items.map((r) => r.id)).toEqual(['c', 'b', 'a']);
  });

  it('paginates via the opaque cursor without gaps or duplicates', async () => {
    const first = await ctx.store.list({ limit: 2 });
    expect(first.items.map((r) => r.id)).toEqual(['e', 'd']);
    expect(first.nextCursor).not.toBeNull();

    const second = await ctx.store.list({ limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((r) => r.id)).toEqual(['c', 'b']);
    expect(second.nextCursor).not.toBeNull();

    const third = await ctx.store.list({ limit: 2, cursor: second.nextCursor ?? undefined });
    expect(third.items.map((r) => r.id)).toEqual(['a']);
    expect(third.nextCursor).toBeNull();
  });

  it('combines a filter with pagination', async () => {
    const first = await ctx.store.list({ collection: 'gallery', limit: 2 });
    expect(first.items.map((r) => r.id)).toEqual(['d', 'b']);
    const second = await ctx.store.list({
      collection: 'gallery',
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((r) => r.id)).toEqual(['a']);
    expect(second.nextCursor).toBeNull();
  });

  it('clamps a non-positive limit to at least one row', async () => {
    const page = await ctx.store.list({ limit: 0 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0].id).toBe('e');
  });

  it('ignores a malformed cursor (treats it as the first page)', async () => {
    const page = await ctx.store.list({ cursor: 'not-a-real-cursor' });
    expect(page.items.map((r) => r.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });
});
