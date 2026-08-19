import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectUploadManager, MIN_DIRECT_PART_SIZE } from '../src/direct_upload.js';
import {
  DirectUploadHandler,
  type DirectUploadHandlerOptions,
} from '../src/direct_upload_handler.js';
import {
  DirectUploadsNotConfiguredError,
  MimeNotAllowedError,
  UploadPartOutOfRangeError,
  UploadPartSizeError,
  UploadPartsIncompleteError,
  UploadSessionExpiredError,
  UploadSessionNotFoundError,
} from '../src/errors.js';
import { MediaCollectionRegistry } from '../src/media_collection.js';
import { MediaManager } from '../src/media_manager.js';
import { StorageManager } from '../src/storage_manager.js';
import { FakeTransformer } from '../src/testing/fake_transformer.js';
import { InMemoryDisk } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import { InMemoryUploadSessionStore } from '../src/testing/in_memory_upload_session_store.js';
import type {
  DirectUploadPolicy,
  DiskWriteOptions,
  MultipartPart,
  MultipartUploadDisk,
} from '../src/types.js';
import { FakeMultipartDisk } from './fake_multipart_disk.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
const TRACE_SLOT = Symbol.for('@agora/diagnostics:trace');

/** 5 MiB — the smallest partSize S3 (and the manager) accepts, keeps test arithmetic readable. */
const PART = MIN_DIRECT_PART_SIZE;

const storageOf = (disk: FakeMultipartDisk, name = 's3') =>
  new StorageManager({ default: name, resolve: () => disk });

let disk: FakeMultipartDisk;
let sessions: InMemoryUploadSessionStore;
let events: Array<{ event: string; payload: Record<string, unknown> }>;

const makeManager = (
  overrides: Partial<ConstructorParameters<typeof DirectUploadManager>[0]> = {},
) =>
  new DirectUploadManager({
    storage: storageOf(disk),
    sessions,
    idGenerator: () => 'd-1',
    ...overrides,
  });

beforeEach(() => {
  disk = new FakeMultipartDisk();
  sessions = new InMemoryUploadSessionStore();
  events = [];
  (globalThis as Record<symbol, unknown>)[EMIT_SLOT] = (
    _lib: string,
    event: string,
    payload: unknown,
  ) => {
    events.push({ event, payload: payload as Record<string, unknown> });
  };
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
});

describe('DirectUploadManager — initiate', () => {
  it('defaults to a 20 MiB part size', async () => {
    const created = await makeManager().initiate({
      key: 'uploads/v/original.mp4',
      contentType: 'video/mp4',
      size: 30 * 1024 * 1024,
    });
    expect(created).toMatchObject({
      id: 'd-1',
      key: 'uploads/v/original.mp4',
      disk: 's3',
      partSize: 20 * 1024 * 1024,
      totalParts: 2,
    });
  });

  it('slices by the agreed partSize and hands back one URL per part, in order', async () => {
    const manager = makeManager();
    const created = await manager.initiate({
      key: 'k.bin',
      size: PART * 2 + 1,
      partSize: PART,
    });

    expect(created.partSize).toBe(PART);
    expect(created.totalParts).toBe(3);
    expect(created.parts.map((part) => part.partNumber)).toEqual([1, 2, 3]);
    expect(created.parts.every((part) => part.url.includes('uploadId=mp-1'))).toBe(true);

    // ContentType reached CreateMultipartUpload; the session is persisted with the native id.
    expect(disk.created).toEqual([{ key: 'k.bin', options: undefined }]);
    const stored = await sessions.get('d-1');
    expect(stored).toMatchObject({ id: 'd-1', key: 'k.bin', multipartUploadId: 'mp-1' });
    expect(stored?.metadata?.['direct:partSize']).toBe(String(PART));

    expect(events.map((e) => e.event)).toEqual(['upload.start']);
    expect(events[0]?.payload).toMatchObject({ id: 'd-1', mode: 'direct', size: PART * 2 + 1 });
  });

  it('stamps contentType and visibility on the native upload', async () => {
    await makeManager().initiate({
      key: 'k.mp4',
      size: 1,
      contentType: 'video/mp4',
      visibility: 'public',
    });
    expect(disk.created[0]?.options).toEqual({ contentType: 'video/mp4', visibility: 'public' });
  });

  it('rejects a partSize below the S3 minimum before anything is created', async () => {
    await expect(
      makeManager().initiate({ key: 'k', size: 100, partSize: PART - 1 }),
    ).rejects.toBeInstanceOf(UploadPartSizeError);
    expect(disk.created).toHaveLength(0);
    expect(await sessions.get('d-1')).toBeNull();
  });

  it('rejects a size/partSize combination that would exceed the 10,000-part cap', async () => {
    await expect(
      makeManager().initiate({ key: 'k', size: PART * 10_001, partSize: PART }),
    ).rejects.toBeInstanceOf(UploadPartSizeError);
    expect(disk.created).toHaveLength(0);
  });

  it('rejects a non-positive size', async () => {
    await expect(makeManager().initiate({ key: 'k', size: 0 })).rejects.toBeInstanceOf(RangeError);
  });

  it("enforces the collection's declared-type whitelist before a single byte moves", async () => {
    const collections = new MediaCollectionRegistry([
      { name: 'video', acceptsMimeTypes: ['video/mp4'] },
    ]);
    const manager = makeManager({ collections });

    await expect(
      manager.initiate({ key: 'k', size: 1, collection: 'video', contentType: 'image/png' }),
    ).rejects.toBeInstanceOf(MimeNotAllowedError);
    expect(disk.created).toHaveLength(0);
    expect(await sessions.get('d-1')).toBeNull();

    // A whitelisted declaration passes; an absent one defers to attach-time validation.
    await manager.initiate({ key: 'a', size: 1, collection: 'video', contentType: 'video/mp4' });
    await makeManager({
      collections,
      idGenerator: () => 'd-2',
    }).initiate({ key: 'b', size: 1, collection: 'video' });
    expect(disk.created).toHaveLength(2);
  });
});

describe('DirectUploadManager — resume after client state loss', () => {
  it('initiate → confirm one part → a FRESH manager (new process) serves status with the rest', async () => {
    const first = makeManager();
    const created = await first.initiate({ key: 'k.bin', size: PART * 3, partSize: PART });
    expect(created.totalParts).toBe(3);

    const progress = await first.confirmPart('d-1', { partNumber: 2, etag: '"abc"' });
    expect(progress).toEqual({ offset: PART, completedParts: 1 });

    // Page reload: a brand-new manager instance over the same persisted store.
    const second = makeManager({ idGenerator: () => 'unused' });
    const status = await second.status('d-1');

    expect(status.completedParts).toEqual([{ partNumber: 2, etag: '"abc"' }]);
    expect(status.pendingParts.map((part) => part.partNumber)).toEqual([1, 3]);
    expect(status.partSize).toBe(PART);
    expect(status.totalParts).toBe(3);
    expect(status.size).toBe(PART * 3);
    // Pending URLs are freshly presigned, not replayed from initiate.
    const initiateUrls = new Set(created.parts.map((part) => part.url));
    for (const pending of status.pendingParts) expect(initiateUrls.has(pending.url)).toBe(false);
  });

  it('re-confirming a part overwrites its ETag instead of duplicating it', async () => {
    const manager = makeManager();
    await manager.initiate({ key: 'k', size: PART, partSize: PART });
    await manager.confirmPart('d-1', { partNumber: 1, etag: '"first"' });
    await manager.confirmPart('d-1', { partNumber: 1, etag: '"retry"' });
    const status = await manager.status('d-1');
    expect(status.completedParts).toEqual([{ partNumber: 1, etag: '"retry"' }]);
  });

  it('tracks offset as bytes-safely-on-S3, with the remainder-sized last part', async () => {
    const manager = makeManager();
    await manager.initiate({ key: 'k', size: PART + 5, partSize: PART });
    const afterLast = await manager.confirmPart('d-1', { partNumber: 2, etag: '"e2"' });
    expect(afterLast.offset).toBe(5); // part 2 is the 5-byte remainder
    const afterBoth = await manager.confirmPart('d-1', { partNumber: 1, etag: '"e1"' });
    expect(afterBoth).toEqual({ offset: PART + 5, completedParts: 2 });
    expect(events.map((e) => e.event)).toEqual([
      'upload.start',
      'upload.progress',
      'upload.progress',
    ]);
  });

  it('rejects confirming a part number outside the agreed range', async () => {
    const manager = makeManager();
    await manager.initiate({ key: 'k', size: PART * 2, partSize: PART });
    await expect(manager.confirmPart('d-1', { partNumber: 3, etag: '"x"' })).rejects.toBeInstanceOf(
      UploadPartOutOfRangeError,
    );
    await expect(manager.confirmPart('d-1', { partNumber: 0, etag: '"x"' })).rejects.toBeInstanceOf(
      UploadPartOutOfRangeError,
    );
  });
});

describe('DirectUploadManager — complete / abort / expiry', () => {
  it('merges confirmed and caller-supplied parts, assembles sorted, and closes the session', async () => {
    const manager = makeManager();
    await manager.initiate({ key: 'k.bin', size: PART * 3, partSize: PART });
    await manager.confirmPart('d-1', { partNumber: 2, etag: '"e2"' });

    // The client hands over what it never got to confirm (3) plus a fresher ETag for 1.
    const done = await manager.complete('d-1', [
      { partNumber: 3, etag: '"e3"' },
      { partNumber: 1, etag: '"e1"' },
    ]);

    expect(done).toEqual({ key: 'k.bin', disk: 's3', size: PART * 3 });
    expect(disk.completed).toHaveLength(1);
    expect(disk.completed[0]?.parts).toEqual([
      { partNumber: 1, etag: '"e1"' },
      { partNumber: 2, etag: '"e2"' },
      { partNumber: 3, etag: '"e3"' },
    ]);
    await expect(manager.status('d-1')).rejects.toBeInstanceOf(UploadSessionNotFoundError);
    expect(events.map((e) => e.event)).toEqual([
      'upload.start',
      'upload.progress',
      'upload.complete',
    ]);
  });

  it('a caller-supplied ETag wins over a stale confirmed one for the same part', async () => {
    const manager = makeManager();
    await manager.initiate({ key: 'k', size: PART, partSize: PART });
    await manager.confirmPart('d-1', { partNumber: 1, etag: '"stale"' });
    await manager.complete('d-1', [{ partNumber: 1, etag: '"fresh"' }]);
    expect(disk.completed[0]?.parts).toEqual([{ partNumber: 1, etag: '"fresh"' }]);
  });

  it('names the exact missing parts and keeps the session alive instead of letting S3 fail opaquely', async () => {
    const manager = makeManager();
    await manager.initiate({ key: 'k', size: PART * 3, partSize: PART });
    await manager.confirmPart('d-1', { partNumber: 2, etag: '"e2"' });

    const failure = await manager.complete('d-1').catch((err) => err);
    expect(failure).toBeInstanceOf(UploadPartsIncompleteError);
    expect((failure as UploadPartsIncompleteError).missingParts).toEqual([1, 3]);
    expect(disk.completed).toHaveLength(0);
    // The session survives: the client can upload the gaps and retry.
    expect((await manager.status('d-1')).pendingParts.map((p) => p.partNumber)).toEqual([1, 3]);
  });

  it('abort frees the native upload and drops the session', async () => {
    const manager = makeManager();
    await manager.initiate({ key: 'k', size: PART, partSize: PART });
    await manager.abort('d-1');
    expect(disk.aborted).toEqual([{ key: 'k', uploadId: 'mp-1' }]);
    expect(await sessions.get('d-1')).toBeNull();
    expect(events.at(-1)?.event).toBe('upload.abort');
  });

  it('abort still drops the session when S3 already reaped the upload (best-effort abort)', async () => {
    const manager = makeManager();
    await manager.initiate({ key: 'k', size: PART, partSize: PART });
    disk.abortFails = true;
    await manager.abort('d-1');
    expect(await sessions.get('d-1')).toBeNull();
  });

  it('abort of an unknown session is a no-op', async () => {
    await makeManager().abort('nope');
    expect(disk.aborted).toHaveLength(0);
  });

  it('an expired session is reaped on access: native upload aborted, record gone, 410-mappable error', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:00Z');
    const manager = makeManager({
      sessionTtlSeconds: 60,
      clock: () => new Date(nowMs),
    });
    await manager.initiate({ key: 'k', size: PART, partSize: PART });

    nowMs += 61_000;
    await expect(manager.status('d-1')).rejects.toBeInstanceOf(UploadSessionExpiredError);
    expect(disk.aborted).toEqual([{ key: 'k', uploadId: 'mp-1' }]);
    expect(await sessions.get('d-1')).toBeNull();
  });

  it('never mistakes a TUS session in a shared store for a direct one', async () => {
    // A resumable (TUS) session: no direct part-size marker.
    await sessions.create({
      id: 'tus-1',
      disk: 's3',
      key: 'k',
      contentType: undefined,
      size: 10,
      offset: 0,
      parts: 0,
      multipartUploadId: 'mp-9',
    });
    const manager = makeManager();
    await expect(manager.status('tus-1')).rejects.toBeInstanceOf(UploadSessionNotFoundError);
    await expect(
      manager.confirmPart('tus-1', { partNumber: 1, etag: '"e"' }),
    ).rejects.toBeInstanceOf(UploadSessionNotFoundError);
    // ...and list() filters them out.
    await manager.initiate({ key: 'k2', size: PART, partSize: PART });
    expect((await manager.list()).map((s) => s.id)).toEqual(['d-1']);
  });
});

describe('DirectUploadHandler', () => {
  const makeHandler = (
    overrides: Partial<ConstructorParameters<typeof DirectUploadHandler>[0]> = {},
    managerOverrides: Partial<ConstructorParameters<typeof DirectUploadManager>[0]> = {},
  ) =>
    new DirectUploadHandler({
      manager: makeManager({
        collections: new MediaCollectionRegistry([
          { name: 'video', acceptsMimeTypes: ['video/mp4'] },
        ]),
        ...managerOverrides,
      }),
      idGenerator: () => 'tok',
      ...overrides,
    });

  it('initiate: 201 with a server-side key (the client names a file, never a key)', async () => {
    const res = await makeHandler().handle({
      action: 'initiate',
      fileName: 'movie.mp4',
      size: PART,
      contentType: 'video/mp4',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 'd-1',
      key: 'uploads/tok/movie.mp4',
      disk: 's3',
      totalParts: 1,
    });
    expect((res.body as { parts: unknown[] }).parts).toHaveLength(1);
  });

  it('initiate: 415 when the declared type is outside the collection whitelist', async () => {
    const res = await makeHandler({ collection: 'video' }).handle({
      action: 'initiate',
      fileName: 'sneaky.png',
      size: PART,
      contentType: 'image/png',
    });
    expect(res.status).toBe(415);
    expect(res.body).toMatchObject({ code: 'E_MEDIA_MIME_NOT_ALLOWED' });
  });

  it('initiate: 413 over maxSize, 400 on malformed input', async () => {
    const handler = makeHandler({ maxSize: 10 });
    expect((await handler.handle({ action: 'initiate', fileName: 'f', size: 11 })).status).toBe(
      413,
    );
    expect((await handler.handle({ action: 'initiate', fileName: '', size: 5 })).status).toBe(400);
    expect((await handler.handle({ action: 'initiate', fileName: 'f', size: 1.5 })).status).toBe(
      400,
    );
  });

  it('status: 200 for a live session, 404 for an unknown one, 410 once expired', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:00Z');
    const handler = makeHandler({}, { sessionTtlSeconds: 60, clock: () => new Date(nowMs) });
    await handler.handle({ action: 'initiate', fileName: 'f.mp4', size: PART * 2 });

    const ok = await handler.handle({ action: 'status', uploadId: 'd-1' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: 'd-1', totalParts: 1 });
    expect((ok.body as { expiresAt: string }).expiresAt).toBe('2026-01-01T00:01:00.000Z');

    expect((await handler.handle({ action: 'status', uploadId: 'nope' })).status).toBe(404);
    nowMs += 61_000;
    expect((await handler.handle({ action: 'status', uploadId: 'd-1' })).status).toBe(410);
  });

  it('confirm-part: 200 with progress; 400 for a part outside the range or a missing etag', async () => {
    const handler = makeHandler();
    await handler.handle({ action: 'initiate', fileName: 'f', size: PART * 2 });

    const ok = await handler.handle({
      action: 'confirm-part',
      uploadId: 'd-1',
      partNumber: 1,
      etag: '"e1"',
    });
    expect(ok).toMatchObject({ status: 200, body: { completedParts: 1 } });

    expect(
      (
        await handler.handle({
          action: 'confirm-part',
          uploadId: 'd-1',
          partNumber: 99,
          etag: '"e"',
        })
      ).status,
    ).toBe(400);
    expect(
      (await handler.handle({ action: 'confirm-part', uploadId: 'd-1', partNumber: 1, etag: '' }))
        .status,
    ).toBe(400);
  });

  it('complete: 200 when whole, 409 naming the gaps when not', async () => {
    const handler = makeHandler();
    await handler.handle({
      action: 'initiate',
      fileName: 'f',
      size: PART * 2,
      contentType: undefined,
    });

    const premature = await handler.handle({ action: 'complete', uploadId: 'd-1' });
    expect(premature.status).toBe(409);
    expect(premature.body).toMatchObject({ missingParts: [1] });

    const done = await handler.handle({
      action: 'complete',
      uploadId: 'd-1',
      parts: [{ partNumber: 1, etag: '"e1"' }],
    });
    expect(done).toMatchObject({ status: 200, body: { key: 'uploads/tok/f', disk: 's3' } });
  });

  it('abort: 204, idempotently', async () => {
    const handler = makeHandler();
    await handler.handle({ action: 'initiate', fileName: 'f', size: PART });
    expect((await handler.handle({ action: 'abort', uploadId: 'd-1' })).status).toBe(204);
    expect((await handler.handle({ action: 'abort', uploadId: 'd-1' })).status).toBe(204);
  });
});

describe('MediaManager — session-backed direct uploads end to end', () => {
  const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

  const makeMedia = () =>
    new MediaManager({
      defaultDisk: 's3',
      resolve: () => disk,
      store: new InMemoryMediaStore(),
      collections: [{ name: 'scans', acceptsMimeTypes: ['image/png'] }],
      directUploadSessions: sessions,
      directPartSize: PART,
      emitDiagnostics: false,
    });

  it('media.direct throws a pointed error until a session store is configured', () => {
    const media = new MediaManager({
      defaultDisk: 's3',
      resolve: () => disk,
      store: new InMemoryMediaStore(),
    });
    expect(media.hasDirect).toBe(false);
    expect(() => media.direct).toThrow(DirectUploadsNotConfiguredError);
  });

  it('completeDirectUploadToLibrary assembles the parts and adopts the object via attachExisting', async () => {
    const media = makeMedia();
    expect(media.hasDirect).toBe(true);

    const created = await media.direct.initiate({
      key: 'uploads/s/scan.png',
      contentType: 'image/png',
      size: PNG_HEAD.byteLength,
      collection: 'scans',
    });
    // The "browser" PUTs the bytes straight to storage and confirms the part.
    disk.stagePart('mp-1', 1, PNG_HEAD);
    await media.direct.confirmPart(created.id, { partNumber: 1, etag: '"e1"' });

    const record = await media.completeDirectUploadToLibrary(created.id, {
      ownerType: 'Doc',
      ownerId: '7',
      collection: 'scans',
      fileName: 'scan.png',
      mimeType: 'image/png',
    });

    expect(record).toMatchObject({
      ownerType: 'Doc',
      ownerId: '7',
      collection: 'scans',
      path: 'uploads/s/scan.png',
      disk: 's3',
      size: PNG_HEAD.byteLength,
    });
    // Zero-copy adoption: the object is where the browser put it, now readable through the library.
    expect(await disk.exists('uploads/s/scan.png')).toBe(true);
  });

  it("the collection's whitelist checks the REAL bytes at completion — a liar is caught here", async () => {
    const media = makeMedia();
    const created = await media.direct.initiate({
      key: 'uploads/s/fake.png',
      contentType: 'image/png', // declared PNG...
      size: 4,
      collection: 'scans',
    });
    disk.stagePart('mp-1', 1, Buffer.from('%PDF')); // ...actually a PDF signature
    await media.direct.confirmPart(created.id, { partNumber: 1, etag: '"e1"' });

    await expect(
      media.completeDirectUploadToLibrary(created.id, {
        ownerType: 'Doc',
        ownerId: '7',
        collection: 'scans',
        fileName: 'fake.png',
        mimeType: 'image/png',
      }),
    ).rejects.toMatchObject({ code: 'E_MEDIA_CONTENT_TYPE_MISMATCH' });
  });

  it('the initiate MIME gate reads the SAME collection registry attach uses', async () => {
    const media = makeMedia();
    await expect(
      media.direct.initiate({
        key: 'k',
        size: 1,
        collection: 'scans',
        contentType: 'application/pdf',
      }),
    ).rejects.toBeInstanceOf(MimeNotAllowedError);
  });
});

/**
 * Cross-feature guarantee, pinned: the direct-upload finalize adopts the object through
 * `attachExisting`, which is the SAME commit path attach and the TUS finalize funnel through — so
 * eager transformers run on a browser→S3 direct upload with zero extra wiring, and deferred ones
 * wait for the app's `transform()` job exactly as everywhere else. If either side ever stops
 * funneling through that commit, this is the test that goes red.
 */
describe('direct uploads × transformers — the finalize hook', () => {
  it('runs eager transformers inside completeDirectUploadToLibrary and leaves deferred ones for transform()', async () => {
    const eager = new FakeTransformer({
      name: 'probe',
      eager: true,
      entry: null,
      meta: { probed: true },
    });
    const deferred = new FakeTransformer({ name: 'hls', artifacts: { 'index.m3u8': '#EXTM3U' } });
    const media = new MediaManager({
      defaultDisk: 's3',
      resolve: () => disk,
      store: new InMemoryMediaStore(),
      collections: [{ name: 'videos', transformers: [eager, deferred] }],
      directUploadSessions: sessions,
      directPartSize: PART,
      emitDiagnostics: false,
    });

    const bytes = Buffer.from('fake-video-bytes');
    const created = await media.direct.initiate({
      key: 'uploads/v/lesson.mp4',
      contentType: 'video/mp4',
      size: bytes.byteLength,
      collection: 'videos',
    });
    disk.stagePart('mp-1', 1, bytes);
    await media.direct.confirmPart(created.id, { partNumber: 1, etag: '"e1"' });

    const record = await media.completeDirectUploadToLibrary(created.id, {
      ownerType: 'Lesson',
      ownerId: '1',
      collection: 'videos',
      fileName: 'lesson.mp4',
      mimeType: 'video/mp4',
    });

    // The eager transformer ran inside the finalize, against the object the browser uploaded —
    // read in place (zero-copy adoption), never round-tripped through the app.
    expect(record.conversions.probe).toEqual({ meta: { probed: true } });
    expect(eager.calls).toHaveLength(1);
    expect(Buffer.from(await eager.calls[0]!.getBytes())).toEqual(bytes);

    // The deferred one is untouched by the finalize and generated by the app's job later.
    expect(record.conversions.hls).toBeUndefined();
    expect(deferred.calls).toHaveLength(0);
    const after = await media.library.transform(record.id, 'hls');
    expect(after.conversions.hls?.path).toBe('uploads/v/conversions/hls/index.m3u8');
  });
});

describe('DirectUploadPolicy', () => {
  // A policy requires an `adopt` (the handler enforces it), so the harness wires a no-op stub unless
  // the test supplies its own mock to assert against.
  const makeHandler = (policy: DirectUploadPolicy<unknown, unknown> | undefined, adopt?: unknown) =>
    new DirectUploadHandler({
      manager: makeManager({
        collections: new MediaCollectionRegistry([
          { name: 'scans', acceptsMimeTypes: ['image/png'] },
        ]),
      }),
      idGenerator: () => 'tok',
      ...(policy !== undefined ? { policy } : {}),
      ...(policy !== undefined
        ? {
            adopt: (adopt ??
              (async () => ({ id: 'adopted' }))) as DirectUploadHandlerOptions['adopt'],
          }
        : {}),
    });

  const target = {
    ownerType: 'Doc',
    ownerId: '7',
    collection: 'scans',
    fileName: 'scan.png',
    mimeType: 'image/png',
  };

  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[TRACE_SLOT];
  });

  it('initiate: onInitiate decides key/collection/metadata/response; 201 merges session + response; onInitiated sees {decision, session}', async () => {
    const onInitiated = vi.fn();
    const policy: DirectUploadPolicy<unknown, unknown> = {
      onInitiate: () => ({
        key: 'tenant/42/scan.png',
        collection: 'scans',
        metadata: { purpose: 'scan' },
        response: { policyApplied: true },
      }),
      onInitiated,
      resolveComplete: () => ({ sessionId: 'd-1', target }),
      onComplete: () => ({}),
    };
    const res = await makeHandler(policy).handle(
      { action: 'initiate', fileName: 'scan.png', size: PART, contentType: 'image/png' },
      { user: 'u1' },
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'd-1', key: 'tenant/42/scan.png', policyApplied: true });
    expect(disk.created[0]?.key).toBe('tenant/42/scan.png');
    expect((await sessions.get('d-1'))?.metadata?.purpose).toBe('scan');
    expect(onInitiated).toHaveBeenCalledTimes(1);
    expect(onInitiated.mock.calls[0]?.[0]).toEqual({ user: 'u1' });
    expect(onInitiated.mock.calls[0]?.[1]).toMatchObject({
      decision: { key: 'tenant/42/scan.png' },
      session: { id: 'd-1', key: 'tenant/42/scan.png' },
    });
  });

  it("complete: resolveComplete → adopt(sessionId, target, parts) → onComplete; 200 body is onComplete's return", async () => {
    const fakeRecord = { id: 'rec-1', ownerType: 'Doc', ownerId: '7' };
    const adopt = vi.fn(async () => fakeRecord);
    const onComplete = vi.fn(() => ({ adopted: true, id: 'rec-1' }));
    const policy: DirectUploadPolicy<unknown, unknown> = {
      onInitiate: () => ({ key: 'x' }),
      resolveComplete: () => ({ sessionId: 'sess-9', target }),
      onComplete,
    };
    const parts = [{ partNumber: 1, etag: '"e1"' }];
    const res = await makeHandler(policy, adopt).handle(
      { action: 'complete', uploadId: 'sess-9', parts },
      { user: 'u1' },
    );
    expect(res.status).toBe(200);
    expect(adopt).toHaveBeenCalledTimes(1);
    expect(adopt.mock.calls[0]?.[0]).toBe('sess-9');
    expect(adopt.mock.calls[0]?.[1]).toMatchObject({
      ownerType: 'Doc',
      ownerId: '7',
      collection: 'scans',
    });
    expect(adopt.mock.calls[0]?.[2]).toEqual(parts);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0]?.[1]).toMatchObject({
      record: fakeRecord,
      resolution: { sessionId: 'sess-9' },
    });
    expect(res.body).toEqual({ adopted: true, id: 'rec-1' });
  });

  it('initiate: mapError (phase initiate) maps a MIME rejection and rollback runs', async () => {
    const rollback = vi.fn();
    const mapError = vi.fn(() => ({ status: 422, body: { error: 'mime rejected by policy' } }));
    const policy: DirectUploadPolicy<unknown, unknown> = {
      onInitiate: () => ({ key: 'tenant/42/scan.jpg', collection: 'scans', rollback }),
      resolveComplete: () => ({ sessionId: 'd-1', target }),
      onComplete: () => ({}),
      mapError,
    };
    const res = await makeHandler(policy).handle(
      { action: 'initiate', fileName: 'scan.jpg', size: PART, contentType: 'image/jpeg' },
      { user: 'u1' },
    );
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'mime rejected by policy' });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(mapError).toHaveBeenCalledTimes(1);
    expect(mapError.mock.calls[0]?.[0]).toEqual({ user: 'u1' });
    expect(mapError.mock.calls[0]?.[1]).toBeInstanceOf(MimeNotAllowedError);
    expect(mapError.mock.calls[0]?.[2]).toMatchObject({
      phase: 'initiate',
      decision: { key: 'tenant/42/scan.jpg' },
    });
  });

  it('initiate: when mapError returns undefined, the default mapping applies (415 for MIME)', async () => {
    const policy: DirectUploadPolicy<unknown, unknown> = {
      onInitiate: () => ({ key: 'tenant/42/scan.jpg', collection: 'scans' }),
      resolveComplete: () => ({ sessionId: 'd-1', target }),
      onComplete: () => ({}),
      mapError: () => undefined,
    };
    const res = await makeHandler(policy).handle(
      { action: 'initiate', fileName: 'scan.jpg', size: PART, contentType: 'image/jpeg' },
      { user: 'u1' },
    );
    expect(res.status).toBe(415);
  });

  it('complete: mapError (phase complete) maps an adopt failure; resolution is in the info', async () => {
    const adopt = vi.fn(async () => {
      throw new UploadPartsIncompleteError('sess-9', [2]);
    });
    const mapError = vi.fn(() => ({
      status: 409,
      body: { error: 'incomplete', missingParts: [2] },
    }));
    const policy: DirectUploadPolicy<unknown, unknown> = {
      onInitiate: () => ({ key: 'x' }),
      resolveComplete: () => ({ sessionId: 'sess-9', target }),
      onComplete: () => ({}),
      mapError,
    };
    const res = await makeHandler(policy, adopt).handle(
      { action: 'complete', uploadId: 'sess-9', parts: [{ partNumber: 1, etag: '"e1"' }] },
      { user: 'u1' },
    );
    expect(res.status).toBe(409);
    expect(mapError).toHaveBeenCalledTimes(1);
    expect(mapError.mock.calls[0]?.[1]).toBeInstanceOf(UploadPartsIncompleteError);
    expect(mapError.mock.calls[0]?.[2]).toMatchObject({
      phase: 'complete',
      resolution: { sessionId: 'sess-9' },
    });
  });

  it('abort: onAbort is called and the session is dropped', async () => {
    const onAbort = vi.fn();
    const policy: DirectUploadPolicy<unknown, unknown> = {
      onInitiate: () => ({ key: 'tenant/42/scan.png', collection: 'scans' }),
      resolveComplete: () => ({ sessionId: 'd-1', target }),
      onComplete: () => ({}),
      onAbort,
    };
    const handler = makeHandler(policy);
    await handler.handle(
      { action: 'initiate', fileName: 'scan.png', size: PART, contentType: 'image/png' },
      { user: 'u1' },
    );
    expect(await sessions.get('d-1')).not.toBeNull();
    const res = await handler.handle({ action: 'abort', uploadId: 'd-1' }, { user: 'u1' });
    expect(res.status).toBe(204);
    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(onAbort.mock.calls[0]?.[0]).toEqual({ user: 'u1' });
    expect(onAbort.mock.calls[0]?.[1]).toEqual({ id: 'd-1' });
    expect(await sessions.get('d-1')).toBeNull();
  });

  it('wraps every policy hook in traceMedia (upload.policy.* events fire through the trace slot)', async () => {
    const traced: string[] = [];
    (globalThis as Record<symbol, unknown>)[TRACE_SLOT] = (
      _lib: string,
      event: string,
      fn: () => unknown,
    ) => {
      traced.push(event);
      return fn();
    };
    const adopt = vi.fn(async () => ({ id: 'rec-1' }));
    const policy: DirectUploadPolicy<unknown, unknown> = {
      onInitiate: () => ({ key: 'tenant/42/scan.png', collection: 'scans' }),
      onInitiated: () => {},
      resolveComplete: () => ({ sessionId: 'sess-9', target }),
      onComplete: () => ({}),
      onAbort: () => {},
    };
    const handler = makeHandler(policy, adopt);
    await handler.handle(
      { action: 'initiate', fileName: 'scan.png', size: PART, contentType: 'image/png' },
      {},
    );
    await handler.handle(
      { action: 'complete', uploadId: 'sess-9', parts: [{ partNumber: 1, etag: '"e1"' }] },
      {},
    );
    await handler.handle({ action: 'abort', uploadId: 'd-1' }, {});
    expect(traced).toEqual(
      expect.arrayContaining([
        'upload.policy.on_initiate',
        'upload.policy.on_initiated',
        'upload.policy.resolve_complete',
        'upload.policy.on_complete',
        'upload.policy.on_abort',
      ]),
    );
  });

  it('constructor: a policy without adopt throws a TypeError mentioning adopt; policy+adopt or neither does not throw', () => {
    const policy: DirectUploadPolicy<unknown, unknown> = {
      onInitiate: () => ({ key: 'x' }),
      resolveComplete: () => ({ sessionId: 'x', target }),
      onComplete: () => ({}),
    };
    const manager = makeManager({
      collections: new MediaCollectionRegistry([
        { name: 'scans', acceptsMimeTypes: ['image/png'] },
      ]),
    });
    expect(() => new DirectUploadHandler({ manager, policy })).toThrowError(TypeError);
    expect(() => new DirectUploadHandler({ manager, policy })).toThrowError(/adopt/);
    expect(
      () =>
        new DirectUploadHandler({
          manager,
          policy,
          adopt: (async () => ({ id: 'r' })) as DirectUploadHandlerOptions['adopt'],
        }),
    ).not.toThrow();
    expect(() => new DirectUploadHandler({ manager })).not.toThrow();
  });

  it('initiate: a throwing rollback does not mask the primary error; mapError still sees the original error', async () => {
    const original = new Error('onInitiated failed');
    const rollback = vi.fn(async () => {
      throw new Error('rollback failed');
    });
    const mapError = vi.fn(() => ({ status: 422, body: { error: 'mapped original' } }));
    const policy: DirectUploadPolicy<unknown, unknown> = {
      onInitiate: () => ({ key: 'tenant/42/scan.png', collection: 'scans', rollback }),
      onInitiated: () => {
        throw original;
      },
      resolveComplete: () => ({ sessionId: 'x', target }),
      onComplete: () => ({}),
      mapError,
    };
    const res = await makeHandler(policy).handle(
      { action: 'initiate', fileName: 'scan.png', size: PART, contentType: 'image/png' },
      { user: 'u1' },
    );
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(mapError).toHaveBeenCalledTimes(1);
    expect(mapError.mock.calls[0]?.[1]).toBe(original);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'mapped original' });
  });

  it('initiate: an error thrown BY onInitiate is mappable (mapError receives decision: undefined)', async () => {
    const sentinel = new Error('not allowed to upload');
    const mapError = vi.fn(() => ({ status: 403, body: { error: 'forbidden by policy' } }));
    const policy: DirectUploadPolicy<unknown, unknown> = {
      onInitiate: () => {
        throw sentinel;
      },
      resolveComplete: () => ({ sessionId: 'x', target }),
      onComplete: () => ({}),
      mapError,
    };
    const res = await makeHandler(policy).handle(
      { action: 'initiate', fileName: 'scan.png', size: PART, contentType: 'image/png' },
      { user: 'u1' },
    );
    expect(mapError).toHaveBeenCalledTimes(1);
    expect(mapError.mock.calls[0]?.[1]).toBe(sentinel);
    const info = mapError.mock.calls[0]?.[2] as { phase: string; decision?: unknown };
    expect(info.phase).toBe('initiate');
    expect(info.decision).toBeUndefined();
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden by policy' });
  });

  it('initiate: an error thrown BY onInitiate with mapError returning undefined falls through to the default mapper', async () => {
    const sentinel = new Error('opaque failure');
    const mapError = vi.fn(() => undefined);
    const policy: DirectUploadPolicy<unknown, unknown> = {
      onInitiate: () => {
        throw sentinel;
      },
      resolveComplete: () => ({ sessionId: 'x', target }),
      onComplete: () => ({}),
      mapError,
    };
    const handler = makeHandler(policy);
    await expect(
      handler.handle(
        { action: 'initiate', fileName: 'scan.png', size: PART, contentType: 'image/png' },
        { user: 'u1' },
      ),
    ).rejects.toBe(sentinel);
    expect(mapError).toHaveBeenCalledTimes(1);
    const info = mapError.mock.calls[0]?.[2] as { phase: string; decision?: unknown };
    expect(info.phase).toBe('initiate');
    expect(info.decision).toBeUndefined();
  });
});
