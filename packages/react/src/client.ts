/**
 * Framework-free browser upload client for `@adonis-agora/media`.
 *
 * It speaks the AdonisJS provider's *actual* HTTP contract (see
 * `packages/adonis/providers/media_provider.ts`), across the three upload strategies the server
 * exposes:
 *
 * - **TUS resumable** (`uploads.resumable.routes`, default prefix `/media/uploads/tus`): create a
 *   session with `POST` + `Upload-Length`/`Upload-Metadata`, then append bytes sequentially with
 *   `PATCH` (`Content-Type: application/offset+octet-stream`, `Upload-Offset`). Interrupted uploads
 *   resume from the server's `Upload-Offset` reported by `HEAD`. This is the default strategy.
 * - **Direct-S3 multipart** (`uploads.routes`, default prefix `/media/uploads`): `POST /direct/initiate`
 *   hands back presigned part URLs; the client `PUT`s each part *straight to S3* (no app auth headers
 *   on those requests — they are already signed), collects each part's `ETag`, then `POST
 *   /direct/:uploadId/complete` assembles them.
 * - **Proxy** (same prefix): a single `PUT /proxy` streams the whole body through the app to the disk.
 *
 * Every request against the *app* endpoints (TUS create/HEAD/PATCH/DELETE, direct initiate/presign/
 * complete/abort, and proxy PUT) merges the static `headers` with a freshly-resolved `getHeaders()`
 * so short-lived auth tokens can be refreshed mid-upload. Presigned S3 PUTs deliberately receive
 * neither — adding an `Authorization` header would break the SigV4 signature.
 */

/** One completed multipart part: its number and the `ETag` S3 returned for it. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

export interface MediaUploadClientOptions {
  /** Origin (and optional path) prepended to every relative endpoint. Default `''` (same-origin). */
  baseUrl?: string;
  /** TUS resumable base path. Must match `uploads.resumable.routes.prefix`. Default `/media/uploads/tus`. */
  tusPath?: string;
  /** Direct-S3 + proxy base path. Must match `uploads.routes.prefix`. Default `/media/uploads`. */
  uploadsPath?: string;
  /** Bytes per TUS chunk / requested direct part size. Default 8 MiB (S3's part minimum is 5 MiB). */
  chunkSize?: number;
  /** Max in-flight part PUTs for direct-S3 multipart. Default 3. */
  concurrency?: number;
  /** Per-chunk/part retry attempts. Default 3. */
  retries?: number;
  /** Custom fetch (tests, non-browser runtimes). Default the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Static headers merged into every *app* request (e.g. `Authorization`). Never sent to S3. */
  headers?: Record<string, string>;
  /**
   * Resolved fresh before every *app* request (each TUS PATCH/HEAD/POST, direct initiate/complete,
   * proxy PUT). Merged over the static `headers`, dynamic wins on key conflict. Never sent to S3.
   */
  getHeaders?: () => HeadersInit | Promise<HeadersInit>;
}

/** Metadata describing the file being uploaded. */
export interface UploadMeta {
  filename: string;
  contentType?: string;
  /**
   * Object key for **direct** and **proxy** strategies. The server route reads this key from the
   * request, so in a real app resolve it server-side (per user/tenant) rather than trusting a
   * client value. Ignored by the TUS strategy (which derives its own key).
   */
  key?: string;
  /** Total byte length (defaults to the blob's `.size`). */
  size?: number;
  /** Disk override forwarded to the direct/proxy routes. */
  disk?: string;
}

export interface PerUploadOptions {
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
  chunkSize?: number;
  concurrency?: number;
}

/** Resume an interrupted TUS upload from a previously-returned session location. */
export interface TusUploadOptions extends PerUploadOptions {
  /** Existing session `Location` to resume; when omitted a fresh session is created. */
  resumeFrom?: string;
}

/** Discriminated result: TUS reports a `location`; direct/proxy report the object `key`/`disk`. */
export type MediaUploadResult =
  | { mode: 'tus'; location: string }
  | { mode: 'direct'; key: string; disk: string; uploadId: string }
  | { mode: 'proxy'; key: string; disk: string };

const DEFAULT_CHUNK = 8 * 1024 * 1024;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRIES = 3;
const TUS_VERSION = '1.0.0';

// --- small helpers (mirrors the reference client's utilities) --------------------------------

function assertOk(res: { ok?: boolean; status?: number }, message: string): void {
  if (!('ok' in res) || res.ok === false) {
    const status = typeof res.status === 'number' ? ` (status ${res.status})` : '';
    throw new Error(`${message}${status}`);
  }
}

function encodeMetadata(meta: Record<string, string>): string {
  return Object.entries(meta)
    .map(([k, v]) => `${k} ${btoa(v)}`)
    .join(',');
}

function headersInitToRecord(headersInit: HeadersInit): Record<string, string> {
  if (headersInit instanceof Headers) {
    const record: Record<string, string> = {};
    headersInit.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headersInit)) return Object.fromEntries(headersInit);
  return { ...headersInit };
}

/** Merge static headers with a fresh `getHeaders()`; dynamic values win on key conflict. */
async function mergeHeaders(
  staticHeaders: Record<string, string> | undefined,
  getHeaders: (() => HeadersInit | Promise<HeadersInit>) | undefined,
): Promise<Record<string, string>> {
  if (!getHeaders) return { ...(staticHeaders ?? {}) };
  return { ...(staticHeaders ?? {}), ...headersInitToRecord(await getHeaders()) };
}

async function withRetry<T>(attempts: number, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      // Never retry a caller-driven abort — surface it immediately.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (attempt < attempts) await new Promise((r) => setTimeout(r, attempt * 500));
    }
  }
  throw lastError;
}

/** Join a base URL with a path/absolute-URL, leaving absolute URLs untouched. */
function joinUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (!baseUrl) return path;
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, '');
}

/** Build a media URL by id, optionally for a named conversion. */
export function mediaUrl(id: string, conversion?: string): string {
  const query = conversion ? `?conversion=${encodeURIComponent(conversion)}` : '';
  return `/media/${encodeURIComponent(id)}${query}`;
}

// --- client ----------------------------------------------------------------------------------

export interface MediaUploadClient {
  /** Resumable sequential TUS upload. Returns the session `Location`. */
  uploadTus(data: Blob, meta: UploadMeta, options?: TusUploadOptions): Promise<MediaUploadResult>;
  /** Presigned direct-S3 multipart upload. Requires `meta.key`. */
  uploadDirect(
    data: Blob,
    meta: UploadMeta,
    options?: PerUploadOptions,
  ): Promise<MediaUploadResult>;
  /** Single-shot proxy upload (streams through the app). Requires `meta.key`. */
  uploadProxy(data: Blob, meta: UploadMeta, options?: PerUploadOptions): Promise<MediaUploadResult>;
  /** Open a TUS session and return its `Location` (for manual resume flows). */
  createTusSession(meta: UploadMeta): Promise<{ location: string }>;
  /** HEAD a TUS session and report its current server-side offset. */
  tusOffset(location: string): Promise<number>;
  /** Terminate an in-flight TUS session (TUS `DELETE`). */
  abortTus(location: string): Promise<void>;
  /** Build a media URL by id + optional conversion. */
  mediaUrl(id: string, conversion?: string): string;
}

/**
 * Create a browser upload client bound to a server's media routes. The returned client exposes one
 * method per upload strategy; a higher-level chooser (`useMediaUpload`) picks between them.
 */
export function createMediaUploadClient(
  clientOptions: MediaUploadClientOptions = {},
): MediaUploadClient {
  const baseUrl = clientOptions.baseUrl ?? '';
  const tusPath = normalizePath(clientOptions.tusPath ?? '/media/uploads/tus');
  const uploadsPath = normalizePath(clientOptions.uploadsPath ?? '/media/uploads');
  const doFetch = clientOptions.fetchImpl ?? fetch;
  const defaultChunk = clientOptions.chunkSize ?? DEFAULT_CHUNK;
  const defaultConcurrency = clientOptions.concurrency ?? DEFAULT_CONCURRENCY;
  const retries = clientOptions.retries ?? DEFAULT_RETRIES;
  const staticHeaders = clientOptions.headers;
  const getHeaders = clientOptions.getHeaders;

  /** Headers for an *app* endpoint (auth-bearing). */
  const appHeaders = () => mergeHeaders(staticHeaders, getHeaders);

  /** Resolve a TUS `Location` (path or absolute URL) against `baseUrl`. */
  const resolveLocation = (location: string) => joinUrl(baseUrl, location);

  async function createTusSession(meta: UploadMeta): Promise<{ location: string }> {
    const length = meta.size ?? 0;
    const res = await doFetch(joinUrl(baseUrl, tusPath), {
      method: 'POST',
      headers: {
        'Tus-Resumable': TUS_VERSION,
        'Upload-Length': String(length),
        'Upload-Metadata': encodeMetadata({
          filename: meta.filename,
          ...(meta.contentType ? { filetype: meta.contentType } : {}),
        }),
        ...(await appHeaders()),
      },
    });
    assertOk(res, 'media upload: TUS create failed');
    const location = res.headers.get('Location');
    if (!location) throw new Error('media upload: server did not return a Location');
    return { location: resolveLocation(location) };
  }

  async function tusOffset(location: string): Promise<number> {
    const res = await doFetch(location, {
      method: 'HEAD',
      headers: { 'Tus-Resumable': TUS_VERSION, ...(await appHeaders()) },
    });
    if (!res.ok) return 0;
    return Number(res.headers.get('Upload-Offset') ?? '0') || 0;
  }

  async function abortTus(location: string): Promise<void> {
    await doFetch(location, {
      method: 'DELETE',
      headers: { 'Tus-Resumable': TUS_VERSION, ...(await appHeaders()) },
    });
  }

  async function uploadTus(
    data: Blob,
    meta: UploadMeta,
    options: TusUploadOptions = {},
  ): Promise<MediaUploadResult> {
    const total = meta.size ?? data.size;
    const chunkSize = options.chunkSize ?? defaultChunk;

    // Resume an existing session, or open a fresh one.
    const location = options.resumeFrom
      ? resolveLocation(options.resumeFrom)
      : (await createTusSession({ ...meta, size: total })).location;

    // On resume, ask the server where it got to; a fresh session starts at 0.
    let offset = options.resumeFrom ? await tusOffset(location) : 0;
    options.onProgress?.(offset, total);

    while (offset < total) {
      if (options.signal?.aborted) throw abortError();
      const end = Math.min(offset + chunkSize, total);
      const slice = data.slice(offset, end);
      const reported = await withRetry(retries, async () => {
        const res = await doFetch(location, {
          method: 'PATCH',
          headers: {
            'Tus-Resumable': TUS_VERSION,
            'Content-Type': 'application/offset+octet-stream',
            'Upload-Offset': String(offset),
            ...(await appHeaders()),
          },
          body: slice,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        assertOk(res, `media upload: PATCH failed at offset ${offset}`);
        const value = Number(res.headers.get('Upload-Offset') ?? '');
        return Number.isFinite(value) && value > offset ? value : end;
      });
      offset = reported;
      options.onProgress?.(offset, total);
    }

    return { mode: 'tus', location };
  }

  async function uploadDirect(
    data: Blob,
    meta: UploadMeta,
    options: PerUploadOptions = {},
  ): Promise<MediaUploadResult> {
    const key = meta.key;
    if (!key) throw new Error('media upload: direct mode requires meta.key');
    const total = meta.size ?? data.size;
    const requestedPartSize = options.chunkSize ?? defaultChunk;
    const concurrency = options.concurrency ?? defaultConcurrency;

    // 1) Initiate: the server presigns one URL per part and tells us the effective part size.
    const created = (await postJson(`${uploadsPath}/direct/initiate`, {
      key,
      ...(meta.contentType !== undefined ? { contentType: meta.contentType } : {}),
      size: total,
      partSize: requestedPartSize,
      ...(meta.disk !== undefined ? { disk: meta.disk } : {}),
    })) as {
      uploadId: string;
      key: string;
      disk: string;
      partSize: number;
      parts: { partNumber: number; url: string }[];
    };

    // Slice with the *server's* part size so our boundaries match the presigned URLs.
    const partSize = created.partSize || requestedPartSize;
    const partCount = Math.max(1, Math.ceil(total / partSize));
    const presigned = new Map(created.parts.map((p) => [p.partNumber, p.url]));

    const uploaded: UploadedPart[] = [];
    let sent = 0;

    // Abort siblings the moment any part fails, so we stop claiming new parts.
    const pool = new AbortController();
    const combinedSignal = options.signal
      ? AbortSignal.any([options.signal, pool.signal])
      : pool.signal;

    let nextIndex = 0; // 0-based part index the next worker claims
    const worker = async (): Promise<void> => {
      try {
        while (true) {
          if (options.signal?.aborted) throw abortError();
          if (pool.signal.aborted) return;
          const index = nextIndex;
          nextIndex += 1;
          if (index >= partCount) return;
          const partNumber = index + 1; // S3 parts are 1-based
          const start = index * partSize;
          const end = Math.min(start + partSize, total);
          const slice = data.slice(start, end);

          const etag = await withRetry(retries, async () => {
            // Presign lazily for parts beyond the initiate response (e.g. size was unknown).
            let url = presigned.get(partNumber);
            if (!url) {
              const extra = (await postJson(
                `${uploadsPath}/direct/${created.uploadId}/parts/${partNumber}?key=${encodeURIComponent(key)}`,
                meta.disk !== undefined ? { disk: meta.disk } : {},
              )) as { url: string };
              url = extra.url;
              presigned.set(partNumber, url);
            }
            // PUT straight to S3 — NO app auth headers (the URL is already SigV4-signed).
            const res = await doFetch(url, {
              method: 'PUT',
              headers: {
                ...(meta.contentType ? { 'Content-Type': meta.contentType } : {}),
              },
              body: slice,
              signal: combinedSignal,
            });
            assertOk(res, `media upload: PUT part ${partNumber} failed`);
            const tag = res.headers.get('ETag') ?? res.headers.get('etag');
            if (!tag) {
              throw new Error(
                `media upload: S3 did not expose an ETag for part ${partNumber} — check the bucket CORS ExposeHeaders`,
              );
            }
            return tag;
          });

          uploaded.push({ partNumber, etag });
          sent += end - start;
          options.onProgress?.(sent, total);
        }
      } catch (error) {
        pool.abort();
        throw error;
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, partCount) }, () => worker()));

    // 2) Complete: hand the server the parts (sorted) so it can assemble the object.
    uploaded.sort((a, b) => a.partNumber - b.partNumber);
    await postJson(`${uploadsPath}/direct/${created.uploadId}/complete`, {
      key,
      parts: uploaded,
      ...(meta.disk !== undefined ? { disk: meta.disk } : {}),
    });

    return { mode: 'direct', key: created.key, disk: created.disk, uploadId: created.uploadId };
  }

  async function uploadProxy(
    data: Blob,
    meta: UploadMeta,
    options: PerUploadOptions = {},
  ): Promise<MediaUploadResult> {
    const key = meta.key;
    if (!key) throw new Error('media upload: proxy mode requires meta.key');
    const total = meta.size ?? data.size;
    const query = new URLSearchParams({ key });
    if (meta.disk) query.set('disk', meta.disk);

    options.onProgress?.(0, total);
    const res = await doFetch(joinUrl(baseUrl, `${uploadsPath}/proxy?${query.toString()}`), {
      method: 'PUT',
      headers: {
        ...(meta.contentType ? { 'Content-Type': meta.contentType } : {}),
        ...(await appHeaders()),
      },
      body: data,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    assertOk(res, 'media upload: proxy PUT failed');
    options.onProgress?.(total, total);
    const body = (await safeJson(res)) as { key?: string; disk?: string } | undefined;
    return { mode: 'proxy', key: body?.key ?? key, disk: body?.disk ?? meta.disk ?? 'default' };
  }

  async function postJson(path: string, body: unknown): Promise<unknown> {
    const res = await doFetch(joinUrl(baseUrl, path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await appHeaders()) },
      body: JSON.stringify(body),
    });
    assertOk(res, `media upload: ${path} failed`);
    return safeJson(res);
  }

  async function safeJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  }

  return {
    uploadTus,
    uploadDirect,
    uploadProxy,
    createTusSession,
    tusOffset,
    abortTus,
    mediaUrl,
  };
}

/** A DOMException-shaped abort error so `error.name === 'AbortError'` holds cross-runtime. */
function abortError(): Error {
  const err = new Error('Upload aborted');
  err.name = 'AbortError';
  return err;
}
