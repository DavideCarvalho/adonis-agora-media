import { afterEach, describe, expect, it } from 'vitest';
import { publishMedia } from '../src/diagnostics.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
});

describe('diagnostics structural emit slot', () => {
  it('is a no-op when no diagnostics emitter is installed', () => {
    expect(() =>
      publishMedia('delete', { id: 'x', ownerType: 'Post', ownerId: '1' }),
    ).not.toThrow();
  });

  it('forwards lifecycle events to the global emit slot when present', async () => {
    const events: Array<{ lib: string; event: string; payload: unknown }> = [];
    (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
      lib: string,
      event: string,
      payload: unknown,
    ) => {
      events.push({ lib, event, payload });
    };

    const { resolve } = inMemoryDiskResolver(['fs']);
    const storage = new StorageManager({ default: 'fs', resolve });
    const library = new MediaLibrary({
      storage,
      store: new InMemoryMediaStore(),
      idGenerator: () => 'id-1',
    });
    const record = await library.attach({
      ownerType: 'Post',
      ownerId: '1',
      collection: 'gallery',
      fileName: 'a.png',
      mimeType: 'image/png',
      contents: Buffer.from('x'),
    });
    await library.delete(record.id);

    expect(events.map((e) => e.event)).toEqual(['attach', 'delete']);
    expect(events.every((e) => e.lib === 'media')).toBe(true);
  });
});
