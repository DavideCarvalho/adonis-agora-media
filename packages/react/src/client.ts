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
 * - **Direct-S3 multipart** (`uploads.routes`, default prefix `/media/uploads`): a session-backed
 *   flow — `POST /` initiates and hands back presigned part URLs; the client `PUT`s each part
 *   *straight to S3* (no app auth headers on those requests — they are already signed), confirms each
 *   part's `ETag` via `POST /:id/parts/:partNumber`, then `POST /:id/complete` assembles the object.
 *   A session's status is readable via `GET /:id` and can be torn down via `DELETE /:id`.
 * - **Proxy** (same prefix): a single `PUT /proxy` streams the whole body through the app to the disk.
 *
 * Every request against the *app* endpoints (TUS create/HEAD/PATCH/DELETE, direct initiate/status/
 * confirm/complete/abort, and proxy PUT) merges the static `headers` with a freshly-resolved `getHeaders()`
 * so short-lived auth tokens can be refreshed mid-upload. Presigned S3 PUTs deliberately receive
 * neither — adding an `Authorization` header would break the SigV4 signature.
 */

/** One completed multipart part: its number and the `ETag` S3 returned for it. */
export interface UploadedPart {
  partNumber: number;
  etag: string;
}

/** A part the client should `PUT`: its number and the presigned URL that authorizes exactly that. */
export interface DirectUploadPartUrl {
  partNumber: number;
  url: string;
}

/**
 * The full direct-upload session as returned by the server (`GET /:id` and the initiate response):
 * the agreed coordinates plus which parts are already confirmed and which are still pending (with
 * fresh presigned URLs). `expiresAt` is an ISO-8601 string — it arrives over JSON, not as a `Date`.
 */
export interface DirectUploadSessionStatus {
  id: string;
  key: string;
  disk: string;
  partSize: number;
  size: number;
  totalParts: number;
  contentType?: string;
  completedParts: UploadedPart[];
  pendingParts: DirectUploadPartUrl[];
  expiresAt?: string;
}

/**
 * Transport for uploading a single direct-S3 part to its presigned URL, resolving to the part's
 * `ETag`. The default ({@link xhrPartUploader}) uses `XMLHttpRequest` so per-part byte progress can
 * be reported through `options.onBytes` (fetch exposes no upload-progress hook). Inject a custom one
 * for tests or non-browser runtimes.
 */
export type PartUploader = (
  url: string,
  body: Blob,
  options: {
    contentType?: string;
    signal?: AbortSignal;
    onBytes?: (loaded: number) => void;
  },
) => Promise<string>;

/** Default {@link PartUploader}: an `XMLHttpRequest` PUT that reports upload byte progress. */
export const xhrPartUploader: PartUploader = (url, body, options) =>
  new Promise<string>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // Hold the listener so it can be removed on settle — a shared signal must never retain dead XHRs.
    const onAbort = () => xhr.abort();
    const detach = () => options.signal?.removeEventListener('abort', onAbort);

    xhr.open('PUT', url);
    if (options.contentType) xhr.setRequestHeader('Content-Type', options.contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onBytes?.(event.loaded);
    };
    xhr.onload = () => {
      detach();
      if (xhr.status >= 200 && xhr.status < 300) {
        // getResponseHeader is case-insensitive per spec, so a single read suffices.
        const etag = xhr.getResponseHeader('ETag');
        if (!etag) {
          reject(
            new Error(
              'media upload: S3 did not expose an ETag — check the bucket CORS ExposeHeaders',
            ),
          );
        } else {
          resolve(etag);
        }
      } else {
        // A typed HTTP error so withRetry can fail fast on a definitive 4xx yet keep retrying 5xx.
        reject(new MediaHttpError('media upload: PUT part failed', xhr.status));
      }
    };
    xhr.onerror = () => {
      detach();
      reject(new Error('media upload: PUT part failed (network error)'));
    };
    xhr.onabort = () => {
      detach();
      reject(abortError());
    };

    // Already aborted: `abort()` before `send()` dispatches no event and `send()` never runs, which
    // would leave the promise unsettled forever — reject up front instead.
    if (options.signal?.aborted) {
      reject(abortError());
      return;
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    xhr.send(body);
  });

export interface MediaUploadClientOptions {
  /** Origin (and optional path) prepended to every relative endpoint. Default `''` (same-origin). */
  baseUrl?: string;
  /** TUS resumable base path. Must match `uploads.resumable.routes.prefix`. Default `/media/uploads/tus`. */
  tusPath?: string;
  /** Direct-S3 + proxy base path. Must match `uploads.routes.prefix`. Default `/media/uploads`. */
  uploadsPath?: string;
  /** Bytes per TUS chunk. Default 8 MiB. The direct-S3 part size is decided by the server, not this. */
  chunkSize?: number;
  /**
   * Reserved for parallel part PUTs. Direct-S3 uploads are currently sequential, so this option does
   * not apply to direct; it is kept for the other strategies and forward compatibility.
   */
  concurrency?: number;
  /** Per-chunk/part retry attempts. Default 3. */
  retries?: number;
  /** Custom fetch (tests, non-browser runtimes). Default the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Custom part transport for direct-S3 uploads. Default {@link xhrPartUploader}. */
  partUploader?: PartUploader;
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
   * Object key for the **proxy** strategy. The server route reads this key from the request, so in
   * a real app resolve it server-side (per user/tenant) rather than trusting a client value. Ignored
   * by the TUS and direct strategies (both derive their own key server-side).
   */
  key?: string;
  /** Total byte length (defaults to the blob's `.size`). */
  size?: number;
  /**
   * Disk override forwarded to the **proxy** route. For direct uploads the disk is assigned by the
   * server at initiate time, so this value is not sent on the direct path.
   */
  disk?: string;
  /**
   * Custom `Upload-Metadata` pairs appended to the TUS create (`filename`/`filetype` are sent
   * automatically). The server's `parseTusMetadata` decodes them, so an app can carry domain
   * fields (e.g. `{ title, examdate }`) through to its upload handler. Ignored by direct/proxy.
   */
  metadata?: Record<string, string>;
  /**
   * Per-upload TUS create path override. Useful when the server's TUS route embeds a resource id
   * in the path (e.g. `/api/exames/tus/:uploadId`) instead of a fixed prefix. Defaults to the
   * client's `tusPath`. Ignored by direct/proxy.
   */
  tusPath?: string;
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

/** Direct-S3 options: progress/abort plus session-lifecycle hooks (initiate callback + resume). */
export interface DirectUploadOptions extends PerUploadOptions {
  /**
   * Fired once after a *fresh* session is initiated (not on resume). Persist the payload to resume
   * the upload later via `resume`.
   */
  onSession?: (session: {
    uploadId: string;
    fileName: string;
    key: string;
    disk: string;
    partSize: number;
  }) => void;
  /** Resume an existing session instead of initiating a new one; only its pending parts upload. */
  resume?: {
    id: string;
    key: string;
    disk: string;
    partSize: number;
    parts: DirectUploadPartUrl[];
  };
}

/** Discriminated result: TUS reports a `location`; direct/proxy report the object `key`/`disk`. */
export type MediaUploadResult<TComplete = unknown> =
  | { mode: 'tus'; location: string }
  | { mode: 'direct'; uploadId: string; key: string; disk: string; body: TComplete }
  | { mode: 'proxy'; key: string; disk: string };

const DEFAULT_CHUNK = 8 * 1024 * 1024;
const DEFAULT_RETRIES = 3;
const TUS_VERSION = '1.0.0';

// --- small helpers (mirrors the reference client's utilities) --------------------------------

/**
 * An HTTP-level upload failure. `status` is the non-2xx response code when the server replied (absent on
 * a network error), letting callers tell a definitive failure (e.g. 404/410 — gone) from a transient one
 * (network blip / 5xx) without parsing the message string.
 */
export class MediaHttpError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(status !== undefined ? `${message} (status ${status})` : message);
    this.name = 'MediaHttpError';
    this.status = status;
  }
}

function assertOk(res: { ok?: boolean; status?: number }, message: string): void {
  if (!('ok' in res) || res.ok === false) {
    throw new MediaHttpError(message, typeof res.status === 'number' ? res.status : undefined);
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
      // A definitive client error (4xx) fails identically on every attempt — fail fast instead of burning
      // attempts×backoff. 5xx and network errors (no status) stay retryable.
      if (error instanceof MediaHttpError && error.status !== undefined && error.status < 500) {
        throw error;
      }
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
  /** Session-backed direct-S3 multipart upload. The server assigns the object key. */
  uploadDirect(
    data: Blob,
    meta: UploadMeta,
    options?: DirectUploadOptions,
  ): Promise<MediaUploadResult>;
  /** Single-shot proxy upload (streams through the app). Requires `meta.key`. */
  uploadProxy(data: Blob, meta: UploadMeta, options?: PerUploadOptions): Promise<MediaUploadResult>;
  /** Open a TUS session and return its `Location` (for manual resume flows). */
  createTusSession(meta: UploadMeta): Promise<{ location: string }>;
  /** HEAD a TUS session and report its current server-side offset. */
  tusOffset(location: string): Promise<number>;
  /** Terminate an in-flight TUS session (TUS `DELETE`). */
  abortTus(location: string): Promise<void>;
  /** Report the full state of a direct upload session (confirmed + still-pending parts). */
  directSessionStatus(uploadId: string): Promise<DirectUploadSessionStatus>;
  /** Terminate an in-flight direct upload session. */
  abortDirectSession(uploadId: string): Promise<void>;
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
  const retries = clientOptions.retries ?? DEFAULT_RETRIES;
  const staticHeaders = clientOptions.headers;
  const getHeaders = clientOptions.getHeaders;

  /** Headers for an *app* endpoint (auth-bearing). */
  const appHeaders = () => mergeHeaders(staticHeaders, getHeaders);

  /** Resolve a TUS `Location` (path or absolute URL) against `baseUrl`. */
  const resolveLocation = (location: string) => joinUrl(baseUrl, location);

  async function createTusSession(meta: UploadMeta): Promise<{ location: string }> {
    const length = meta.size ?? 0;
    const path = meta.tusPath ? normalizePath(meta.tusPath) : tusPath;
    const res = await doFetch(joinUrl(baseUrl, path), {
      method: 'POST',
      headers: {
        'Tus-Resumable': TUS_VERSION,
        'Upload-Length': String(length),
        'Upload-Metadata': encodeMetadata({
          filename: meta.filename,
          ...(meta.contentType ? { filetype: meta.contentType } : {}),
          ...(meta.metadata ?? {}),
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

  // Intentionally non-generic: returns `MediaUploadResult` (body: unknown); the generic is applied at
  // the hook level so the `fakeClient` mock stays assignable.
  async function uploadDirect(
    data: Blob,
    meta: UploadMeta,
    options: DirectUploadOptions = {},
  ): Promise<MediaUploadResult> {
    const total = meta.size ?? data.size;
    const partUploader = clientOptions.partUploader ?? xhrPartUploader;

    // 1) Initiate a fresh session, or resume a persisted one (skipping the initiate round-trip).
    let session: {
      id: string;
      key: string;
      disk: string;
      partSize: number;
      parts: DirectUploadPartUrl[];
    };
    if (options.resume) {
      session = options.resume;
    } else {
      const created = (await postJson(uploadsPath, {
        fileName: meta.filename,
        size: total,
        ...(meta.contentType !== undefined ? { contentType: meta.contentType } : {}),
      })) as {
        id: string;
        key: string;
        disk: string;
        partSize: number;
        size: number;
        totalParts: number;
        parts: DirectUploadPartUrl[];
      };
      session = created;
      options.onSession?.({
        uploadId: created.id,
        fileName: meta.filename,
        key: created.key,
        disk: created.disk,
        partSize: created.partSize,
      });
    }

    const partSize = session.partSize;
    const pending = session.parts;

    // Bytes already on the server = total minus the bytes of the still-pending parts.
    const pendingBytes = pending.reduce((sum, part) => {
      const start = (part.partNumber - 1) * partSize;
      return sum + (Math.min(start + partSize, total) - start);
    }, 0);
    let sent = total - pendingBytes;
    options.onProgress?.(sent, total);

    // 2) Upload each pending part in order, confirming each with the server as it lands.
    const uploaded: UploadedPart[] = [];
    for (const part of pending) {
      if (options.signal?.aborted) throw abortError();
      const start = (part.partNumber - 1) * partSize;
      const end = Math.min(start + partSize, total);
      const slice = data.slice(start, end);

      // PUT straight to S3 via the (injectable) part transport — no app auth headers.
      const etag = await withRetry(retries, () =>
        partUploader(part.url, slice, {
          ...(meta.contentType !== undefined ? { contentType: meta.contentType } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          onBytes: (loaded) => options.onProgress?.(sent + loaded, total),
        }),
      );

      // Confirm the part server-side so a later resume can skip it.
      await postJson(`${uploadsPath}/${session.id}/parts/${part.partNumber}`, { etag });

      uploaded.push({ partNumber: part.partNumber, etag });
      sent += end - start;
      options.onProgress?.(sent, total);
    }

    // 3) Complete: hand the server the confirmed parts (sorted) so it can assemble the object.
    uploaded.sort((a, b) => a.partNumber - b.partNumber);
    const body = await postJson(`${uploadsPath}/${session.id}/complete`, { parts: uploaded });

    return { mode: 'direct', uploadId: session.id, key: session.key, disk: session.disk, body };
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

  async function directSessionStatus(uploadId: string): Promise<DirectUploadSessionStatus> {
    const res = await doFetch(joinUrl(baseUrl, `${uploadsPath}/${uploadId}`), {
      method: 'GET',
      headers: { ...(await appHeaders()) },
    });
    assertOk(res, 'media upload: direct session status failed');
    return (await safeJson(res)) as DirectUploadSessionStatus;
  }

  // Best-effort teardown (mirrors `abortTus`): a non-2xx response is intentionally swallowed.
  async function abortDirectSession(uploadId: string): Promise<void> {
    await doFetch(joinUrl(baseUrl, `${uploadsPath}/${uploadId}`), {
      method: 'DELETE',
      headers: { ...(await appHeaders()) },
    });
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
    directSessionStatus,
    abortDirectSession,
    mediaUrl,
  };
}

/** A DOMException-shaped abort error so `error.name === 'AbortError'` holds cross-runtime. */
function abortError(): Error {
  const err = new Error('Upload aborted');
  err.name = 'AbortError';
  return err;
}
