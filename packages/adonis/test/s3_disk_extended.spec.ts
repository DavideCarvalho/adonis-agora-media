import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { type AwsClientStub, mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Disk } from '../src/disks/s3.js';
import { isExtendedDisk } from '../src/extended_disk.js';

const makeClient = () =>
  new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

const notFound = (name: string) => Object.assign(new Error(name), { name });

let client: S3Client;
let mock: AwsClientStub<S3Client>;

beforeEach(() => {
  client = makeClient();
  mock = mockClient(client);
});
afterEach(() => {
  mock.restore();
  vi.unstubAllGlobals();
});

describe('S3Disk — ExtendedDisk surface', () => {
  it('is detected structurally by isExtendedDisk and advertises capabilities', () => {
    const d = new S3Disk({ client, bucket: 'b' });
    expect(isExtendedDisk(d)).toBe(true);
    expect(d.capabilities).toEqual({
      presign: true,
      multipart: true,
      publicUrls: true,
      list: true,
    });
  });

  describe('size / stat', () => {
    it('size returns ContentLength', async () => {
      mock.on(HeadObjectCommand).resolves({ ContentLength: 7 });
      expect(await new S3Disk({ client, bucket: 'b' }).size('a')).toBe(7);
    });

    it('size maps NotFound to a not-found error', async () => {
      mock.on(HeadObjectCommand).rejects(notFound('NotFound'));
      await expect(new S3Disk({ client, bucket: 'b' }).size('a')).rejects.toThrow(/file not found/);
    });

    it('stat maps HeadObject fields and applies the key prefix', async () => {
      const lastModified = new Date('2024-05-01T00:00:00.000Z');
      mock.on(HeadObjectCommand).resolves({
        ContentLength: 42,
        ContentType: 'image/png',
        LastModified: lastModified,
      });
      const meta = await new S3Disk({ client, bucket: 'b', keyPrefix: 'up' }).stat('a.png');
      expect(meta).toEqual({ size: 42, contentType: 'image/png', lastModified });
      expect(mock.commandCalls(HeadObjectCommand)[0]?.args[0].input).toMatchObject({
        Bucket: 'b',
        Key: 'up/a.png',
      });
    });

    it('stat maps NotFound to a not-found error', async () => {
      mock.on(HeadObjectCommand).rejects(notFound('NoSuchKey'));
      await expect(new S3Disk({ client, bucket: 'b' }).stat('a')).rejects.toThrow(/file not found/);
    });
  });

  describe('copy / move', () => {
    it('copy sets CopySource to source bucket/key and targets the same bucket', async () => {
      mock.on(CopyObjectCommand).resolves({});
      const d = new S3Disk({ client, bucket: 'b', keyPrefix: 'up' });
      await d.copy('from.txt', 'to.txt');
      expect(mock.commandCalls(CopyObjectCommand)[0]?.args[0].input).toMatchObject({
        Bucket: 'b',
        CopySource: 'b/up/from.txt',
        Key: 'up/to.txt',
      });
    });

    it('copy targets a different bucket when toBucket is set (cross-bucket)', async () => {
      mock.on(CopyObjectCommand).resolves({});
      const d = new S3Disk({ client, bucket: 'src', keyPrefix: 'up' });
      await d.copy('from.txt', 'to.txt', { toBucket: 'dst' });
      expect(mock.commandCalls(CopyObjectCommand)[0]?.args[0].input).toMatchObject({
        Bucket: 'dst',
        CopySource: 'src/up/from.txt',
        Key: 'up/to.txt',
      });
    });

    it('move copies then deletes the source (same bucket)', async () => {
      mock.on(CopyObjectCommand).resolves({});
      mock.on(DeleteObjectCommand).resolves({});
      const d = new S3Disk({ client, bucket: 'b', keyPrefix: 'up' });
      await d.move('from.txt', 'to.txt');
      expect(mock.commandCalls(CopyObjectCommand)[0]?.args[0].input).toMatchObject({
        CopySource: 'b/up/from.txt',
        Key: 'up/to.txt',
      });
      // Source is always deleted from the disk's own bucket.
      expect(mock.commandCalls(DeleteObjectCommand)[0]?.args[0].input).toMatchObject({
        Bucket: 'b',
        Key: 'up/from.txt',
      });
    });

    it('move cross-bucket copies into the target bucket, then deletes the source', async () => {
      mock.on(CopyObjectCommand).resolves({});
      mock.on(DeleteObjectCommand).resolves({});
      const d = new S3Disk({ client, bucket: 'src' });
      await d.move('a.txt', 'a.txt', { toBucket: 'dst' });
      expect(mock.commandCalls(CopyObjectCommand)[0]?.args[0].input).toMatchObject({
        Bucket: 'dst',
        CopySource: 'src/a.txt',
        Key: 'a.txt',
      });
      expect(mock.commandCalls(DeleteObjectCommand)[0]?.args[0].input).toMatchObject({
        Bucket: 'src',
        Key: 'a.txt',
      });
    });
  });

  describe('deleteMany', () => {
    it('is a no-op for an empty array', async () => {
      mock.on(DeleteObjectsCommand).resolves({});
      await new S3Disk({ client, bucket: 'b' }).deleteMany([]);
      expect(mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    });

    it('chunks into batches of 1000 DeleteObjects and prefixes keys', async () => {
      mock.on(DeleteObjectsCommand).resolves({});
      const keys = Array.from({ length: 2500 }, (_, i) => `k/${i}`);
      await new S3Disk({ client, bucket: 'b', keyPrefix: 'up' }).deleteMany(keys);
      const calls = mock.commandCalls(DeleteObjectsCommand);
      expect(calls).toHaveLength(3);
      expect(calls[0]?.args[0].input.Delete?.Objects).toHaveLength(1000);
      expect(calls[1]?.args[0].input.Delete?.Objects).toHaveLength(1000);
      expect(calls[2]?.args[0].input.Delete?.Objects).toHaveLength(500);
      expect(calls[0]?.args[0].input.Delete?.Objects?.[0]).toEqual({ Key: 'up/k/0' });
    });

    it('throws when DeleteObjects reports per-key errors (matches single delete)', async () => {
      mock.on(DeleteObjectsCommand).resolves({ Errors: [{ Key: 'k/0', Code: 'AccessDenied' }] });
      await expect(new S3Disk({ client, bucket: 'b' }).deleteMany(['k/0'])).rejects.toThrow(
        /deleteMany failed for keys: k\/0/,
      );
    });
  });

  describe('list', () => {
    it('returns folders from CommonPrefixes and files from Contents', async () => {
      mock.on(ListObjectsV2Command).resolves({
        CommonPrefixes: [{ Prefix: 'docs/sub/' }],
        Contents: [
          { Key: 'docs/a.txt', Size: 10, LastModified: new Date('2024-01-01') },
          { Key: 'docs/b.txt', Size: 20, LastModified: new Date('2024-01-02') },
        ],
        IsTruncated: false,
      });
      const result = await new S3Disk({ client, bucket: 'b' }).list('docs/', { delimiter: '/' });
      expect(result.folders).toEqual(['docs/sub/']);
      expect(result.files).toHaveLength(2);
      expect(result.files[0]).toMatchObject({ key: 'docs/a.txt', name: 'a.txt', sizeBytes: 10 });
      expect(result.files[1]).toMatchObject({ key: 'docs/b.txt', name: 'b.txt', sizeBytes: 20 });
      expect(result.cursor).toBeUndefined();
    });

    it('passes cursor and limit and returns the next cursor when truncated', async () => {
      mock.on(ListObjectsV2Command).resolves({
        CommonPrefixes: [],
        Contents: [{ Key: 'docs/a.txt', Size: 5, LastModified: new Date() }],
        IsTruncated: true,
        NextContinuationToken: 'tok-next',
      });
      const result = await new S3Disk({ client, bucket: 'b' }).list('docs/', {
        cursor: 'tok-prev',
        limit: 1,
      });
      expect(mock.commandCalls(ListObjectsV2Command)[0]?.args[0].input).toMatchObject({
        ContinuationToken: 'tok-prev',
        MaxKeys: 1,
      });
      expect(result.cursor).toBe('tok-next');
    });

    it('uses the bucket override from options', async () => {
      mock.on(ListObjectsV2Command).resolves({ CommonPrefixes: [], Contents: [], IsTruncated: false });
      await new S3Disk({ client, bucket: 'default-bucket' }).list('docs/', { bucket: 'other-bucket' });
      expect(mock.commandCalls(ListObjectsV2Command)[0]?.args[0].input).toMatchObject({
        Bucket: 'other-bucket',
      });
    });

    it('falls back to a presigned raw GET when fast-xml-parser rejects the XML', async () => {
      mock
        .on(ListObjectsV2Command)
        .rejects(new Error('EntityReplacer: Invalid character in entity name'));
      const xml =
        '<ListBucketResult><CommonPrefixes><Prefix>sub/</Prefix></CommonPrefixes>' +
        '<Contents><Key>sub/f.txt</Key><Size>3</Size><LastModified>2026-01-01T00:00:00.000Z</LastModified></Contents>' +
        '<IsTruncated>false</IsTruncated></ListBucketResult>';
      const fetchMock = vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => xml,
          }) as unknown as Response,
      );
      vi.stubGlobal('fetch', fetchMock);

      const result = await new S3Disk({ client, bucket: 'b' }).list('sub/');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The presigned URL points at the bucket and carries the SigV4 signature.
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('X-Amz-Signature=');
      expect(result.folders).toEqual(['sub/']);
      expect(result.files).toEqual([
        {
          key: 'sub/f.txt',
          name: 'f.txt',
          sizeBytes: 3,
          lastModified: new Date('2026-01-01T00:00:00.000Z'),
        },
      ]);
      expect(result.cursor).toBeUndefined();
    });
  });
});
