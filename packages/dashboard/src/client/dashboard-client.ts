import { filterQuery } from '@adonis-agora/filter-client';
import type {
  CollectionFilter,
  CollectionListResponse,
  CollectionsSummaryResponse,
  CopyMoveBody,
  CursorParams,
  DeleteBody,
  DiskListResponse,
  FolderBody,
  MediaDetailResponse,
  ObjectDetailResponse,
  ObjectInsightsResponse,
  ObjectListResponse,
  TenantPickerResponse,
  Topology,
  UploadDetailResponse,
  UploadFilter,
  UploadListResponse,
} from '../types.js';

/** The organization picked in this page's URL (`?tenant=`), sent with every API call. */
export function selectedTenant(): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = new URLSearchParams(window.location.search).get('tenant');
  return value && value !== '*' ? value : undefined;
}

/** `url` with the picked organization appended as `tenant=` (no-op when none is picked). */
export function withTenant(url: string): string {
  const tenant = selectedTenant();
  if (tenant === undefined) return url;
  return `${url}${url.includes('?') ? '&' : '?'}tenant=${encodeURIComponent(tenant)}`;
}

/** Runtime config injected into the page by the provider (or defaulted for local dev). */
export interface DashboardBootstrap {
  /** Base URL of the JSON API, e.g. `/media/dashboard/api`. */
  apiBase: string;
  /** Base of the core direct-S3 upload routes (for `@adonis-agora/media-react`). */
  uploadsBase: string;
  /** Base of the core TUS routes (for `@adonis-agora/media-react`). */
  tusBase: string;
  /** Whether mutating actions are enabled. */
  actions: boolean;
}

const DEFAULT_BOOTSTRAP: DashboardBootstrap = {
  apiBase: '/media/dashboard/api',
  uploadsBase: '/media/uploads',
  tusBase: '/media/uploads/tus',
  actions: false,
};

/** `id` of the JSON data block the provider injects into `index.html` (`spa.ts`'s `CONFIG_ELEMENT_ID`). */
export const CONFIG_ELEMENT_ID = 'media-dashboard-config';

/**
 * Read the provider-injected bootstrap, falling back to conventional defaults for local dev.
 *
 * It arrives as a `<script type="application/json">` data block. A data block is never executed, so
 * a host Content-Security-Policy (shield's `@nonce`) cannot refuse it the way it refuses an
 * un-nonced inline script.
 */
export function readBootstrap(): DashboardBootstrap {
  return { ...DEFAULT_BOOTSTRAP, ...readConfigBlock() };
}

/**
 * The host app's CSRF token, when it sets one.
 *
 * `@adonisjs/shield` guards every state-changing route of the app the console is mounted in and
 * publishes the token as an `XSRF-TOKEN` cookie; a browser client echoes it back in
 * `x-xsrf-token`. Without it shield rejects every console POST (a redirect, not a JSON error).
 * Absent cookie means no header, which is right for a host without shield.
 */
export function csrfHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const match = /(?:^|;\s*)XSRF-TOKEN=([^;]*)/.exec(document.cookie);
  const token = match?.[1];
  if (!token) return {};
  try {
    return { 'x-xsrf-token': decodeURIComponent(token) };
  } catch {
    // A malformed escape (`%ZZ`) must not break every console action: send the raw value.
    return { 'x-xsrf-token': token };
  }
}

/**
 * A response that was redirected instead of answered. The console's API never redirects, so a
 * redirect means the host app turned the request away before it reached the console (shield's CSRF
 * check, or an auth middleware sending the browser to a login page).
 */
function isRedirect(res: Response): boolean {
  return res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400) || res.redirected;
}

const REDIRECT_MESSAGE =
  'The host app redirected this request instead of answering it (a CSRF check or an auth middleware refused it). Reload the page and try again.';

function readConfigBlock(): Partial<DashboardBootstrap> {
  if (typeof document === 'undefined') return {};
  const element = document.getElementById(CONFIG_ELEMENT_ID);
  if (element === null) return {};
  try {
    const parsed: unknown = JSON.parse(element.textContent ?? '');
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Partial<DashboardBootstrap>)
      : {};
  } catch {
    return {};
  }
}

export interface DashboardClientOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  /**
   * What to do when the API answers `401` (the console's `authorize` wants a signed-in user).
   * Defaults to {@link followUnauthenticated}: go to the `redirectTo` the answer carries, else reload
   * the page so the server answers the navigation itself.
   */
  onUnauthenticated?: (redirectTo: string | undefined) => void;
}

/**
 * The default `401` handling: follow the `redirectTo` that `authorize` asked for (your app's sign-in
 * page), else reload the console page so the server answers the navigation (its access-denied page,
 * or its own redirect).
 */
export function followUnauthenticated(redirectTo: string | undefined): void {
  if (typeof window === 'undefined') return;
  if (redirectTo) window.location.assign(redirectTo);
  else window.location.reload();
}

/** The `redirectTo` a `401` body carries when the console's `authorize` asked for a redirect. */
async function readRedirectTo(res: Response): Promise<string | undefined> {
  try {
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return undefined;
    const target = (body as { redirectTo?: unknown }).redirectTo;
    return typeof target === 'string' && target !== '' ? target : undefined;
  } catch {
    return undefined;
  }
}

const UNAUTHENTICATED_MESSAGE = 'Not signed in; redirecting.';

/**
 * The query string of a list request in the `@adonis-agora/filter` wire format: each present filter
 * as `filter[field]=value`, plus the forward cursor (`after`, `first`). Empty filters are left out.
 */
function listQuery(filters: Record<string, string | undefined>, cursor: CursorParams = {}): string {
  const query = filterQuery();
  for (const [field, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') query.where(field, value);
  }
  if (cursor.after) query.after(cursor.after);
  if (cursor.first !== undefined) query.first(cursor.first);
  return query.toQueryString();
}

function withQuery(base: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `${base}?${qs}` : base;
}

/**
 * Framework-free fetch client for the dashboard JSON API. Every call consumes the *real* provider
 * routes (which delegate to `@adonis-agora/media` managers) — there is no mock layer. Ambient session
 * cookies flow via `credentials: 'same-origin'`, so host auth guarding the routes just works.
 */
export class DashboardClient {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onUnauthenticated: (redirectTo: string | undefined) => void;

  constructor(options: DashboardClientOptions = {}) {
    this.apiBase = (options.apiBase ?? readBootstrap().apiBase).replace(/\/+$/, '');
    const base = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    // Every call carries the organization picked in the page URL (tenancy), when there is one.
    this.fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      base(typeof input === 'string' ? withTenant(input) : input, init)) as typeof fetch;
    this.onUnauthenticated = options.onUnauthenticated ?? followUnauthenticated;
  }

  /** A `401`: hand the `redirectTo` (if any) to {@link DashboardClientOptions.onUnauthenticated}. */
  private async unauthenticated(res: Response): Promise<never> {
    this.onUnauthenticated(await readRedirectTo(res));
    throw new Error(UNAUTHENTICATED_MESSAGE);
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined> | string = {},
  ): Promise<T> {
    const url =
      typeof params === 'string'
        ? `${this.apiBase}${path}${params ? `?${params}` : ''}`
        : withQuery(`${this.apiBase}${path}`, params);
    const res = await this.fetchImpl(url, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'manual',
      headers: { accept: 'application/json' },
    });
    return this.parse<T>(res);
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'manual',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...csrfHeader() },
      body: JSON.stringify(body),
    });
    await this.parse<unknown>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
    if (isRedirect(res)) throw new Error(REDIRECT_MESSAGE);
    if (res.status === 401) return this.unauthenticated(res);
    if (!res.ok) {
      let message = `request failed (${res.status})`;
      try {
        const payload = (await res.json()) as { error?: string };
        if (payload?.error) message = payload.error;
      } catch {
        // non-JSON error body — keep the status message
      }
      throw new Error(message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** The organizations this viewer may pick (tenancy on); `mode: 'off'` otherwise. */
  tenants(): Promise<TenantPickerResponse> {
    return this.get<TenantPickerResponse>('/tenants');
  }

  /** Record a switch to `tenant` (`'*'` = every organization); the server logs it. */
  async selectTenant(tenant: string): Promise<void> {
    await this.post(`/tenants/${encodeURIComponent(tenant)}/select`, {});
  }

  topology(): Promise<Topology> {
    return this.get<Topology>('/topology');
  }

  disks(): Promise<DiskListResponse> {
    return this.get<DiskListResponse>('/disks');
  }

  /** One page of a disk listing (folders, then files). Pass a previous page's `meta.nextCursor`
   *  as `after`; the listing pages forward only. */
  objects(
    disk: string,
    params: CursorParams & { prefix?: string } = {},
  ): Promise<ObjectListResponse> {
    const { prefix, ...cursor } = params;
    return this.get<ObjectListResponse>('/objects', listQuery({ disk, prefix }, cursor));
  }

  object(disk: string, key: string): Promise<ObjectDetailResponse> {
    return this.get<ObjectDetailResponse>('/object', { disk, key });
  }

  /** Resumable uploads in progress, newest first. */
  uploads(filter: UploadFilter = {}): Promise<UploadListResponse> {
    return this.get<UploadListResponse>(
      '/uploads',
      listQuery({ disk: filter.disk, prefix: filter.prefix }),
    );
  }

  /** One page of stored media records, newest first. Same forward cursor as {@link objects}. */
  collections(params: CollectionFilter & CursorParams = {}): Promise<CollectionListResponse> {
    const { after, first, ...filters } = params;
    return this.get<CollectionListResponse>(
      '/collections',
      listQuery(
        {
          collection: filters.collection,
          ownerType: filters.ownerType,
          ownerId: filters.ownerId,
          prefix: filters.prefix,
        },
        { ...(after !== undefined ? { after } : {}), ...(first !== undefined ? { first } : {}) },
      ),
    );
  }

  copy(body: CopyMoveBody): Promise<void> {
    return this.post('/copy', body);
  }

  move(body: CopyMoveBody): Promise<void> {
    return this.post('/move', body);
  }

  remove(body: DeleteBody): Promise<void> {
    return this.post('/delete', body);
  }

  createFolder(body: FolderBody): Promise<void> {
    return this.post('/folder', body);
  }

  deleteFolder(body: FolderBody): Promise<void> {
    return this.post('/folder/delete', body);
  }

  copyFolder(body: CopyMoveBody): Promise<void> {
    return this.post('/folder/copy', body);
  }

  moveFolder(body: CopyMoveBody): Promise<void> {
    return this.post('/folder/move', body);
  }

  /** Upload a file to `key` on the disk (raw bytes; MIME preserved via the `type` query param). The
   *  console's convenience upload — bounded server-side; large files belong on the resumable path. */
  async uploadObject(disk: string, key: string, file: Blob & { type: string }): Promise<void> {
    const res = await this.fetchImpl(
      withQuery(`${this.apiBase}/object`, { disk, key, ...(file.type ? { type: file.type } : {}) }),
      {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'manual',
        headers: { 'content-type': 'application/octet-stream', ...csrfHeader() },
        body: file,
      },
    );
    await this.parse<unknown>(res);
  }

  /** Same-origin URL that streams the object bytes inline (`Content-Disposition: inline`) — used to
   *  embed previews (PDF, text, images) that a signed URL might download or that CORS would block. */
  objectRawUrl(disk: string, key: string): string {
    return withQuery(`${this.apiBase}/object/raw`, { disk, key });
  }

  /** What the host knows about this object, from its registered `objectInsights` providers.
   *  `{ insights: [] }` when the host registered none. */
  objectInsights(disk: string, key: string): Promise<ObjectInsightsResponse> {
    return this.get<ObjectInsightsResponse>('/object/insights', { disk, key });
  }

  /**
   * Read up to `maxBytes` of an object as text through the inline proxy, aborting the stream once the
   * budget is reached — so a many-MB CSV/text file is *sampled* (its head) without downloading the
   * whole thing. Falls back to a full read when the runtime can't stream a response body.
   */
  async objectTextHead(
    disk: string,
    key: string,
    maxBytes: number,
  ): Promise<{ text: string; bytesRead: number }> {
    const res = await this.fetchImpl(this.objectRawUrl(disk, key), {
      credentials: 'same-origin',
      redirect: 'manual',
    });
    if (isRedirect(res)) throw new Error(REDIRECT_MESSAGE);
    if (res.status === 401) return this.unauthenticated(res);
    if (!res.ok) throw new Error(`request failed (${res.status})`);
    if (!res.body) {
      const text = await res.text();
      return { text, bytesRead: text.length };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytesRead = 0;
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      bytesRead += value.length;
    }
    if (bytesRead >= maxBytes) await reader.cancel();
    const merged = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    return { text: new TextDecoder().decode(merged), bytesRead };
  }

  /** Full detail (+ recorded parts) of one resumable upload session. */
  uploadDetail(id: string): Promise<UploadDetailResponse> {
    return this.get<UploadDetailResponse>(`/uploads/${encodeURIComponent(id)}`);
  }

  /** Cancels a resumable session (actions-gated). */
  abortUpload(id: string): Promise<void> {
    return this.post(`/uploads/${encodeURIComponent(id)}/abort`, undefined);
  }

  /** Per-collection rollup (record count + total bytes) for the collection chips. */
  collectionsSummary(): Promise<CollectionsSummaryResponse> {
    return this.get<CollectionsSummaryResponse>('/collections/summary');
  }

  /** Full detail of one stored `MediaRecord`, plus its generated conversions. */
  mediaRecord(id: string): Promise<MediaDetailResponse> {
    return this.get<MediaDetailResponse>('/media-record', { id });
  }

  /** Deletes a stored `MediaRecord` (actions-gated; does not touch its underlying disk object). */
  deleteMediaRecord(id: string): Promise<void> {
    return this.post('/media-record/delete', { id });
  }
}
