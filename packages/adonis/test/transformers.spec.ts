import { describe, expect, expectTypeOf, it } from 'vitest';
import type { InferConversions, InferTransformers } from '../src/define_config.js';
import { defineConfig, transformers } from '../src/define_config.js';
import {
  ConversionArtifactMissingError,
  TransformerConflictError,
  TransformerNotDefinedError,
  TransformerOutputError,
  TransformNotReadyError,
} from '../src/errors.js';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { FakeTransformer } from '../src/testing/fake_transformer.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

function makeLibrary(collections: MediaCollectionConfig[]) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const storage = new StorageManager({ default: 'fs', resolve });
  const store = new InMemoryMediaStore();
  let counter = 0;
  const library = new MediaLibrary({
    storage,
    store,
    collections,
    idGenerator: () => `id-${++counter}`,
    clock: () => new Date('2026-07-22T00:00:00.000Z'),
    emitDiagnostics: false,
  });
  return { library, store, disks };
}

const mp4 = Buffer.from('fake-mp4-bytes');

async function attachVideo(library: MediaLibrary, collection = 'videos') {
  return library.attach({
    ownerType: 'Course',
    ownerId: '1',
    collection,
    fileName: 'lesson.mp4',
    mimeType: 'video/mp4',
    contents: mp4,
  });
}

describe('transform(): generation and persistence', () => {
  it('runs a deferred transformer explicitly and persists the multi-artifact conversion shape', async () => {
    const hls = new FakeTransformer({
      name: 'hls',
      artifacts: {
        'index.m3u8': '#EXTM3U\nplaylist-1.m3u8',
        'playlist-1.m3u8': '#EXTM3U\nsegment-1-0.ts',
        'segment-1-0.ts': 'segment-bytes',
      },
      entry: 'index.m3u8',
      meta: { durationSeconds: 12.5, segmentCount: 1 },
    });
    const { library, disks } = makeLibrary([{ name: 'videos', transformers: [hls] }]);
    const record = await attachVideo(library);

    // deferred: attach generated nothing
    expect(hls.calls).toHaveLength(0);

    const updated = await library.transform(record.id, 'hls');
    const prefix = `Course/1/videos/${record.id}/conversions/hls/`;
    expect(updated.conversions.hls).toEqual({
      path: `${prefix}index.m3u8`,
      disk: 'fs',
      prefix,
      files: ['index.m3u8', 'playlist-1.m3u8', 'segment-1-0.ts'],
      meta: { durationSeconds: 12.5, segmentCount: 1 },
    });
    for (const file of updated.conversions.hls?.files ?? []) {
      expect(disks.fs.files.has(`${prefix}${file}`)).toBe(true);
    }

    // url()/deliver() on the generated conversion resolve the entry artifact
    expect(await library.url(record.id, 'hls')).toBe(`memory://fs/${prefix}index.m3u8`);
  });

  it('is idempotent: an existing conversion short-circuits without re-running the transformer', async () => {
    const hls = new FakeTransformer({ name: 'hls', artifacts: { 'index.m3u8': 'x' } });
    const { library } = makeLibrary([{ name: 'videos', transformers: [hls] }]);
    const record = await attachVideo(library);

    await library.transform(record.id, 'hls');
    const again = await library.transform(record.id, 'hls');
    expect(hls.calls).toHaveLength(1);
    expect(again.conversions.hls).toBeDefined();
  });

  it('persists a metadata-only conversion (no artifact) and refuses to deliver it', async () => {
    const probe = new FakeTransformer({
      name: 'probe',
      entry: null,
      meta: { durationSeconds: 41.6, hasVideo: true },
    });
    const { library, disks } = makeLibrary([{ name: 'videos', transformers: [probe] }]);
    const record = await attachVideo(library);

    const updated = await library.transform(record.id, 'probe');
    expect(updated.conversions.probe).toEqual({ meta: { durationSeconds: 41.6, hasVideo: true } });
    // nothing new landed on the disk
    expect([...disks.fs.files.keys()].filter((k) => k.includes('/conversions/'))).toEqual([]);

    await expect(library.url(record.id, 'probe')).rejects.toBeInstanceOf(
      ConversionArtifactMissingError,
    );
    await expect(library.deliver(record.id, { conversion: 'probe' })).rejects.toBeInstanceOf(
      ConversionArtifactMissingError,
    );
  });

  it('throws TransformerNotDefinedError for a name the collection does not define', async () => {
    const { library } = makeLibrary([{ name: 'videos', transformers: [] }]);
    const record = await attachVideo(library);
    await expect(library.transform(record.id, 'nope')).rejects.toBeInstanceOf(
      TransformerNotDefinedError,
    );
  });

  it('read paths never generate a transform: url()/deliver() throw TransformNotReadyError until transform() runs', async () => {
    const hls = new FakeTransformer({ name: 'hls', artifacts: { 'index.m3u8': 'x' } });
    const { library } = makeLibrary([{ name: 'videos', transformers: [hls] }]);
    const record = await attachVideo(library);

    await expect(library.url(record.id, 'hls')).rejects.toBeInstanceOf(TransformNotReadyError);
    await expect(library.deliver(record.id, { conversion: 'hls' })).rejects.toBeInstanceOf(
      TransformNotReadyError,
    );
    expect(hls.calls).toHaveLength(0);

    await library.transform(record.id, 'hls');
    await expect(library.url(record.id, 'hls')).resolves.toContain('index.m3u8');
  });
});

describe('transform(): context sandbox and result contract', () => {
  it('rejects artifact paths that try to escape the conversion prefix', async () => {
    for (const hostile of ['../escape.ts', '/rooted.ts', 'a/../../x', 'trailing/', '']) {
      const bad = new FakeTransformer({
        name: 'bad',
        behavior: async (context) => {
          await context.write(hostile, Buffer.from('x'));
          return { entry: hostile };
        },
      });
      const { library } = makeLibrary([{ name: 'videos', transformers: [bad] }]);
      const record = await attachVideo(library);
      await expect(library.transform(record.id, 'bad')).rejects.toBeInstanceOf(
        TransformerOutputError,
      );
    }
  });

  it('rejects an entry that was never written', async () => {
    const bad = new FakeTransformer({
      name: 'bad',
      behavior: async (context) => {
        await context.write('real.ts', Buffer.from('x'));
        return { entry: 'imaginary.m3u8' };
      },
    });
    const { library } = makeLibrary([{ name: 'videos', transformers: [bad] }]);
    const record = await attachVideo(library);
    await expect(library.transform(record.id, 'bad')).rejects.toBeInstanceOf(
      TransformerOutputError,
    );
  });

  it('rejects artifacts without a declared entry', async () => {
    const bad = new FakeTransformer({ name: 'bad', artifacts: { 'a.ts': 'x' }, entry: null });
    const { library } = makeLibrary([{ name: 'videos', transformers: [bad] }]);
    const record = await attachVideo(library);
    await expect(library.transform(record.id, 'bad')).rejects.toBeInstanceOf(
      TransformerOutputError,
    );
  });

  it('sweeps partial artifacts when a transform fails mid-flight, so a retry starts clean', async () => {
    let attempts = 0;
    const flaky = new FakeTransformer({
      name: 'hls',
      behavior: async (context) => {
        attempts += 1;
        await context.write('index.m3u8', Buffer.from('partial'));
        if (attempts === 1) throw new Error('network died');
        await context.write('segment-0.ts', Buffer.from('bytes'));
        return { entry: 'index.m3u8' };
      },
    });
    const { library, store, disks } = makeLibrary([{ name: 'videos', transformers: [flaky] }]);
    const record = await attachVideo(library);
    const prefix = `Course/1/videos/${record.id}/conversions/hls/`;

    await expect(library.transform(record.id, 'hls')).rejects.toThrow('network died');
    // nothing persisted, nothing left on disk
    expect((await store.find(record.id))?.conversions.hls).toBeUndefined();
    expect([...disks.fs.files.keys()].filter((k) => k.startsWith(prefix))).toEqual([]);

    // the retry is a plain second call
    const updated = await library.transform(record.id, 'hls');
    expect(updated.conversions.hls?.files).toEqual(['index.m3u8', 'segment-0.ts']);
  });

  it('exposes the original through getBytes/getStream and the record on the context', async () => {
    const probe = new FakeTransformer({
      name: 'probe',
      behavior: async (context) => {
        const bytes = Buffer.from(await context.getBytes());
        return { meta: { size: bytes.byteLength, fileName: context.record.fileName } };
      },
    });
    const { library } = makeLibrary([{ name: 'videos', transformers: [probe] }]);
    const record = await attachVideo(library);
    const updated = await library.transform(record.id, 'probe');
    expect(updated.conversions.probe?.meta).toEqual({
      size: mp4.byteLength,
      fileName: 'lesson.mp4',
    });
  });
});

describe('eager transformers on attach', () => {
  it('runs eager transformers inside attach (and attachExisting — the TUS finalize path)', async () => {
    const probe = new FakeTransformer({ name: 'probe', eager: true, entry: null, meta: { ok: 1 } });
    const { library, disks } = makeLibrary([{ name: 'videos', transformers: [probe] }]);

    const attached = await attachVideo(library);
    expect(attached.conversions.probe?.meta).toEqual({ ok: 1 });

    // attachExisting funnels through the same commit — the "TUS drops the bytes, transformers
    // transform afterwards" hook needs no extra wiring.
    await disks.fs.put('landing/upload.mp4', mp4);
    const adopted = await library.attachExisting({
      ownerType: 'Course',
      ownerId: '2',
      collection: 'videos',
      key: 'landing/upload.mp4',
      fileName: 'upload.mp4',
      mimeType: 'video/mp4',
    });
    expect(adopted.conversions.probe?.meta).toEqual({ ok: 1 });
    expect(probe.calls).toHaveLength(2);
  });

  it('an eager transformer failure rolls the new media back whole and keeps the previous single-collection media', async () => {
    const eager = new FakeTransformer({
      name: 'poster',
      eager: true,
      artifacts: { 'poster.webp': 'img' },
    });
    const collections: MediaCollectionConfig[] = [
      { name: 'trailer', single: true, transformers: [eager] },
    ];
    const { library, store, disks } = makeLibrary(collections);

    const first = await library.attach({
      ownerType: 'Course',
      ownerId: '1',
      collection: 'trailer',
      fileName: 'a.mp4',
      mimeType: 'video/mp4',
      contents: mp4,
    });
    expect(first.conversions.poster).toBeDefined();

    // next upload's transform blows up
    eager.transform = async () => {
      throw new Error('undecodable');
    };
    await expect(
      library.attach({
        ownerType: 'Course',
        ownerId: '1',
        collection: 'trailer',
        fileName: 'b.mp4',
        mimeType: 'video/mp4',
        contents: Buffer.from('corrupt'),
      }),
    ).rejects.toThrow('undecodable');

    // previous media intact: record, bytes, and its transformer artifacts
    expect(await store.find(first.id)).not.toBeNull();
    expect(disks.fs.files.has(first.path)).toBe(true);
    const firstPoster = first.conversions.poster;
    expect(disks.fs.files.has(`${firstPoster?.prefix}${firstPoster?.files?.[0]}`)).toBe(true);
    expect(await library.list('Course', '1', 'trailer')).toHaveLength(1);
  });
});

describe('deletion of transformer conversions', () => {
  it('delete() removes every artifact listed on a multi-file conversion', async () => {
    const hls = new FakeTransformer({
      name: 'hls',
      artifacts: { 'index.m3u8': 'a', 'playlist-1.m3u8': 'b', 'seg-0.ts': 'c', 'seg-1.ts': 'd' },
      entry: 'index.m3u8',
    });
    const { library, disks } = makeLibrary([{ name: 'videos', transformers: [hls] }]);
    const record = await attachVideo(library);
    await library.transform(record.id, 'hls');

    expect([...disks.fs.files.keys()].filter((k) => k.includes('/conversions/hls/'))).toHaveLength(
      4,
    );
    await library.delete(record.id);
    expect(disks.fs.files.size).toBe(0);
  });
});

describe('collection registry', () => {
  it('rejects a transformer whose name collides with a conversion preset', () => {
    expect(() =>
      makeLibrary([
        {
          name: 'videos',
          conversions: [{ name: 'poster', width: 300 }],
          transformers: [new FakeTransformer({ name: 'poster' })],
        },
      ]),
    ).toThrow(TransformerConflictError);
  });

  it('rejects duplicate transformer names within one collection', () => {
    expect(() =>
      makeLibrary([
        {
          name: 'videos',
          transformers: [
            new FakeTransformer({ name: 'hls' }),
            new FakeTransformer({ name: 'hls' }),
          ],
        },
      ]),
    ).toThrow(TransformerConflictError);
  });
});

describe('config-level typing', () => {
  it('preserves transformer and conversion names as literal types through defineConfig', () => {
    const config = defineConfig({
      collections: [
        {
          name: 'gallery',
          conversions: [
            { name: 'thumb', width: 200 },
            { name: 'og', width: 1200 },
          ],
        },
        { name: 'videos', transformers: [transformers.hls(), transformers.probe()] },
        { name: 'streams', transformers: [transformers.hls({ name: 'stream' })] },
      ],
    });

    expectTypeOf<InferTransformers<typeof config>>().toEqualTypeOf<'hls' | 'probe' | 'stream'>();
    expectTypeOf<InferConversions<typeof config>>().toEqualTypeOf<
      'thumb' | 'og' | 'hls' | 'probe' | 'stream'
    >();

    // and at runtime the factories carry the same names
    expect(transformers.hls().name).toBe('hls');
    expect(transformers.probe().name).toBe('probe');
    expect(transformers.hls({ name: 'stream' }).name).toBe('stream');
  });
});
