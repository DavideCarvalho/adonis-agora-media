import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { authorizers, type MediaSubject } from '../src/access.js';
import { openWithMetadata } from '../src/disk_read.js';
import { ImageSizeNotAllowedError, MediaNotFoundError } from '../src/errors.js';
import { MediaAccess } from '../src/media_access.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { FakeImageProcessor } from '../src/testing/fake_image_processor.js';
import type { Disk, DiskMetaData } from '../src/types.js';
import { CountingDisk, CountingStore } from './counting_doubles.js';

/** A disk whose metadata/stream calls resolve only when the test releases them. */
function gatedDisk() {
  const started: string[] = [];
  let releaseMeta!: (value: DiskMetaData | Error) => void;
  let releaseStream!: (value: Readable | Error) => void;
  const settle = <T>(value: T | Error) => (value instanceof Error ? Promise.reject(value) : value);
  const disk = {
    getMetaData: () => {
      started.push('meta');
      return new Promise<DiskMetaData | Error>((r) => (releaseMeta = r)).then(settle);
    },
    getStream: () => {
      started.push('stream');
      return new Promise<Readable | Error>((r) => (releaseStream = r)).then(settle);
    },
  } as unknown as Disk;
  return {
    disk,
    started,
    releaseMeta: (v: DiskMetaData | Error) => releaseMeta(v),
    releaseStream: (v: Readable | Error) => releaseStream(v),
  };
}

describe('openWithMetadata', () => {
  it('issues the metadata and stream reads together, not one after the other', async () => {
    const gated = gatedDisk();
    const pending = openWithMetadata(gated.disk, 'k');
    await Promise.resolve();
    // Both are in flight before either has answered.
    expect(gated.started).toEqual(['meta', 'stream']);
    const stream = Readable.from(['x']);
    gated.releaseStream(stream);
    gated.releaseMeta({ contentLength: 1, contentType: 'text/plain' });
    const result = await pending;
    expect(result.metadata).toEqual({ contentLength: 1, contentType: 'text/plain' });
    expect(result.stream).toBe(stream);
  });

  it('a metadata failure wins and the opened stream is destroyed', async () => {
    const gated = gatedDisk();
    const pending = openWithMetadata(gated.disk, 'k');
    const stream = new PassThrough();
    gated.releaseStream(stream);
    gated.releaseMeta(new Error('meta boom'));
    await expect(pending).rejects.toThrow('meta boom');
    expect(stream.destroyed).toBe(true);
  });

  it('metadata failure still wins when both fail', async () => {
    const gated = gatedDisk();
    const pending = openWithMetadata(gated.disk, 'k');
    gated.releaseStream(new Error('stream boom'));
    gated.releaseMeta(new Error('meta boom'));
    await expect(pending).rejects.toThrow('meta boom');
  });

  it('a stream failure is thrown when the metadata succeeded', async () => {
    const gated = gatedDisk();
    const pending = openWithMetadata(gated.disk, 'k');
    gated.releaseMeta({ contentLength: 1 });
    gated.releaseStream(new Error('stream boom'));
    await expect(pending).rejects.toThrow('stream boom');
  });
});

const owner: MediaSubject = { id: '7' };

async function setup() {
  const disk = new CountingDisk();
  const store = new CountingStore();
  const library = new MediaLibrary({
    storage: new StorageManager({ default: 'fs', resolve: () => disk }),
    store,
    collections: [
      {
        name: 'banner',
        access: { read: authorizers.owner() },
        conversions: [{ name: 'thumb', width: 64 }],
      },
    ],
    imageProcessor: new FakeImageProcessor(),
    idGenerator: () => 'img-1',
    emitDiagnostics: false,
    deliveryMode: 'proxy',
  });
  await library.attach({
    ownerType: 'User',
    ownerId: '7',
    collection: 'banner',
    fileName: 'b.png',
    mimeType: 'image/png',
    contents: Buffer.from('png'),
  });
  const access = new MediaAccess({
    library,
    identity: (ctx) => (ctx as { user: MediaSubject }).user,
  });
  store.reset();
  return { library, store, access };
}

function fakeHttp(query: Record<string, string> = {}) {
  const sent: { status?: number; json?: unknown; stream?: Readable } = {};
  const ctx = {
    user: owner,
    params: { id: 'img-1' },
    request: { qs: () => query, header: () => undefined },
    response: {
      status(code: number) {
        sent.status = code;
        return { json: (body: unknown) => (sent.json = body) };
      },
      header() {},
      redirect() {},
      stream(stream: Readable) {
        sent.stream = stream;
      },
    },
  };
  return { ctx, sent };
}

describe('delivery — the record is looked up once per request', () => {
  it('deliver() with ?w=: one find (resize + target share the record)', async () => {
    const { library, store } = await setup();
    const result = await library.deliver('img-1', { width: 640 });
    expect(result.kind).toBe('stream');
    // The first request generates the size: one read-before-save inside the conversion write.
    const firstFinds = store.calls.find;
    store.reset();
    await library.deliver('img-1', { width: 640 });
    expect(store.calls.find).toBe(1);
    expect(firstFinds).toBe(2);
  });

  it('deliver() still validates the size before looking the record up', async () => {
    const { library } = await setup();
    await expect(library.deliver('missing', { width: 641 })).rejects.toBeInstanceOf(
      ImageSizeNotAllowedError,
    );
    await expect(library.deliver('missing', { width: 640 })).rejects.toBeInstanceOf(
      MediaNotFoundError,
    );
  });

  it('access.serve() by id: one find, original and resized', async () => {
    const { access, store } = await setup();
    const plain = fakeHttp();
    await access.deliveryRoute()(plain.ctx);
    expect(plain.sent.stream).toBeDefined();
    expect(store.calls.find).toBe(1);

    await access.deliveryRoute()(fakeHttp({ w: '640' }).ctx); // generate the size once
    store.reset();
    const resized = fakeHttp({ w: '640' });
    await access.deliveryRoute()(resized.ctx);
    expect(resized.sent.stream).toBeDefined();
    expect(store.calls.find).toBe(1);
  });

  it('access.image() / access.stream(): one find', async () => {
    const { access, store } = await setup();
    const image = await access.image({ user: owner }, 'img-1');
    expect(image.src).toBeTruthy();
    expect(store.calls.find).toBe(1);

    store.reset();
    // No streamable conversion: still refused, after a single lookup.
    await expect(access.stream({ user: owner }, 'img-1')).rejects.toThrow();
    expect(store.calls.find).toBe(1);
  });
});
