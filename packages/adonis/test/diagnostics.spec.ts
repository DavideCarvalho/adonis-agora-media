import { afterEach, describe, expect, it } from 'vitest';
import { publishMedia, traceMedia } from '../src/diagnostics.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
const TRACE_SLOT = Symbol.for('@agora/diagnostics:trace');

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
  delete (globalThis as Record<symbol, unknown>)[TRACE_SLOT];
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

describe('traceMedia structural trace slot', () => {
  it('returns the wrapped function result when no trace slot is installed', () => {
    expect(traceMedia('upload.policy.on_initiate', () => 42)).toBe(42);
  });

  it('propagates errors from the wrapped function when no slot is installed', () => {
    expect(() =>
      traceMedia('upload.policy.on_initiate', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });

  it('routes through the global trace slot with lib "media" when present', () => {
    const seen: Array<{ lib: string; event: string; payload: unknown }> = [];
    (globalThis as Record<symbol, unknown>)[TRACE_SLOT] = (
      lib: string,
      event: string,
      fn: () => unknown,
      payload: unknown,
    ) => {
      seen.push({ lib, event, payload });
      return fn();
    };

    const result = traceMedia('upload.policy.on_initiate', () => 'done', { user: 'u1' });

    expect(result).toBe('done');
    expect(seen).toEqual([
      { lib: 'media', event: 'upload.policy.on_initiate', payload: { user: 'u1' } },
    ]);
  });
});
