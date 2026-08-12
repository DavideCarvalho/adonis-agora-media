import type {
  CollectionFilter,
  CollectionListResponse,
  CollectionsSummaryResponse,
  CopyMoveBody,
  DeleteBody,
  DiskListResponse,
  FolderBody,
  LoginBody,
  MeResponse,
  MediaDetailResponse,
  ObjectDetailResponse,
  ObjectInsightsResponse,
  ObjectListResponse,
  Topology,
  UploadDetailResponse,
  UploadListResponse,
} from '../types.js';

/** Runtime config injected into the page by the provider (or defaulted for standalone dev). */
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

/** Read the provider-injected bootstrap, falling back to conventional defaults for standalone dev. */
export function readBootstrap(): DashboardBootstrap {
  const injected = (globalThis as { __MEDIA_DASHBOARD__?: Partial<DashboardBootstrap> })
    .__MEDIA_DASHBOARD__;
  return { ...DEFAULT_BOOTSTRAP, ...injected };
}

export interface DashboardClientOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

function withQuery(base: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `${base}?${qs}` : base;
}

/** A signed-in console user, or a prompt to log in, or "no auth configured" (open console) — the
 *  SPA's own gate, distinct from the server's {@link MeResponse} (which has no `login` case: a 401 IS
 *  the login case, resolved here). */
export type ConsoleAuthState =
  | { state: 'open' }
  | { state: 'authenticated'; user: { id: string; name?: string; roles: string[] } }
  | { state: 'login'; modes: string[] };

/**
 * Framework-free fetch client for the dashboard JSON API. Every call consumes the *real* provider
 * routes (which delegate to `@adonis-agora/media` managers) — there is no mock layer. Ambient session
 * cookies flow via `credentials: 'same-origin'`, so host auth guarding the routes just works.
 */
export class DashboardClient {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: DashboardClientOptions = {}) {
    this.apiBase = (options.apiBase ?? readBootstrap().apiBase).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<T> {
    const res = await this.fetchImpl(withQuery(`${this.apiBase}${path}`, params), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    return this.parse<T>(res);
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    await this.parse<unknown>(res);
  }

  private async parse<T>(res: Response): Promise<T> {
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

  topology(): Promise<Topology> {
    return this.get<Topology>('/topology');
  }

  disks(): Promise<DiskListResponse> {
    return this.get<DiskListResponse>('/disks');
  }

  objects(
    disk: string,
    params: { prefix?: string; cursor?: string; limit?: number } = {},
  ): Promise<ObjectListResponse> {
    return this.get<ObjectListResponse>('/objects', { disk, ...params });
  }

  object(disk: string, key: string): Promise<ObjectDetailResponse> {
    return this.get<ObjectDetailResponse>('/object', { disk, key });
  }

  uploads(params: { disk?: string; prefix?: string } = {}): Promise<UploadListResponse> {
    return this.get<UploadListResponse>('/uploads', params);
  }

  collections(
    params: CollectionFilter & { cursor?: string; limit?: number } = {},
  ): Promise<CollectionListResponse> {
    return this.get<CollectionListResponse>('/collections', {
      collection: params.collection,
      ownerType: params.ownerType,
      ownerId: params.ownerId,
      prefix: params.prefix,
      cursor: params.cursor,
      limit: params.limit,
    });
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
        headers: { 'content-type': 'application/octet-stream' },
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
    const res = await this.fetchImpl(this.objectRawUrl(disk, key), { credentials: 'same-origin' });
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

  /** Who am I? Resolves the console's gate: open (no auth), authenticated, or "show login". */
  async me(): Promise<ConsoleAuthState> {
    const res = await this.fetchImpl(`${this.apiBase}/me`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (res.status === 401) {
      const body: unknown = await res.json().catch(() => null);
      const modes =
        typeof body === 'object' && body !== null && 'auth' in body
          ? ((body as { auth?: { modes?: string[] } }).auth?.modes ?? ['login'])
          : ['login'];
      return { state: 'login', modes };
    }
    const body = await this.parse<MeResponse>(res);
    return 'user' in body ? { state: 'authenticated', user: body.user } : { state: 'open' };
  }

  /** Submit credentials to the built-in login; sets the session cookie on success (else throws). */
  async login(username: string, password: string): Promise<void> {
    const body: LoginBody = { username, password };
    const res = await this.fetchImpl(`${this.apiBase}/login`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        res.status === 401 ? 'Invalid credentials' : `request failed (${res.status})`,
      );
    }
  }

  /** Clears the session cookie. */
  async logout(): Promise<void> {
    await this.fetchImpl(`${this.apiBase}/logout`, {
      method: 'POST',
      credentials: 'same-origin',
    });
  }
}
