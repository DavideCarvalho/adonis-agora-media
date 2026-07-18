import type {
  CollectionFilter,
  CollectionListResponse,
  CopyMoveBody,
  DeleteBody,
  DiskListResponse,
  FolderBody,
  ObjectDetailResponse,
  ObjectListResponse,
  Topology,
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
}
