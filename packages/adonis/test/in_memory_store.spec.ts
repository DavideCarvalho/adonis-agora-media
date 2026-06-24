import { describe, expect, it } from 'vitest';
import type { MediaRecord } from '../src/media_record.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

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

describe('InMemoryMediaStore', () => {
  it('saves, finds, lists ordered, and computes nextOrder', async () => {
    const store = new InMemoryMediaStore();
    await store.save(record({ id: 'a', order: 1 }));
    await store.save(record({ id: 'b', order: 0 }));
    await store.save(record({ id: 'c', collection: 'docs', order: 0 }));

    expect((await store.find('a'))?.id).toBe('a');
    expect(await store.find('missing')).toBeNull();

    const gallery = await store.listByOwner('Post', '1', 'gallery');
    expect(gallery.map((r) => r.id)).toEqual(['b', 'a']);

    const all = await store.listByOwner('Post', '1');
    expect(all).toHaveLength(3);

    expect(await store.nextOrder('Post', '1', 'gallery')).toBe(2);
    expect(await store.nextOrder('Post', '1', 'empty')).toBe(0);
  });

  it('returns defensive copies (mutating a result does not mutate the store)', async () => {
    const store = new InMemoryMediaStore();
    await store.save(record({ id: 'a' }));
    const found = await store.find('a');
    if (found) found.name = 'mutated';
    expect((await store.find('a'))?.name).toBe('a');
  });

  it('deletes records', async () => {
    const store = new InMemoryMediaStore();
    await store.save(record({ id: 'a' }));
    await store.delete('a');
    expect(await store.find('a')).toBeNull();
  });
});
