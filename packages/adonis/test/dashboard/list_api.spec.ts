import { describe, expect, it, vi } from 'vitest';
import {
  readCollectionsQuery,
  readObjectsQuery,
  readUploadsQuery,
} from '../../src/dashboard/list_api.js';
import { DashboardError, DashboardService } from '../../src/dashboard/service.js';
import type { MediaRecord } from '../../src/media_record.js';
import { InMemoryMediaStore } from '../../src/testing/in_memory_media_store.js';

/** A request context whose query string decodes to `qs` (AdonisJS hands nested objects over). */
const ctxWith = (qs: Record<string, unknown>) => ({ request: { qs: () => qs } });

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('console list API: request readers', () => {
  it('objects: filter[disk] and filter[prefix] dispatch, with forward cursor params', async () => {
    const read = await readObjectsQuery(
      ctxWith({ filter: { disk: 's3', prefix: 'photos/' }, after: 'tok', first: '20' }),
    );
    expect(read).toEqual({ disk: 's3', params: { prefix: 'photos/', after: 'tok', first: 20 } });
  });

  it('objects: filter[disk] is required, and the page size defaults to and caps at 1000', async () => {
    const missing = await rejection(readObjectsQuery(ctxWith({})));
    expect(missing).toBeInstanceOf(DashboardError);
    expect((missing as DashboardError).status).toBe(400);
    expect(await readObjectsQuery(ctxWith({ filter: { disk: 's3' } }))).toEqual({
      disk: 's3',
      params: { first: 1000 },
    });
    expect(
      (await readObjectsQuery(ctxWith({ filter: { disk: 's3' }, first: '5000' }))).params.first,
    ).toBe(1000);
  });

  it('objects: an unknown filter field or an unsupported operator is a 400', async () => {
    expect(
      await rejection(readObjectsQuery(ctxWith({ filter: { disk: 's3', owner: 'x' } }))),
    ).toMatchObject({ status: 400 });
    expect(
      await rejection(readObjectsQuery(ctxWith({ filter: { disk: { contains: 's' } } }))),
    ).toMatchObject({ status: 400 });
  });

  it('objects: only the store order (`key`) sorts; anything else is refused', async () => {
    await expect(
      readObjectsQuery(ctxWith({ filter: { disk: 's3' }, sort: 'key' })),
    ).resolves.toBeTruthy();
    for (const sort of ['-key', 'name', 'key,-size']) {
      expect(
        await rejection(readObjectsQuery(ctxWith({ filter: { disk: 's3' }, sort }))),
      ).toMatchObject({ status: 400 });
    }
  });

  it('objects and collections page forward only: `before` / `last` are a 400', async () => {
    for (const extra of [{ before: 'tok' }, { last: '10' }]) {
      const error = await rejection(
        readObjectsQuery(ctxWith({ filter: { disk: 's3' }, ...extra })),
      );
      expect((error as DashboardError).status).toBe(400);
      const other = await rejection(readCollectionsQuery(ctxWith(extra)));
      expect((other as DashboardError).status).toBe(400);
    }
  });

  it('collections: every filter dispatches; the page size defaults to 50 and caps at 200', async () => {
    const read = await readCollectionsQuery(
      ctxWith({
        filter: { collection: 'gallery', ownerType: 'Post', ownerId: '42', prefix: 'Post/' },
        after: 'c1',
      }),
    );
    expect(read).toEqual({
      collection: 'gallery',
      ownerType: 'Post',
      ownerId: '42',
      prefix: 'Post/',
      after: 'c1',
      first: 50,
    });
    expect((await readCollectionsQuery(ctxWith({ first: '999' }))).first).toBe(200);
  });

  it('collections: only `-createdAt` sorts; an unknown filter field is refused', async () => {
    await expect(readCollectionsQuery(ctxWith({ sort: '-createdAt' }))).resolves.toBeTruthy();
    for (const sort of ['createdAt', 'name']) {
      expect(await rejection(readCollectionsQuery(ctxWith({ sort })))).toMatchObject({
        status: 400,
      });
    }
    expect(
      await rejection(readCollectionsQuery(ctxWith({ filter: { mimeType: 'image/png' } }))),
    ).toMatchObject({ status: 400 });
  });

  it('uploads: filters dispatch, `createdAt` sorts either way, newest first by default', async () => {
    expect(await readUploadsQuery(ctxWith({ filter: { disk: 's3', prefix: 'v/' } }))).toEqual({
      disk: 's3',
      prefix: 'v/',
      order: 'desc',
    });
    expect((await readUploadsQuery(ctxWith({ sort: 'createdAt' }))).order).toBe('asc');
    expect(await rejection(readUploadsQuery(ctxWith({ sort: 'key' })))).toMatchObject({
      status: 400,
    });
    expect(
      await rejection(readUploadsQuery(ctxWith({ filter: { status: 'open' } }))),
    ).toMatchObject({ status: 400 });
  });
});

describe('console list API: cursor walk over a real store', () => {
  it('walks every record forward with after/first, then reports the last page', async () => {
    const store = new InMemoryMediaStore();
    for (let i = 0; i < 5; i += 1) {
      await store.save({
        id: `m${i}`,
        ownerType: 'Post',
        ownerId: '1',
        collection: 'gallery',
        name: `m${i}`,
        fileName: `m${i}.jpg`,
        mimeType: 'image/jpeg',
        size: 1,
        disk: 's3',
        path: `Post/1/gallery/m${i}.jpg`,
        conversions: {},
        customProperties: {},
        order: i,
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
        updatedAt: new Date(Date.UTC(2026, 0, 1 + i)),
      } as unknown as MediaRecord);
    }
    const svc = new DashboardService(
      {
        storage: { defaultDisk: 's3', disk: vi.fn() as never },
        hasResumable: false,
        resumable: {} as never,
        store,
      } as never,
      { diskNames: ['s3'], actions: false },
    );
    const seen: string[] = [];
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      const params = await readCollectionsQuery(
        ctxWith({ filter: { collection: 'gallery' }, first: '2', ...(after ? { after } : {}) }),
      );
      const page = await svc.collections(params);
      pages += 1;
      seen.push(...page.data.map((entry) => entry.id));
      expect(page.meta.prevCursor).toBeNull();
      expect(page.meta.hasPrev).toBe(false);
      if (!page.meta.hasNext) {
        expect(page.meta.nextCursor).toBeNull();
        break;
      }
      after = page.meta.nextCursor ?? undefined;
    }
    expect(pages).toBe(3);
    expect(seen).toEqual(['m4', 'm3', 'm2', 'm1', 'm0']);
  });
});
