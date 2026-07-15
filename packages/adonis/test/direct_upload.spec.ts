import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { type AwsClientStub, mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { S3Disk } from '../src/disks/s3.js';
import { UploadNotSupportedError } from '../src/errors.js';
import { isMultipartCapable } from '../src/multipart.js';
import { StorageManager } from '../src/storage_manager.js';
import { InMemoryDisk } from '../src/testing/in_memory_disk.js';
import type { Disk } from '../src/types.js';
import { UploadManager } from '../src/upload_manager.js';

const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');

const makeClient = () =>
  new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

/** A StorageManager whose only disk (`s3`) is the given one; any name resolves to it. */
const storageOf = (disk: Disk, name = 's3') =>
  new StorageManager({ default: name, resolve: () => disk });

let client: S3Client;
let mock: AwsClientStub<S3Client>;
let events: Array<{ event: string; payload: Record<string, unknown> }>;

beforeEach(() => {
  client = makeClient();
  mock = mockClient(client);
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
  mock.restore();
  delete (globalThis as Record<symbol, unknown>)[EMIT_SLOT];
});

describe('S3Disk multipart capability', () => {
  it('is detected as multipart-capable; the in-memory disk is not', () => {
    expect(isMultipartCapable(new S3Disk({ client, bucket: 'b' }))).toBe(true);
    expect(isMultipartCapable(new InMemoryDisk())).toBe(false);
  });
});

describe('UploadManager — direct mode (mocked S3)', () => {
  let disk: S3Disk;
  let manager: UploadManager;

  beforeEach(() => {
    disk = new S3Disk({ client, bucket: 'b', keyPrefix: 'up' });
    manager = new UploadManager({
      storage: storageOf(disk),
      partSize: 8 * 1024 * 1024,
      presignTtlSeconds: 3600,
    });
  });

  it('initiateDirect with size=20MB/partSize=8MB creates 3 presigned parts and emits upload.start', async () => {
    mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'uid-1' });

    const result = await manager.initiateDirect({
      key: 'video.mp4',
      contentType: 'video/mp4',
      size: 20 * 1024 * 1024,
      partSize: 8 * 1024 * 1024,
    });

    // The multipart upload was created against the prefixed key with the content-type.
    const created = mock.commandCalls(CreateMultipartUploadCommand);
    expect(created).toHaveLength(1);
    expect(created[0]?.args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'up/video.mp4',
      ContentType: 'video/mp4',
    });

    expect(result.uploadId).toBe('uid-1');
    expect(result.disk).toBe('s3');
    expect(result.partSize).toBe(8 * 1024 * 1024);
    expect(result.parts).toHaveLength(3);
    expect(result.parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    // Each part URL is a real presigned S3 UploadPart URL.
    for (const part of result.parts) {
      expect(part.url).toContain('X-Amz-Signature=');
      expect(part.url).toContain(`partNumber=${part.partNumber}`);
      expect(part.url).toContain('uploadId=uid-1');
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('upload.start');
    expect(events[0]?.payload).toMatchObject({
      id: 'uid-1',
      disk: 's3',
      key: 'video.mp4',
      mode: 'direct',
      size: 20 * 1024 * 1024,
      contentType: 'video/mp4',
    });
  });

  it('initiateDirect without size presigns a single part', async () => {
    mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'uid-2' });
    const result = await manager.initiateDirect({ key: 'small.bin' });
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.partNumber).toBe(1);
  });

  it('presignPart returns a presigned URL for the requested part', async () => {
    const { url } = await manager.presignPart({
      key: 'video.mp4',
      uploadId: 'uid-1',
      partNumber: 2,
    });
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('partNumber=2');
    expect(url).toContain('uploadId=uid-1');
  });

  it('completeDirect assembles sorted parts and emits upload.complete', async () => {
    mock.on(CompleteMultipartUploadCommand).resolves({});

    const result = await manager.completeDirect({
      key: 'video.mp4',
      uploadId: 'uid-1',
      // Deliberately out of order — the disk must sort them for S3.
      parts: [
        { partNumber: 2, etag: 'etag-2' },
        { partNumber: 1, etag: 'etag-1' },
      ],
    });

    const calls = mock.commandCalls(CompleteMultipartUploadCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'up/video.mp4',
      UploadId: 'uid-1',
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: 'etag-1' },
          { PartNumber: 2, ETag: 'etag-2' },
        ],
      },
    });
    expect(result).toEqual({ key: 'video.mp4', disk: 's3' });

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('upload.complete');
    expect(events[0]?.payload).toMatchObject({ id: 'uid-1', disk: 's3', key: 'video.mp4' });
  });

  it('abortDirect aborts the upload and emits upload.abort', async () => {
    mock.on(AbortMultipartUploadCommand).resolves({});

    await manager.abortDirect({ key: 'video.mp4', uploadId: 'uid-1' });

    const calls = mock.commandCalls(AbortMultipartUploadCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'up/video.mp4',
      UploadId: 'uid-1',
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('upload.abort');
    expect(events[0]?.payload).toMatchObject({ id: 'uid-1', disk: 's3', key: 'video.mp4' });
  });

  it('end-to-end: create → presign parts → complete', async () => {
    mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'uid-e2e' });
    mock.on(CompleteMultipartUploadCommand).resolves({});

    const created = await manager.initiateDirect({ key: 'movie.mp4', size: 16 * 1024 * 1024 });
    expect(created.parts).toHaveLength(2);

    // The client would PUT to each presigned URL and collect ETags; simulate the ETags here.
    const parts = created.parts.map((p) => ({
      partNumber: p.partNumber,
      etag: `etag-${p.partNumber}`,
    }));
    const done = await manager.completeDirect({
      key: 'movie.mp4',
      uploadId: created.uploadId,
      parts,
    });

    expect(done.key).toBe('movie.mp4');
    expect(mock.commandCalls(CompleteMultipartUploadCommand)[0]?.args[0].input.UploadId).toBe(
      'uid-e2e',
    );
  });
});

describe('UploadManager — mode resolution', () => {
  it('resolves direct for a multipart-capable disk and proxy for one that is not', () => {
    const s3 = new UploadManager({ storage: storageOf(new S3Disk({ client, bucket: 'b' })) });
    expect(s3.resolveMode()).toBe('direct');

    const mem = new UploadManager({ storage: storageOf(new InMemoryDisk()) });
    expect(mem.resolveMode()).toBe('proxy');
  });

  it('forcing direct on a non-multipart disk throws UploadNotSupportedError', async () => {
    const mem = new UploadManager({ storage: storageOf(new InMemoryDisk()) });
    expect(() => mem.resolveMode({ mode: 'direct' })).toThrow(UploadNotSupportedError);
    await expect(mem.initiateDirect({ key: 'x.bin' })).rejects.toBeInstanceOf(
      UploadNotSupportedError,
    );
  });
});

describe('UploadManager — proxy mode', () => {
  it('proxyUpload streams a Readable through the app to the disk', async () => {
    const mem = new InMemoryDisk();
    const manager = new UploadManager({ storage: storageOf(mem) });

    const result = await manager.proxyUpload({
      key: 'notes.txt',
      contents: Readable.from(Buffer.from('hello proxy')),
      contentType: 'text/plain',
    });

    expect(result).toEqual({ key: 'notes.txt', disk: 's3' });
    expect(mem.files.get('notes.txt')?.data.toString()).toBe('hello proxy');
    expect(mem.files.get('notes.txt')?.contentType).toBe('text/plain');
  });

  it('proxyUpload writes a Uint8Array via put', async () => {
    const mem = new InMemoryDisk();
    const manager = new UploadManager({ storage: storageOf(mem) });
    await manager.proxyUpload({ key: 'a.bin', contents: new Uint8Array([1, 2, 3]) });
    expect(Array.from(mem.files.get('a.bin')?.data ?? [])).toEqual([1, 2, 3]);
  });

  it('proxyUploadPart forwards one part server-side and returns its ETag', async () => {
    mock.on(UploadPartCommand).resolves({ ETag: '"part-etag"' });
    const disk = new S3Disk({ client, bucket: 'b' });
    const manager = new UploadManager({ storage: storageOf(disk) });

    const part = await manager.proxyUploadPart({
      key: 'video.mp4',
      uploadId: 'uid-1',
      partNumber: 3,
      body: new Uint8Array([9, 9, 9]),
    });

    expect(part).toEqual({ partNumber: 3, etag: '"part-etag"' });
    const calls = mock.commandCalls(UploadPartCommand);
    expect(calls[0]?.args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'video.mp4',
      UploadId: 'uid-1',
      PartNumber: 3,
    });
  });

  it('proxyUpload falls back to buffering when the disk has no putStream', async () => {
    // A minimal Disk without putStream — proxyUpload must buffer the stream then `put`.
    const stored: { key?: string; bytes?: Uint8Array } = {};
    const bare: Disk = {
      put: async (key, contents) => {
        stored.key = key;
        stored.bytes = contents;
      },
      getBytes: async () => new Uint8Array(),
      getStream: async () => Readable.from(Buffer.alloc(0)),
      exists: async () => false,
      delete: async () => {},
      getUrl: async () => '',
      getSignedUrl: async () => '',
      getMetaData: async () => ({ contentLength: 0 }),
    };
    const manager = new UploadManager({ storage: storageOf(bare) });
    await manager.proxyUpload({ key: 'b.bin', contents: Readable.from(Buffer.from('abc')) });
    expect(stored.key).toBe('b.bin');
    expect(Buffer.from(stored.bytes ?? new Uint8Array()).toString()).toBe('abc');
  });
});
