import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaHttpError, createMediaUploadClient, mediaUrl, xhrPartUploader } from './client';

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

/** A JSON `Response`-shaped mock (jsdom has no `Response` constructor). */
function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body,
  } as unknown as Response;
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

describe('uploadDirect (session-backed)', () => {
  const initiateBody = {
    id: 'up-1',
    key: 'u/1/a.bin',
    disk: 's3',
    partSize: 10,
    size: 25,
    totalParts: 3,
    parts: [
      { partNumber: 1, url: 'https://s3.example/part-1' },
      { partNumber: 2, url: 'https://s3.example/part-2' },
      { partNumber: 3, url: 'https://s3.example/part-3' },
    ],
  };
  const completeBody = { key: 'u/1/a.bin', disk: 's3', mediaId: 'm-1' };

  type PartOpts = {
    contentType?: string;
    signal?: AbortSignal;
    onBytes?: (loaded: number) => void;
  };
  type Capture = { initiate?: unknown; confirms: unknown[]; complete?: unknown };

  function okPartUploader() {
    return vi.fn(async (url: string, body: Blob, opts: PartOpts): Promise<string> => {
      opts.onBytes?.(body.size);
      return `"etag-${url.slice(-1)}"`;
    });
  }

  /** A fetch mock speaking the session contract: initiate → confirm parts → complete. */
  function sessionServer(calls: string[], capture: Capture) {
    return vi.fn(async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === 'POST' && url === '/media/uploads') {
        capture.initiate = JSON.parse(init.body as string);
        return json(initiateBody, 201);
      }
      if (url.endsWith('/complete')) {
        capture.complete = JSON.parse(init.body as string);
        return json(completeBody);
      }
      if (/\/parts\/\d+$/.test(url)) {
        capture.confirms.push(JSON.parse(init.body as string));
        return json({ offset: 0, completedParts: [] });
      }
      return json({});
    });
  }

  it('initiates a session, uploads + confirms each part, then completes', async () => {
    const calls: string[] = [];
    const capture: Capture = { confirms: [] };
    const fetchImpl = sessionServer(calls, capture);
    const partUploader = okPartUploader();
    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      partUploader,
    });

    const onProgress = vi.fn();
    // 25 bytes @ server partSize 10 => 3 parts
    const result = await client.uploadDirect(
      blobOf(25),
      { filename: 'a.bin', contentType: 'application/octet-stream' },
      { onProgress },
    );

    expect(result).toEqual({
      mode: 'direct',
      uploadId: 'up-1',
      key: 'u/1/a.bin',
      disk: 's3',
      body: completeBody,
    });
    expect(capture.initiate).toEqual({
      fileName: 'a.bin',
      size: 25,
      contentType: 'application/octet-stream',
    });
    expect(partUploader).toHaveBeenCalledTimes(3);
    expect(calls).toContain('POST /media/uploads');
    expect(calls).toContain('POST /media/uploads/up-1/parts/1');
    expect(calls).toContain('POST /media/uploads/up-1/parts/2');
    expect(calls).toContain('POST /media/uploads/up-1/parts/3');
    expect(calls).toContain('POST /media/uploads/up-1/complete');
    expect(capture.confirms).toEqual([
      { etag: '"etag-1"' },
      { etag: '"etag-2"' },
      { etag: '"etag-3"' },
    ]);
    expect(capture.complete).toEqual({
      parts: [
        { partNumber: 1, etag: '"etag-1"' },
        { partNumber: 2, etag: '"etag-2"' },
        { partNumber: 3, etag: '"etag-3"' },
      ],
    });
    expect(onProgress.mock.calls.at(-1)).toEqual([25, 25]);
  });

  it('fires onSession once with the session details (not on resume)', async () => {
    const calls: string[] = [];
    const capture: Capture = { confirms: [] };
    const fetchImpl = sessionServer(calls, capture);
    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      partUploader: okPartUploader(),
    });

    const onSession = vi.fn();
    await client.uploadDirect(blobOf(25), { filename: 'a.bin' }, { onSession });

    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith({
      uploadId: 'up-1',
      fileName: 'a.bin',
      key: 'u/1/a.bin',
      disk: 's3',
      partSize: 10,
    });
  });

  it('resumes from a persisted session, uploading only the pending parts', async () => {
    const calls: string[] = [];
    const capture: Capture = { confirms: [] };
    const fetchImpl = sessionServer(calls, capture);
    const partUploader = okPartUploader();
    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      partUploader,
    });

    const onSession = vi.fn();
    const seen: Array<[number, number]> = [];
    const result = await client.uploadDirect(
      blobOf(15),
      { filename: 'a.bin' },
      {
        onSession,
        onProgress: (s, t) => seen.push([s, t]),
        resume: {
          id: 'up-9',
          key: 'k',
          disk: 's3',
          partSize: 5,
          parts: [
            { partNumber: 2, url: 'https://s3.example/p2' },
            { partNumber: 3, url: 'https://s3.example/p3' },
          ],
        },
      },
    );

    // No fresh initiate; onSession is not re-fired on resume.
    expect(calls).not.toContain('POST /media/uploads');
    expect(capture.initiate).toBeUndefined();
    expect(onSession).not.toHaveBeenCalled();
    // Only the two pending parts uploaded (part 1 was already done).
    expect(partUploader).toHaveBeenCalledTimes(2);
    expect(calls).toContain('POST /media/uploads/up-9/parts/2');
    expect(calls).toContain('POST /media/uploads/up-9/parts/3');
    expect(calls).not.toContain('POST /media/uploads/up-9/parts/1');
    expect(calls).toContain('POST /media/uploads/up-9/complete');
    // Progress starts from the already-uploaded part 1 (5 bytes) and ends complete.
    expect(seen[0][0]).toBeGreaterThanOrEqual(5);
    expect(seen.at(-1)).toEqual([15, 15]);
    expect(result).toMatchObject({ mode: 'direct', uploadId: 'up-9', key: 'k', disk: 's3' });
  });

  it('directSessionStatus GETs the session with app headers and passes the full shape through', async () => {
    let seenUrl = '';
    let seenMethod = '';
    let seenHeaders: Record<string, string> = {};
    const status = {
      id: 'up-1',
      key: 'u/1/a.bin',
      disk: 's3',
      partSize: 10,
      size: 25,
      totalParts: 3,
      contentType: 'application/octet-stream',
      completedParts: [{ partNumber: 1, etag: '"etag-1"' }],
      pendingParts: [
        { partNumber: 2, url: 'https://s3.example/part-2' },
        { partNumber: 3, url: 'https://s3.example/part-3' },
      ],
      expiresAt: '2026-01-01T00:00:00.000Z',
    };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenMethod = init.method as string;
      seenHeaders = init.headers as Record<string, string>;
      return json(status);
    });
    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      headers: { Authorization: 'Bearer t' },
    });

    const result = await client.directSessionStatus('up-1');

    expect(seenMethod).toBe('GET');
    expect(seenUrl).toBe('/media/uploads/up-1');
    expect(seenHeaders.Authorization).toBe('Bearer t');
    // The full session (object arrays, not bare part numbers) survives the round-trip.
    expect(result).toEqual(status);
    expect(result.pendingParts[0]?.url).toBe('https://s3.example/part-2');
    expect(result.completedParts[0]?.etag).toBe('"etag-1"');
  });

  it('abortDirectSession DELETEs the session', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      return { ok: true, status: 204, headers: new Headers() } as Response;
    });
    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.abortDirectSession('up-1');

    expect(calls).toEqual(['DELETE /media/uploads/up-1']);
  });

  it('retries a transient part failure and ultimately succeeds', async () => {
    // A single-part session so the uploader call count is exactly the retry count.
    const onePartBody = {
      id: 'up-r',
      key: 'u/r.bin',
      disk: 's3',
      partSize: 10,
      size: 10,
      totalParts: 1,
      parts: [{ partNumber: 1, url: 'https://s3.example/part-1' }],
    };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST' && url === '/media/uploads') return json(onePartBody, 201);
      if (url.endsWith('/complete')) return json(completeBody);
      if (/\/parts\/\d+$/.test(url)) return json({ offset: 0, completedParts: [] });
      return json({});
    });

    // Fail the first two attempts, succeed on the third (retries: 3 === 3 total attempts).
    let attempts = 0;
    const partUploader = vi.fn(async (): Promise<string> => {
      attempts += 1;
      if (attempts < 3) throw new Error('boom: transient');
      return '"etag-1"';
    });
    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      partUploader,
      retries: 3,
    });

    const result = await client.uploadDirect(blobOf(10), { filename: 'r.bin' });

    expect(partUploader).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ mode: 'direct', uploadId: 'up-r', key: 'u/r.bin', disk: 's3' });
  });

  it('fails fast on a definitive 4xx part failure (no retry)', async () => {
    const onePartBody = {
      id: 'up-4xx',
      key: 'u/4xx.bin',
      disk: 's3',
      partSize: 10,
      size: 10,
      totalParts: 1,
      parts: [{ partNumber: 1, url: 'https://s3.example/part-1' }],
    };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST' && url === '/media/uploads') return json(onePartBody, 201);
      if (url.endsWith('/complete')) return json(completeBody);
      if (/\/parts\/\d+$/.test(url)) return json({ offset: 0, completedParts: [] });
      return json({});
    });

    // A definitive 403 (e.g. an expired presigned URL) fails identically on every attempt — it must NOT
    // burn attempts×backoff.
    const partUploader = vi.fn(async (): Promise<string> => {
      throw new MediaHttpError('media upload: PUT part failed', 403);
    });
    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      partUploader,
      retries: 3,
    });

    await expect(client.uploadDirect(blobOf(10), { filename: '4xx.bin' })).rejects.toThrow(
      /status 403/,
    );
    expect(partUploader).toHaveBeenCalledTimes(1);
  });

  it('still retries a 5xx part failure (only 4xx fails fast)', async () => {
    const onePartBody = {
      id: 'up-5xx',
      key: 'u/5xx.bin',
      disk: 's3',
      partSize: 10,
      size: 10,
      totalParts: 1,
      parts: [{ partNumber: 1, url: 'https://s3.example/part-1' }],
    };
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (init.method === 'POST' && url === '/media/uploads') return json(onePartBody, 201);
      if (url.endsWith('/complete')) return json(completeBody);
      if (/\/parts\/\d+$/.test(url)) return json({ offset: 0, completedParts: [] });
      return json({});
    });

    // Fail twice with a 503, succeed on the third — a 5xx stays retryable even though it is a MediaHttpError.
    let attempts = 0;
    const partUploader = vi.fn(async (): Promise<string> => {
      attempts += 1;
      if (attempts < 3) throw new MediaHttpError('media upload: PUT part failed', 503);
      return '"etag-1"';
    });
    const client = createMediaUploadClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      partUploader,
      retries: 3,
    });

    const result = await client.uploadDirect(blobOf(10), { filename: '5xx.bin' });

    expect(partUploader).toHaveBeenCalledTimes(3);
    expect(result).toMatchObject({ mode: 'direct', uploadId: 'up-5xx', key: 'u/5xx.bin' });
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

/** A minimal, deterministic `XMLHttpRequest` mock — no real timers or network. */
class MockXHR {
  static instances: MockXHR[] = [];

  method = '';
  url = '';
  status = 0;
  aborted = false;
  sentBody: unknown;
  requestHeaders: Record<string, string> = {};
  responseHeaders: Record<string, string> = {};
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  onabort?: () => void;

  constructor() {
    MockXHR.instances.push(this);
  }

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.requestHeaders[name] = value;
  }

  // Case-insensitive header read, per the XHR spec.
  getResponseHeader(name: string): string | null {
    const key = Object.keys(this.responseHeaders).find(
      (header) => header.toLowerCase() === name.toLowerCase(),
    );
    return key ? this.responseHeaders[key] : null;
  }

  send(body: unknown): void {
    this.sentBody = body;
  }

  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
}

describe('xhrPartUploader (real transport, mocked XHR)', () => {
  const realXHR = globalThis.XMLHttpRequest;
  const lastXHR = () => MockXHR.instances[MockXHR.instances.length - 1];

  beforeEach(() => {
    MockXHR.instances = [];
    (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = MockXHR;
  });

  afterEach(() => {
    (globalThis as { XMLHttpRequest: unknown }).XMLHttpRequest = realXHR;
  });

  it('PUTs to the URL and resolves with the ETag (case-insensitive header read)', async () => {
    const promise = xhrPartUploader('https://s3.example/part-1', blobOf(4), {
      contentType: 'application/octet-stream',
    });
    const xhr = lastXHR();
    expect(xhr.method).toBe('PUT');
    expect(xhr.url).toBe('https://s3.example/part-1');
    expect(xhr.requestHeaders['Content-Type']).toBe('application/octet-stream');

    // The server sends a lowercase `etag`; the read must be case-insensitive.
    xhr.status = 200;
    xhr.responseHeaders = { etag: '"abc123"' };
    xhr.onload?.();

    await expect(promise).resolves.toBe('"abc123"');
  });

  it('rejects with a useful error on a non-2xx status', async () => {
    const promise = xhrPartUploader('https://s3.example/part-1', blobOf(4), {});
    const xhr = lastXHR();
    xhr.status = 403;
    xhr.onload?.();
    await expect(promise).rejects.toThrow(/status 403/);
  });

  it('rejects with an AbortError when the signal fires mid-flight', async () => {
    const controller = new AbortController();
    const promise = xhrPartUploader('https://s3.example/part-1', blobOf(4), {
      signal: controller.signal,
    });
    const xhr = lastXHR();
    expect(xhr.aborted).toBe(false);

    controller.abort();

    expect(xhr.aborted).toBe(true);
    await expect(promise).rejects.toHaveProperty('name', 'AbortError');
  });

  it('rejects immediately (no hang) when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const promise = xhrPartUploader('https://s3.example/part-1', blobOf(4), {
      signal: controller.signal,
    });

    // A hang would resolve to 'hang' and fail the assertion instead of stalling the whole suite.
    const outcome = await Promise.race([
      promise.then(
        () => 'resolved' as const,
        (error: Error) => error,
      ),
      new Promise((resolve) => {
        setTimeout(() => resolve('hang'), 200);
      }),
    ]);

    expect(outcome).toHaveProperty('name', 'AbortError');
    // send() must never run on the pre-aborted path.
    expect(lastXHR().sentBody).toBeUndefined();
  });
});
