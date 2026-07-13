import { describe, expect, it, vi } from 'vitest';
import { createMediaUploadClient, mediaUrl } from './client';

function blobOf(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

/** A fetch mock speaking the target TUS contract: POST create → Location, PATCH echoes new offset. */
function tusFetch(location = '/media/uploads/tus/s1') {
  return vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'POST') {
      return { ok: true, status: 201, headers: new Headers({ Location: location }) } as Response;
    }
    if (init.method === 'HEAD') {
      return { ok: true, status: 200, headers: new Headers({ 'Upload-Offset': '0' }) } as Response;
    }
    // PATCH
    const headers = init.headers as Record<string, string>;
    const offset = Number(headers['Upload-Offset']);
    const body = init.body as Blob;
    return {
      ok: true,
      status: 204,
      headers: new Headers({ 'Upload-Offset': String(offset + body.size) }),
    } as Response;
  });
}

describe('mediaUrl', () => {
  it('builds id and conversion URLs', () => {
    expect(mediaUrl('abc')).toBe('/media/abc');
    expect(mediaUrl('a b', 'thumb')).toBe('/media/a%20b?conversion=thumb');
  });
});

describe('uploadTus (target TUS endpoints)', () => {
  it('POSTs to the tus prefix with Upload-Length + metadata, then PATCHes offset+octet-stream', async () => {
    const fetchImpl = tusFetch();
    const progress: number[] = [];
    const client = createMediaUploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const result = await client.uploadTus(
      blobOf(5),
      { filename: 'a.txt', contentType: 'text/plain' },
      {
        chunkSize: 2,
        onProgress: (sent, total) => progress.push(sent / total),
      },
    );

    expect(result).toEqual({ mode: 'tus', location: '/media/uploads/tus/s1' });

    // create POST goes to the tus prefix
    const [createUrl, createInit] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(createUrl).toBe('/media/uploads/tus');
    const createHeaders = createInit.headers as Record<string, string>;
    expect(createHeaders['Tus-Resumable']).toBe('1.0.0');
    expect(createHeaders['Upload-Length']).toBe('5');
    expect(createHeaders['Upload-Metadata']).toContain('filename');

    // PATCH uses the resumable content type + Upload-Offset
    const patch = fetchImpl.mock.calls.find((c) => (c[1] as RequestInit).method === 'PATCH');
    const patchHeaders = (patch?.[1] as RequestInit).headers as Record<string, string>;
    expect(patchHeaders['Content-Type']).toBe('application/offset+octet-stream');
    expect(progress.at(-1)).toBe(1);
    // 1 POST + 1 HEAD (resumeFrom flow not used here) + ceil(5/2)=3 PATCH — but no resume, so no HEAD.
    const methods = fetchImpl.mock.calls.map((c) => (c[1] as RequestInit).method);
    expect(methods.filter((m) => m === 'PATCH')).toHaveLength(3);
    expect(methods).not.toContain('HEAD');
  });

  it('resumes from the server Upload-Offset when given resumeFrom (HEAD then continues)', async () => {
    const total = 10;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'HEAD') {
        // server already has the first 6 bytes
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'Upload-Offset': '6' }),
        } as Response;
      }
      const headers = init.headers as Record<string, string>;
      const offset = Number(headers['Upload-Offset']);
      const body = init.body as Blob;
      return {
        ok: true,
        status: 204,
        headers: new Headers({ 'Upload-Offset': String(offset + body.size) }),
      } as Response;
    });
    const client = createMediaUploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const seen: Array<[number, number]> = [];
    await client.uploadTus(
      blobOf(total),
      { filename: 'r.bin', size: total },
      {
        resumeFrom: '/media/uploads/tus/resume-me',
        chunkSize: 4,
        onProgress: (s, t) => seen.push([s, t]),
      },
    );

    // Starts at the resumed offset 6, not 0.
    expect(seen[0]).toEqual([6, 10]);
    expect(seen.at(-1)).toEqual([10, 10]);
    // Only the remaining bytes (6..10) are PATCHed — a single 4-byte chunk.
    const patches = fetchImpl.mock.calls.filter((c) => (c[1] as RequestInit).method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(
      (patches[0]?.[1] as RequestInit & { headers: Record<string, string> }).headers[
        'Upload-Offset'
      ],
    ).toBe('6');
  });

  it('throws when the server returns no Location', async () => {
    const fetchImpl = vi.fn(
      async () => ({ ok: true, status: 201, headers: new Headers() }) as Response,
    );
    const client = createMediaUploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.uploadTus(blobOf(3), { filename: 'x' })).rejects.toThrow(/Location/);
  });

  it('aborts mid-stream when the signal fires', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        return {
          ok: true,
          status: 201,
          headers: new Headers({ Location: '/media/uploads/tus/x' }),
        } as Response;
      }
      controller.abort();
      const headers = init.headers as Record<string, string>;
      const offset = Number(headers['Upload-Offset']);
      const body = init.body as Blob;
      return {
        ok: true,
        status: 204,
        headers: new Headers({ 'Upload-Offset': String(offset + body.size) }),
      } as Response;
    });
    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retries: 1,
    });
    await expect(
      client.uploadTus(blobOf(10), { filename: 'a' }, { chunkSize: 2, signal: controller.signal }),
    ).rejects.toHaveProperty('name', 'AbortError');
  });

  it('merges dynamic getHeaders over static headers on app requests (dynamic wins)', async () => {
    let captured: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'POST') {
        captured = { ...(init.headers as Record<string, string>) };
        return {
          ok: true,
          status: 201,
          headers: new Headers({ Location: '/media/uploads/tus/h' }),
        } as Response;
      }
      const headers = init.headers as Record<string, string>;
      const offset = Number(headers['Upload-Offset']);
      const body = init.body as Blob;
      return {
        ok: true,
        status: 204,
        headers: new Headers({ 'Upload-Offset': String(offset + body.size) }),
      } as Response;
    });
    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headers: { Authorization: 'static', 'X-Keep': 'yes' },
      getHeaders: () => ({ Authorization: 'fresh' }),
    });
    await client.uploadTus(blobOf(2), { filename: 'a' }, { chunkSize: 2 });
    expect(captured.Authorization).toBe('fresh');
    expect(captured['X-Keep']).toBe('yes');
  });
});

describe('uploadDirect (target presigned-S3 multipart endpoints)', () => {
  it('initiates, PUTs each part to its presigned URL, collects ETags, then completes', async () => {
    const calls: string[] = [];
    let completeBody: unknown;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (url.endsWith('/direct/initiate')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            uploadId: 'up-1',
            key: 'u/1/a.bin',
            disk: 's3',
            partSize: 10,
            parts: [
              { partNumber: 1, url: 'https://s3.example/part-1' },
              { partNumber: 2, url: 'https://s3.example/part-2' },
              { partNumber: 3, url: 'https://s3.example/part-3' },
            ],
          }),
        } as unknown as Response;
      }
      if (init.method === 'PUT') {
        // presigned S3 PUT → returns an ETag header, NO app auth headers present
        expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
        const n = url.slice(-1);
        return { ok: true, status: 200, headers: new Headers({ ETag: `"etag-${n}"` }) } as Response;
      }
      if (url.endsWith('/complete')) {
        completeBody = JSON.parse(init.body as string);
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({ key: 'u/1/a.bin', disk: 's3' }),
        } as unknown as Response;
      }
      return { ok: true, status: 200, headers: new Headers() } as Response;
    });

    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headers: { Authorization: 'Bearer t' },
    });
    const onProgress = vi.fn();
    // 25 bytes @ server partSize 10 => 3 parts
    const result = await client.uploadDirect(
      blobOf(25),
      { filename: 'a.bin', key: 'u/1/a.bin' },
      {
        concurrency: 2,
        onProgress,
      },
    );

    expect(result).toEqual({ mode: 'direct', key: 'u/1/a.bin', disk: 's3', uploadId: 'up-1' });
    expect(calls).toContain('PUT https://s3.example/part-1');
    expect(calls).toContain('PUT https://s3.example/part-3');
    expect(calls.some((c) => c.includes('/direct/up-1/complete'))).toBe(true);
    // ETags forwarded to complete, sorted by part number
    expect(completeBody).toEqual({
      key: 'u/1/a.bin',
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 3, etag: '"etag-3"' },
      ],
    });
    const last = onProgress.mock.calls.at(-1) as [number, number];
    expect(last).toEqual([25, 25]);
  });

  it('requires meta.key', async () => {
    const client = createMediaUploadClient({ fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(client.uploadDirect(blobOf(4), { filename: 'a' })).rejects.toThrow(/key/);
  });

  it('surfaces the first part failure and stops early', async () => {
    let puts = 0;
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/direct/initiate')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          json: async () => ({
            uploadId: 'up',
            key: 'k',
            disk: 's3',
            partSize: 10,
            parts: Array.from({ length: 50 }, (_, i) => ({
              partNumber: i + 1,
              url: `https://s3/p${i + 1}`,
            })),
          }),
        } as unknown as Response;
      }
      if (init.method === 'PUT') {
        puts += 1;
        if (puts === 1) throw new Error('boom: part 1');
        return { ok: true, status: 200, headers: new Headers({ ETag: '"e"' }) } as Response;
      }
      return { ok: true, status: 200, headers: new Headers() } as Response;
    });
    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retries: 1,
    });
    await expect(
      client.uploadDirect(blobOf(500), { filename: 'a', key: 'k' }, { concurrency: 4 }),
    ).rejects.toThrow('boom: part 1');
    expect(puts).toBeLessThan(25); // bounded by concurrency, nowhere near all 50 parts
  });
});

describe('uploadProxy (target proxy PUT endpoint)', () => {
  it('PUTs the whole body to /proxy with the key query param and returns key/disk', async () => {
    let putUrl = '';
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      putUrl = url;
      expect(init.method).toBe('PUT');
      return {
        ok: true,
        status: 201,
        headers: new Headers(),
        json: async () => ({ key: 'k', disk: 'local' }),
      } as unknown as Response;
    });
    const client = createMediaUploadClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const onProgress = vi.fn();
    const result = await client.uploadProxy(
      blobOf(12),
      { filename: 'a', key: 'k', contentType: 'text/plain' },
      { onProgress },
    );

    expect(result).toEqual({ mode: 'proxy', key: 'k', disk: 'local' });
    expect(putUrl).toContain('/media/uploads/proxy?key=k');
    expect(onProgress).toHaveBeenLastCalledWith(12, 12);
  });
});

describe('baseUrl resolution', () => {
  it('prefixes relative paths and TUS Location with baseUrl, leaves presigned URLs absolute', async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      urls.push(url);
      if (init.method === 'POST') {
        return {
          ok: true,
          status: 201,
          headers: new Headers({ Location: '/media/uploads/tus/z' }),
        } as Response;
      }
      const headers = init.headers as Record<string, string>;
      const offset = Number(headers['Upload-Offset']);
      const body = init.body as Blob;
      return {
        ok: true,
        status: 204,
        headers: new Headers({ 'Upload-Offset': String(offset + body.size) }),
      } as Response;
    });
    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      baseUrl: 'https://api.example.com',
    });
    const result = await client.uploadTus(blobOf(3), { filename: 'a' }, { chunkSize: 3 });
    expect(result).toEqual({
      mode: 'tus',
      location: 'https://api.example.com/media/uploads/tus/z',
    });
    expect(urls[0]).toBe('https://api.example.com/media/uploads/tus');
    expect(urls[1]).toBe('https://api.example.com/media/uploads/tus/z'); // PATCH against resolved location
  });
});
