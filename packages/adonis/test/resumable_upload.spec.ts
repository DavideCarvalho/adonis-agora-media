import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { type AwsClientStub, mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S3Disk } from '../src/disks/s3.js';
import {
  UploadOffsetConflictError,
  UploadSessionExpiredError,
  UploadSessionNotFoundError,
} from '../src/errors.js';
import { ResumableUploadManager } from '../src/resumable_upload.js';
import { StorageManager } from '../src/storage_manager.js';
import { InMemoryDisk } from '../src/testing/in_memory_disk.js';
import { InMemoryUploadSessionStore } from '../src/testing/in_memory_upload_session_store.js';
import { parseTusMetadata, TusUploadHandler } from '../src/tus.js';
import type { Disk } from '../src/types.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');

const storageOf = (disk: Disk, name = 'local') =>
  new StorageManager({ default: name, resolve: () => disk });

let events: Array<{ event: string; payload: Record<string, unknown> }>;

beforeEach(() => {
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

describe('ResumableUploadManager — buffered (non-multipart) disk', () => {
  let disk: InMemoryDisk;
  let manager: ResumableUploadManager;

  beforeEach(() => {
    disk = new InMemoryDisk();
    manager = new ResumableUploadManager({
      storage: storageOf(disk),
      sessions: new InMemoryUploadSessionStore(),
      idGenerator: () => 's-1',
    });
  });

  it('createUpload → writeChunk (sequential) → complete assembles the object', async () => {
    const session = await manager.createUpload({ disk: 'local', key: 'big.bin', size: 5 });
    expect(session.id).toBe('s-1');
    expect(session.offset).toBe(0);

    await manager.writeChunk('s-1', 0, Buffer.from('he'));
    expect((await manager.status('s-1')).offset).toBe(2);
    await manager.writeChunk('s-1', 2, Buffer.from('llo'));

    const done = await manager.complete('s-1');
    expect(done).toEqual({ key: 'big.bin', disk: 'local', size: 5 });
    expect((await disk.getBytes('big.bin')).toString()).toBe('hello');

    // Session is gone + temp parts cleaned up after completion.
    await expect(manager.status('s-1')).rejects.toBeInstanceOf(UploadSessionNotFoundError);
    expect(disk.files.has('.uploads/s-1/0')).toBe(false);
    expect(disk.files.has('.uploads/s-1/1')).toBe(false);

    // Diagnostics: start, two progress, complete.
    expect(events.map((e) => e.event)).toEqual([
      'upload.start',
      'upload.progress',
      'upload.progress',
      'upload.complete',
    ]);
    expect(events[0]?.payload).toMatchObject({ id: 's-1', disk: 'local', key: 'big.bin' });
  });

  it('resumes after a partial upload (offset persists across a fresh manager over the same store)', async () => {
    const sessions = new InMemoryUploadSessionStore();
    const first = new ResumableUploadManager({
      storage: storageOf(disk),
      sessions,
      idGenerator: () => 's-1',
      emitDiagnostics: false,
    });
    await first.createUpload({ disk: 'local', key: 'r.bin', size: 6 });
    await first.writeChunk('s-1', 0, Buffer.from('abc'));

    // A new manager instance (e.g. another process) reads the persisted offset and continues.
    const second = new ResumableUploadManager({
      storage: storageOf(disk),
      sessions,
      emitDiagnostics: false,
    });
    expect((await second.status('s-1')).offset).toBe(3);
    await second.writeChunk('s-1', 3, Buffer.from('def'));
    await second.complete('s-1');
    expect((await disk.getBytes('r.bin')).toString()).toBe('abcdef');
  });

  it('rejects a chunk written at the wrong offset (idempotent resume guard)', async () => {
    await manager.createUpload({ disk: 'local', key: 'c.bin', size: 4 });
    await manager.writeChunk('s-1', 0, Buffer.from('ab'));
    // Replaying offset 0 (stale client) must not corrupt the assembly.
    await expect(manager.writeChunk('s-1', 0, Buffer.from('ab'))).rejects.toBeInstanceOf(
      UploadOffsetConflictError,
    );
    expect((await manager.status('s-1')).offset).toBe(2);
  });

  it('abort discards the session and cleans up temp parts', async () => {
    await manager.createUpload({ disk: 'local', key: 'a.bin', size: 4 });
    await manager.writeChunk('s-1', 0, Buffer.from('ab'));
    await manager.abort('s-1');
    expect(disk.files.has('.uploads/s-1/0')).toBe(false);
    await expect(manager.status('s-1')).rejects.toBeInstanceOf(UploadSessionNotFoundError);
    expect(events.at(-1)?.event).toBe('upload.abort');
    expect(events.at(-1)?.payload).toMatchObject({ id: 's-1', disk: 'local', key: 'a.bin' });
  });

  it('expires a session past its TTL, cleaning up and reporting it as expired', async () => {
    let now = new Date('2026-07-12T00:00:00.000Z');
    const ttlManager = new ResumableUploadManager({
      storage: storageOf(disk),
      sessions: new InMemoryUploadSessionStore(),
      idGenerator: () => 's-ttl',
      sessionTtlSeconds: 60,
      clock: () => now,
      emitDiagnostics: false,
    });
    const session = await ttlManager.createUpload({ disk: 'local', key: 'e.bin', size: 4 });
    expect(session.expiresAt).toEqual(new Date('2026-07-12T00:01:00.000Z'));
    await ttlManager.writeChunk('s-ttl', 0, Buffer.from('ab'));

    // Jump past the TTL — the session is treated as gone.
    now = new Date('2026-07-12T00:02:00.000Z');
    await expect(ttlManager.status('s-ttl')).rejects.toBeInstanceOf(UploadSessionExpiredError);
    // Its temp parts were cleaned up on the expiry sweep.
    expect(disk.files.has('.uploads/s-ttl/0')).toBe(false);
  });
});

describe('ResumableUploadManager — native multipart (mocked S3)', () => {
  let client: S3Client;
  let mock: AwsClientStub<S3Client>;

  beforeEach(() => {
    client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    mock = mockClient(client);
  });

  afterEach(() => mock.restore());

  it('uses S3 multipart: each chunk is a part, complete assembles them sorted', async () => {
    mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'uid-1' });
    mock.on(UploadPartCommand).callsFake((input) => ({ ETag: `etag-${input.PartNumber}` }));
    mock.on(CompleteMultipartUploadCommand).resolves({});

    const disk = new S3Disk({ client, bucket: 'b' });
    const manager = new ResumableUploadManager({
      storage: storageOf(disk),
      sessions: new InMemoryUploadSessionStore(),
      idGenerator: () => 's-mp',
      emitDiagnostics: false,
    });

    const session = await manager.createUpload({ disk: 'local', key: 'video.mp4', size: 6 });
    expect(session.multipartUploadId).toBe('uid-1');

    await manager.writeChunk('s-mp', 0, Buffer.from('foo'));
    await manager.writeChunk('s-mp', 3, Buffer.from('bar'));
    await manager.complete('s-mp');

    // Two parts were uploaded (numbers 1 and 2) and completed against the same UploadId.
    expect(mock.commandCalls(UploadPartCommand)).toHaveLength(2);
    const complete = mock.commandCalls(CompleteMultipartUploadCommand);
    expect(complete).toHaveLength(1);
    expect(complete[0]?.args[0].input).toMatchObject({
      UploadId: 'uid-1',
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: 'etag-1' },
          { PartNumber: 2, ETag: 'etag-2' },
        ],
      },
    });
  });
});

describe('parseTusMetadata', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  it('decodes base64 key/value pairs (and bare keys)', () => {
    expect(parseTusMetadata(`filename ${b64('a.png')},filetype ${b64('image/png')},is_ok`)).toEqual(
      {
        filename: 'a.png',
        filetype: 'image/png',
        is_ok: '',
      },
    );
    expect(parseTusMetadata(undefined)).toEqual({});
  });
});

describe('TusUploadHandler — TUS 1.0.0 protocol', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64');
  let disk: InMemoryDisk;
  let handler: TusUploadHandler;
  let tokens: number;

  beforeEach(() => {
    disk = new InMemoryDisk();
    tokens = 0;
    const manager = new ResumableUploadManager({
      storage: storageOf(disk),
      sessions: new InMemoryUploadSessionStore(),
      idGenerator: () => `s-${++tokens}`,
      emitDiagnostics: false,
    });
    handler = new TusUploadHandler({
      manager,
      disk: 'local',
      basePath: '/media/uploads/tus',
      maxSize: 1000,
      keyFor: (filename) => `up/${filename}`,
      idGenerator: () => 'tok',
    });
  });

  it('OPTIONS advertises version, extensions, and max size', async () => {
    const res = await handler.handle({ method: 'OPTIONS', headers: {} });
    expect(res.status).toBe(204);
    expect(res.headers['Tus-Version']).toBe('1.0.0');
    expect(res.headers['Tus-Extension']).toContain('creation');
    expect(res.headers['Tus-Extension']).toContain('termination');
    expect(res.headers['Tus-Extension']).toContain('expiration');
    expect(res.headers['Tus-Max-Size']).toBe('1000');
  });

  it('POST creates a session and returns its Location + zero offset', async () => {
    const res = await handler.handle({
      method: 'POST',
      headers: { 'upload-length': '5', 'upload-metadata': `filename ${b64('a.png')}` },
    });
    expect(res.status).toBe(201);
    expect(res.headers.Location).toBe('/media/uploads/tus/s-1');
    expect(res.headers['Upload-Offset']).toBe('0');
  });

  it('POST rejects an oversize upload with 413', async () => {
    const res = await handler.handle({ method: 'POST', headers: { 'upload-length': '5000' } });
    expect(res.status).toBe(413);
  });

  it('HEAD reports the current offset + length; 404 when unknown', async () => {
    await handler.handle({ method: 'POST', headers: { 'upload-length': '5' } });
    const head = await handler.handle({ method: 'HEAD', uploadId: 's-1', headers: {} });
    expect(head.status).toBe(200);
    expect(head.headers['Upload-Offset']).toBe('0');
    expect(head.headers['Upload-Length']).toBe('5');
    expect(head.headers['Cache-Control']).toBe('no-store');
    expect((await handler.handle({ method: 'HEAD', uploadId: 'ghost', headers: {} })).status).toBe(
      404,
    );
  });

  it('PATCH appends chunks at the offset and auto-completes at the declared length', async () => {
    await handler.handle({ method: 'POST', headers: { 'upload-length': '5' } });

    const p1 = await handler.handle({
      method: 'PATCH',
      uploadId: 's-1',
      headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': '0' },
      body: Buffer.from('he'),
    });
    expect(p1.status).toBe(204);
    expect(p1.headers['Upload-Offset']).toBe('2');

    const p2 = await handler.handle({
      method: 'PATCH',
      uploadId: 's-1',
      headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': '2' },
      body: Buffer.from('llo'),
    });
    expect(p2.headers['Upload-Offset']).toBe('5');

    // Auto-completed at length 5: the final object exists and the session is gone (HEAD → 404).
    expect((await disk.getBytes('up/upload')).toString()).toBe('hello');
    expect((await handler.handle({ method: 'HEAD', uploadId: 's-1', headers: {} })).status).toBe(
      404,
    );
  });

  it('PATCH with the wrong Content-Type is 415; wrong offset is 409', async () => {
    await handler.handle({ method: 'POST', headers: { 'upload-length': '5' } });
    const bad = await handler.handle({
      method: 'PATCH',
      uploadId: 's-1',
      headers: { 'content-type': 'text/plain', 'upload-offset': '0' },
      body: Buffer.from('he'),
    });
    expect(bad.status).toBe(415);

    const conflict = await handler.handle({
      method: 'PATCH',
      uploadId: 's-1',
      headers: { 'content-type': 'application/offset+octet-stream', 'upload-offset': '3' },
      body: Buffer.from('he'),
    });
    expect(conflict.status).toBe(409);
  });

  it('DELETE terminates the upload (204) and the session is gone', async () => {
    await handler.handle({ method: 'POST', headers: { 'upload-length': '5' } });
    const del = await handler.handle({ method: 'DELETE', uploadId: 's-1', headers: {} });
    expect(del.status).toBe(204);
    expect((await handler.handle({ method: 'HEAD', uploadId: 's-1', headers: {} })).status).toBe(
      404,
    );
  });
});
