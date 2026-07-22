import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { sdkStreamMixin } from '@smithy/util-stream';
import { type AwsClientStub, mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { disks } from '../src/disks/factory.js';
import { S3Disk } from '../src/disks/s3.js';

const makeClient = () =>
  new S3Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

const notFound = (name: string) => Object.assign(new Error(name), { name });
const streamOf = (data: string) => sdkStreamMixin(Readable.from(Buffer.from(data)));

let client: S3Client;
let mock: AwsClientStub<S3Client>;

beforeEach(() => {
  client = makeClient();
  mock = mockClient(client);
});
afterEach(() => {
  mock.restore();
});

describe('S3Disk (mocked S3 client)', () => {
  it('applies the key prefix, trimming slashes', () => {
    const d = new S3Disk({ client, bucket: 'b', keyPrefix: '/uploads/' });
    expect(d.key('a/b.png')).toBe('uploads/a/b.png');
    expect(d.key('/a.png')).toBe('uploads/a.png');
    expect(new S3Disk({ client, bucket: 'b' }).key('/a.png')).toBe('a.png');
  });

  it('put issues a PutObjectCommand with the prefixed key, content-type and public ACL', async () => {
    mock.on(PutObjectCommand).resolves({});
    const d = new S3Disk({ client, bucket: 'b', keyPrefix: 'up' });
    await d.put('a.txt', new Uint8Array([1, 2, 3]), {
      contentType: 'text/plain',
      visibility: 'public',
    });
    const calls = mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'up/a.txt',
      ContentType: 'text/plain',
      ACL: 'public-read',
    });
  });

  it('put omits ACL for private (default) visibility', async () => {
    mock.on(PutObjectCommand).resolves({});
    await new S3Disk({ client, bucket: 'b' }).put('a.txt', new Uint8Array([1]));
    expect(mock.commandCalls(PutObjectCommand)[0]?.args[0].input.ACL).toBeUndefined();
  });

  /**
   * ContentLength is asserted explicitly because the mock CANNOT catch its absence: it
   * intercepts the command before the SDK's header middleware runs, so the earlier version of
   * this test passed against a `putStream` that threw
   * `Invalid value "undefined" for header "x-amz-decoded-content-length"` on every real
   * request. Only a live S3/MinIO caught it. Asserting the field is what maps this mock back
   * onto the real failure.
   */
  it('putStream sends a PutObjectCommand with the stream body and its ContentLength', async () => {
    mock.on(PutObjectCommand).resolves({});
    const d = new S3Disk({ client, bucket: 'b' });
    await d.putStream('big.bin', Readable.from(Buffer.from('data')), {
      contentType: 'application/octet-stream',
      contentLength: 4,
    });
    expect(mock.commandCalls(PutObjectCommand)[0]?.args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'big.bin',
      ContentType: 'application/octet-stream',
      ContentLength: 4,
    });
  });

  it('putStream fails fast when contentLength is missing, instead of at the SDK header layer', async () => {
    mock.on(PutObjectCommand).resolves({});
    const d = new S3Disk({ client, bucket: 'b' });
    await expect(
      d.putStream('big.bin', Readable.from(Buffer.from('data')), { contentType: 'x' }),
    ).rejects.toThrow(/contentLength/);
    expect(mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('getBytes round-trips the object body as a Uint8Array', async () => {
    mock.on(GetObjectCommand).resolves({ Body: streamOf('hello') });
    const d = new S3Disk({ client, bucket: 'b' });
    const bytes = await d.getBytes('a.txt');
    expect(Buffer.from(bytes).toString()).toBe('hello');
  });

  it('getBytes maps NoSuchKey to a not-found error', async () => {
    mock.on(GetObjectCommand).rejects(notFound('NoSuchKey'));
    await expect(new S3Disk({ client, bucket: 'b' }).getBytes('missing')).rejects.toThrow(
      /file not found/,
    );
  });

  it('getStream returns the S3 body stream', async () => {
    mock.on(GetObjectCommand).resolves({ Body: streamOf('streamed') });
    const stream = await new S3Disk({ client, bucket: 'b' }).getStream('a.txt');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('streamed');
  });

  it('exists reflects HeadObject success / NotFound', async () => {
    const d = new S3Disk({ client, bucket: 'b' });
    mock.on(HeadObjectCommand).resolves({ ContentLength: 4 });
    expect(await d.exists('a')).toBe(true);
    mock.on(HeadObjectCommand).rejects(notFound('NotFound'));
    expect(await d.exists('a')).toBe(false);
  });

  it('delete issues a DeleteObjectCommand with the prefixed key', async () => {
    mock.on(DeleteObjectCommand).resolves({});
    await new S3Disk({ client, bucket: 'b', keyPrefix: 'up' }).delete('a');
    expect(mock.commandCalls(DeleteObjectCommand)[0]?.args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'up/a',
    });
  });

  it('getMetaData maps HeadObject fields', async () => {
    const lastModified = new Date('2024-05-01T00:00:00.000Z');
    mock.on(HeadObjectCommand).resolves({
      ContentLength: 42,
      ContentType: 'image/png',
      ETag: '"abc"',
      LastModified: lastModified,
    });
    const meta = await new S3Disk({ client, bucket: 'b' }).getMetaData('a.png');
    expect(meta).toEqual({
      contentLength: 42,
      contentType: 'image/png',
      etag: '"abc"',
      lastModified,
    });
  });

  it('getMetaData maps NotFound to a not-found error', async () => {
    mock.on(HeadObjectCommand).rejects(notFound('NotFound'));
    await expect(new S3Disk({ client, bucket: 'b' }).getMetaData('a')).rejects.toThrow(
      /file not found/,
    );
  });

  describe('getUrl', () => {
    it('uses publicBaseUrl when set', async () => {
      const d = new S3Disk({
        client,
        bucket: 'b',
        keyPrefix: 'up',
        publicBaseUrl: 'https://cdn.test/',
      });
      expect(await d.getUrl('a/b.png')).toBe('https://cdn.test/up/a/b.png');
    });

    it('synthesises a virtual-hosted AWS URL from region', async () => {
      const d = new S3Disk({ client, bucket: 'b', region: 'eu-west-1' });
      expect(await d.getUrl('a.png')).toBe('https://b.s3.eu-west-1.amazonaws.com/a.png');
    });

    it('honours path-style endpoints (S3-compatible services)', async () => {
      const d = new S3Disk({
        client,
        bucket: 'b',
        endpoint: 'http://localhost:9000',
        forcePathStyle: true,
      });
      expect(await d.getUrl('a.png')).toBe('http://localhost:9000/b/a.png');
    });
  });

  describe('getSignedUrl', () => {
    it('produces a presigned GET URL with the default TTL', async () => {
      const d = new S3Disk({ client: makeClient(), bucket: 'b' });
      const url = await d.getSignedUrl('a/b.png');
      expect(url).toContain('X-Amz-Signature=');
      expect(url).toContain('X-Amz-Expires=1800');
    });

    it('parses a human-readable expiresIn duration', async () => {
      const d = new S3Disk({ client: makeClient(), bucket: 'b' });
      const url = await d.getSignedUrl('a/b.png', { expiresIn: '2m' });
      expect(url).toContain('X-Amz-Expires=120');
    });

    it('accepts expiresIn as seconds', async () => {
      const d = new S3Disk({ client: makeClient(), bucket: 'b' });
      const url = await d.getSignedUrl('a/b.png', { expiresIn: 90 });
      expect(url).toContain('X-Amz-Expires=90');
    });

    it('signs response content-type / disposition overrides into the URL', async () => {
      const d = new S3Disk({ client: makeClient(), bucket: 'b' });
      const url = await d.getSignedUrl('exports/db.sqlite', {
        contentType: 'application/vnd.sqlite3',
        contentDisposition: 'attachment; filename="db.sqlite"',
      });
      expect(url).toContain('response-content-type=application%2Fvnd.sqlite3');
      expect(url).toContain('response-content-disposition=attachment');
      expect(url).toContain('X-Amz-Signature=');
    });
  });

  describe('hand-rolled SigV4 presigning', () => {
    it('presigns without ever calling the SDK middleware (pure local crypto)', async () => {
      const d = new S3Disk({ client, bucket: 'b' });
      await d.getSignedUrl('a/b.png');
      await d.presignUploadPart('big.mp4', 'mp-1', 3, 900);
      expect(mock.calls()).toHaveLength(0);
    });

    it('presignUploadPart signs a PUT with uploadId/partNumber for the virtual-hosted AWS host', async () => {
      const d = new S3Disk({ client, bucket: 'b', keyPrefix: 'media' });
      const url = new URL(await d.presignUploadPart('videos/v.mp4', 'mp-1', 3, 900));
      expect(url.host).toBe('b.s3.us-east-1.amazonaws.com');
      expect(url.pathname).toBe('/media/videos/v.mp4');
      expect(url.searchParams.get('uploadId')).toBe('mp-1');
      expect(url.searchParams.get('partNumber')).toBe('3');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
      expect(url.searchParams.get('X-Amz-Credential')).toBe(
        `test/${url.searchParams.get('X-Amz-Date')?.slice(0, 8)}/us-east-1/s3/aws4_request`,
      );
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    });

    it('signs browser-facing URLs against publicEndpoint, leaving the internal endpoint to the client', async () => {
      const d = new S3Disk({
        client,
        bucket: 'b',
        endpoint: 'http://minio.internal:9000',
        publicEndpoint: 'https://files.example.com',
        forcePathStyle: true,
      });
      // The presigned part PUT and the signed GET are consumed by the browser: public host.
      expect(await d.presignUploadPart('v.mp4', 'mp-1', 1, 60)).toMatch(
        /^https:\/\/files\.example\.com\/b\/v\.mp4\?/,
      );
      expect(await d.getSignedUrl('v.mp4')).toMatch(/^https:\/\/files\.example\.com\/b\/v\.mp4\?/);
    });

    it('uses path-style URLs against a custom endpoint when forcePathStyle is set', async () => {
      const d = new S3Disk({
        client,
        bucket: 'b',
        endpoint: 'http://localhost:9000',
        forcePathStyle: true,
      });
      const url = new URL(await d.presignUploadPart('k.bin', 'mp-1', 1, 60));
      expect(url.protocol).toBe('http:');
      expect(url.host).toBe('localhost:9000');
      expect(url.pathname).toBe('/b/k.bin');
    });

    it('signs the STS session token into the URL when the client carries one', async () => {
      const tokenClient = new S3Client({
        region: 'us-east-1',
        credentials: { accessKeyId: 'a', secretAccessKey: 's', sessionToken: 'tok' },
      });
      const d = new S3Disk({ client: tokenClient, bucket: 'b' });
      expect(await d.getSignedUrl('a.png')).toContain('X-Amz-Security-Token=tok');
    });
  });

  describe('getVisibility', () => {
    it('defaults to private — the safe assumption for a bucket policy it cannot see', async () => {
      const d = new S3Disk({ client, bucket: 'b' });
      expect(await d.getVisibility('a/b.png')).toBe('private');
    });

    it('reports the configured visibility without calling S3', async () => {
      const d = new S3Disk({ client, bucket: 'b', visibility: 'public' });
      expect(await d.getVisibility('a/b.png')).toBe('public');
      expect(mock.calls()).toHaveLength(0);
    });
  });
});

describe('disks.s3 factory', () => {
  it('lazily builds an S3Disk that talks to the configured bucket', async () => {
    const factory = disks.s3({
      bucket: 'my-bucket',
      region: 'us-east-1',
      keyPrefix: 'media',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    });
    expect(typeof factory).toBe('function');

    const disk = await factory();
    expect(disk).toBeInstanceOf(S3Disk);

    // The built disk is a real S3Disk: exercise put through a mocked client.
    const built = mockClient(
      (disk as unknown as { client: S3Client }).client,
    ) as AwsClientStub<S3Client>;
    built.on(PutObjectCommand).resolves({});
    await disk.put('a.txt', new Uint8Array([1]));
    expect(built.commandCalls(PutObjectCommand)[0]?.args[0].input).toMatchObject({
      Bucket: 'my-bucket',
      Key: 'media/a.txt',
    });
    built.restore();
  });
});
