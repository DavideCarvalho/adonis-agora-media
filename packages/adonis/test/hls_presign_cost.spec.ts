import * as crypto from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3Disk } from '../src/disks/s3.js';
import { presignS3Url } from '../src/disks/sigv4.js';
import { HlsDeliveryHandler } from '../src/hls/delivery.js';
import type { MediaLibrary } from '../src/media_library.js';
import type { MediaRecord } from '../src/media_record.js';
import { InMemoryDisk } from '../src/testing/in_memory_disk.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, createHmac: vi.fn(actual.createHmac) };
});

const createHmac = vi.mocked(crypto.createHmac);

beforeEach(() => {
  createHmac.mockClear();
});

/** SigV4 as AWS specifies it, every derivation spelled out — the reference the presigner must match. */
async function referenceSignature(input: {
  secret: string;
  dateStamp: string;
  region: string;
  service: string;
  stringToSign: string;
}): Promise<string> {
  const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
  const h = (key: Buffer | string, data: string) =>
    actual.createHmac('sha256', key).update(data).digest();
  const key = h(
    h(h(h(`AWS4${input.secret}`, input.dateStamp), input.region), input.service),
    'aws4_request',
  );
  return actual.createHmac('sha256', key).update(input.stringToSign).digest('hex');
}

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

function presign(overrides: Partial<Parameters<typeof presignS3Url>[0]> = {}) {
  return presignS3Url({
    method: 'GET',
    protocol: 'https:',
    host: 'examplebucket.s3.amazonaws.com',
    path: '/test.txt',
    credentials,
    region: 'us-east-1',
    expiresInSeconds: 86400,
    now: new Date('2013-05-24T00:00:00Z'),
    ...overrides,
  });
}

describe('presignS3Url — signing-key derivation is reused within a scope', () => {
  it('derives the key once for many URLs in the same (secret, day, region, service)', () => {
    presign({ path: '/warm-up', region: 'eu-west-3' });
    createHmac.mockClear();

    for (let i = 0; i < 100; i += 1) presign({ path: `/segment-${i}.ts`, region: 'eu-west-3' });

    // One HMAC per URL (the signature itself); the four-HMAC key chain is not repeated.
    expect(createHmac).toHaveBeenCalledTimes(100);
  });

  it('still matches the AWS documentation vector after the key is cached', () => {
    const expected = 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404';
    expect(presign()).toContain(`X-Amz-Signature=${expected}`);
    expect(presign()).toContain(`X-Amz-Signature=${expected}`);
  });

  it('signs every scope with its own key, and stays correct as old scopes are evicted', async () => {
    const scopes: Array<{ secret: string; day: string; region: string; service: string }> = [];
    for (let i = 0; i < 40; i += 1) {
      scopes.push({
        secret: `secret-${i % 3}`,
        day: `2026-01-${String((i % 7) + 1).padStart(2, '0')}`,
        region: i % 2 ? 'us-east-1' : 'sa-east-1',
        service: i % 5 ? 's3' : 'execute-api',
      });
    }
    // Twice over, so the second pass hits keys that were cached and keys that were evicted.
    for (const scope of [...scopes, ...scopes]) {
      const now = new Date(`${scope.day}T10:20:30Z`);
      const url = presign({
        credentials: { accessKeyId: 'AK', secretAccessKey: scope.secret },
        region: scope.region,
        service: scope.service,
        now,
      });
      const params = new URL(url).searchParams;
      const dateStamp = scope.day.replaceAll('-', '');
      const credentialScope = `${dateStamp}/${scope.region}/${scope.service}/aws4_request`;
      const canonicalQuery = [...params.entries()]
        .filter(([name]) => name !== 'X-Amz-Signature')
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('&');
      const canonicalRequest = [
        'GET',
        '/test.txt',
        canonicalQuery,
        'host:examplebucket.s3.amazonaws.com\n',
        'host',
        'UNSIGNED-PAYLOAD',
      ].join('\n');
      const actual = await vi.importActual<typeof import('node:crypto')>('node:crypto');
      const stringToSign = [
        'AWS4-HMAC-SHA256',
        `${dateStamp}T102030Z`,
        credentialScope,
        actual.createHash('sha256').update(canonicalRequest).digest('hex'),
      ].join('\n');
      expect(params.get('X-Amz-Signature')).toBe(
        await referenceSignature({
          secret: scope.secret,
          dateStamp,
          region: scope.region,
          service: scope.service,
          stringToSign,
        }),
      );
    }
  });
});

describe('HlsDeliveryHandler — a media playlist with many segments', () => {
  const SEGMENTS = 1200;

  function makeHandler(segmentDisk: { getSignedUrl: InMemoryDisk['getSignedUrl'] }) {
    const files: string[] = ['index.m3u8'];
    for (let r = 0; r < 4; r += 1) {
      files.push(`v${r}/playlist.m3u8`);
      for (let s = 0; s < SEGMENTS; s += 1) files.push(`v${r}/segment-${s}.ts`);
    }
    // Count element reads: a linear membership scan per playlist reference shows up as N² reads.
    let elementReads = 0;
    const trackedFiles = new Proxy(files, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/.test(property)) elementReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const playlist = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:4',
      ...Array.from({ length: SEGMENTS }, (_, s) => `#EXTINF:4.0,\nsegment-${s}.ts`),
      '#EXT-X-ENDLIST',
    ].join('\n');
    const disk = new InMemoryDisk();
    void disk.put('pkg/v3/playlist.m3u8', Buffer.from(playlist));
    disk.getSignedUrl = segmentDisk.getSignedUrl;
    const record = {
      id: 'm',
      conversions: {
        video: { path: 'pkg/index.m3u8', disk: 's3', prefix: 'pkg/', files: trackedFiles },
      },
    } as unknown as MediaRecord;
    const library = {
      find: async () => record,
      storage: { disk: () => disk },
    } as unknown as MediaLibrary;
    const handler = new HlsDeliveryHandler({
      library,
      urlForPlaylist: ({ file }) => `/hls/${file}`,
    });
    return { handler, files, reads: () => elementReads };
  }

  it('checks references against the artifact list in linear work', async () => {
    const { handler, files, reads } = makeHandler({ getSignedUrl: async (key) => `signed:${key}` });

    const result = await handler.handle({ mediaId: 'm', file: 'v3/playlist.m3u8' });

    expect(result.kind).toBe('playlist');
    expect((result as { content: string }).content).toContain('signed:pkg/v3/segment-1199.ts');
    expect(reads()).toBeLessThanOrEqual(2 * files.length);
  });

  it('presigns every segment off S3 with one key derivation for the whole playlist', async () => {
    const s3 = new S3Disk({
      client: new S3Client({ region: 'us-east-1', credentials }),
      bucket: 'media',
      endpoint: 'http://minio.internal:9000',
      publicEndpoint: 'https://media.example.com',
      forcePathStyle: true,
    });
    const { handler } = makeHandler({
      getSignedUrl: (key, options) => s3.getSignedUrl(key, options),
    });
    createHmac.mockClear();

    const result = await handler.handle({ mediaId: 'm', file: 'v3/playlist.m3u8' });

    const content = (result as { content: string }).content;
    expect(
      content.match(/https:\/\/media\.example\.com\/media\/pkg\/v3\/segment-\d+\.ts\?/g),
    ).toHaveLength(SEGMENTS);
    // One signature per segment, plus at most one four-HMAC key derivation.
    expect(createHmac.mock.calls.length).toBeLessThanOrEqual(SEGMENTS + 4);
  });
});
