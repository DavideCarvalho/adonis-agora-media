import { isExtendedDisk } from '@adonis-agora/media';
import type {
  Disk,
  ExtendedDisk,
  MediaListOptions,
  MediaListPage,
  MediaRecord,
  UploadSession,
} from '@adonis-agora/media';
import type {
  CollectionFilter,
  CollectionListResponse,
  DiskInfo,
  DiskListResponse,
  MediaEntry,
  ObjectDetailResponse,
  ObjectEntry,
  ObjectFolder,
  ObjectListResponse,
  Topology,
  UploadInfo,
  UploadListResponse,
} from '../types.js';

/** TTL of the signed URLs handed to the browser for object preview/download. */
export const URL_TTL_SECONDS = 300;

/** Cap on the get→put streaming path used for cross-disk copy/move (drivers can't copy across disks). */
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;

/** The slice of `MediaManager` the dashboard depends on — kept structural so it's trivial to fake in tests. */
export interface MediaManagerLike {
  readonly storage: { readonly defaultDisk: string; disk(name?: string): Disk };
  readonly hasResumable: boolean;
  readonly resumable: {
    list(filter?: { disk?: string; keyPrefix?: string }): Promise<UploadSession[]>;
  };
  /** The persistence SPI — the console reads stored records via the cross-owner `list`. */
  readonly store: { list(options?: MediaListOptions): Promise<MediaListPage> };
}

export interface DashboardServiceOptions {
  /** Disk names the console may browse/act on. The first entry (or the manager default) is the default. */
  diskNames: string[];
  /** Whether mutating actions (copy/move/delete) are permitted. */
  actions: boolean;
}

/** An error carrying an HTTP status for the provider to surface verbatim. */
export class DashboardError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'DashboardError';
  }
}

/**
 * All dashboard read/action logic, expressed over a structural {@link MediaManagerLike}. It reads the
 * *real* `@adonis-agora/media` surface — disk `list`/`stat`/`getSignedUrl`/`copy`/`move`/`deleteMany`
 * and the resumable `UploadSessionStore.list()` — and never invents its own persistence. The provider
 * is a thin HTTP shell around this; the logic is pure and unit-tested without booting AdonisJS.
 */
export class DashboardService {
  constructor(
    private readonly manager: MediaManagerLike,
    private readonly options: DashboardServiceOptions,
  ) {}

  /** Coarse capability topology for the SPA to enable/disable affordances. */
  topology(): Topology {
    return {
      disks: this.options.diskNames.length,
      hasUploads: this.manager.hasResumable,
      actions: this.options.actions,
    };
  }

  /** Enumerate the exposed disks with their capabilities (non-extended disks report `list:false`). */
  disks(): DiskListResponse {
    const defaultDisk = this.manager.storage.defaultDisk;
    const disks: DiskInfo[] = this.options.diskNames.map((name) => {
      const disk = this.manager.storage.disk(name);
      const capabilities = isExtendedDisk(disk)
        ? disk.capabilities
        : { presign: false, multipart: false, publicUrls: false, list: false };
      return { name, default: name === defaultDisk, capabilities };
    });
    return { disks };
  }

  /** List one page of a bucket under `prefix` (cursor-based, folders rolled up on the `/` delimiter). */
  async objects(
    diskName: string,
    params: { prefix?: string; cursor?: string; limit?: number } = {},
  ): Promise<ObjectListResponse> {
    const disk = this.extended(diskName);
    const result = await disk.list(params.prefix ?? '', {
      delimiter: '/',
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
    const folders: ObjectFolder[] = result.folders.map((prefix) => ({
      name: folderName(prefix),
      prefix,
    }));
    const files: ObjectEntry[] = result.files.map((entry) => ({
      key: entry.key,
      name: entry.name,
      sizeBytes: entry.sizeBytes,
      lastModified: entry.lastModified ? entry.lastModified.toISOString() : null,
    }));
    return { folders, files, ...(result.cursor !== undefined ? { cursor: result.cursor } : {}) };
  }

  /** Object metadata + a short-lived signed URL for preview/download. */
  async object(diskName: string, key: string): Promise<ObjectDetailResponse> {
    if (!key) throw new DashboardError('key is required', 400);
    const disk = this.manager.storage.disk(diskName);
    const stat = isExtendedDisk(disk) ? await disk.stat(key) : await metaAsStat(disk, key);
    const url = await disk.getSignedUrl(key, { expiresIn: URL_TTL_SECONDS });
    return {
      key,
      size: stat.size,
      ...(stat.contentType !== undefined ? { contentType: stat.contentType } : {}),
      ...(stat.lastModified !== undefined ? { lastModified: stat.lastModified.toISOString() } : {}),
      url,
    };
  }

  /** In-progress resumable uploads, projected from the session store (empty when unconfigured). */
  async uploads(filter: { disk?: string; prefix?: string } = {}): Promise<UploadListResponse> {
    if (!this.manager.hasResumable) return { uploads: [] };
    const sessions = await this.manager.resumable.list({
      ...(filter.disk !== undefined ? { disk: filter.disk } : {}),
      ...(filter.prefix !== undefined ? { keyPrefix: filter.prefix } : {}),
    });
    return { uploads: sessions.map(toUploadInfo) };
  }

  /**
   * One cursor-paginated page of stored media-library records across owners/collections, projected to
   * the SPA's {@link MediaEntry}. Delegates to the real {@link MediaStore.list} — no bespoke query.
   */
  async collections(
    params: CollectionFilter & { cursor?: string; limit?: number } = {},
  ): Promise<CollectionListResponse> {
    const page = await this.manager.store.list({
      ...(params.collection !== undefined ? { collection: params.collection } : {}),
      ...(params.ownerType !== undefined ? { ownerType: params.ownerType } : {}),
      ...(params.ownerId !== undefined ? { ownerId: params.ownerId } : {}),
      ...(params.prefix !== undefined ? { prefix: params.prefix } : {}),
      ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
    });
    return { items: page.items.map(toMediaEntry), nextCursor: page.nextCursor };
  }

  /** Server-side copy (same disk) or streamed cross-disk copy. Original is kept. */
  async copy(body: { disk: string; from: string; to: string; toDisk?: string }): Promise<void> {
    await this.transfer(body, false);
  }

  /** Server-side move (same disk) or streamed cross-disk move. Source is deleted after transfer. */
  async move(body: { disk: string; from: string; to: string; toDisk?: string }): Promise<void> {
    await this.transfer(body, true);
  }

  /** Batched delete of many keys on one disk. */
  async remove(body: { disk: string; keys: string[] }): Promise<void> {
    this.assertActions();
    if (body.keys.length === 0) return;
    const disk = this.extended(body.disk);
    await disk.deleteMany(body.keys);
  }

  private async transfer(
    body: { disk: string; from: string; to: string; toDisk?: string },
    remove: boolean,
  ): Promise<void> {
    this.assertActions();
    if (!body.from || !body.to) throw new DashboardError('from and to are required', 400);
    const toDisk = body.toDisk ?? body.disk;
    const source = this.extended(body.disk);

    if (toDisk === body.disk) {
      if (body.from === body.to)
        throw new DashboardError('source and destination are identical', 400);
      if (remove) await source.move(body.from, body.to);
      else await source.copy(body.from, body.to);
      return;
    }

    // Cross-disk: drivers can't copy between disks, so stream the bytes through the app (capped).
    const dest = this.manager.storage.disk(toDisk);
    const stat = await source.stat(body.from);
    if (stat.size > MAX_TRANSFER_BYTES) {
      throw new DashboardError('object too large for cross-disk transfer', 413);
    }
    const bytes = await source.getBytes(body.from);
    await dest.put(body.to, bytes, {
      ...(stat.contentType !== undefined ? { contentType: stat.contentType } : {}),
    });
    if (remove) await source.deleteMany([body.from]);
  }

  private extended(diskName: string): Disk & ExtendedDisk {
    const disk = this.manager.storage.disk(diskName);
    if (!isExtendedDisk(disk)) {
      throw new DashboardError(
        `disk "${diskName}" does not support listing/object operations`,
        400,
      );
    }
    return disk;
  }

  private assertActions(): void {
    if (!this.options.actions)
      throw new DashboardError('actions are disabled on this console', 403);
  }
}

/** `photos/2024/` → `2024`; `` → ``. */
function folderName(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/** Project a stored `MediaRecord` to the console's `MediaEntry` (dates → ISO, conversions → names). */
function toMediaEntry(record: MediaRecord): MediaEntry {
  return {
    id: record.id,
    ownerType: record.ownerType,
    ownerId: record.ownerId,
    collection: record.collection,
    name: record.name,
    fileName: record.fileName,
    mimeType: record.mimeType,
    sizeBytes: record.size,
    disk: record.disk,
    path: record.path,
    conversions: Object.keys(record.conversions),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toUploadInfo(session: UploadSession): UploadInfo {
  const size = session.size ?? null;
  const percent =
    size && size > 0 ? Math.min(100, Math.round((session.offset / size) * 100)) : null;
  return {
    id: session.id,
    disk: session.disk,
    key: session.key,
    offset: session.offset,
    size,
    percent,
    parts: session.parts,
    multipart: session.multipartUploadId !== undefined,
    ...(session.createdAt ? { createdAt: session.createdAt.toISOString() } : {}),
  };
}

/** Fallback `stat` for non-extended disks via `getMetaData`. */
async function metaAsStat(disk: Disk, key: string) {
  const meta = await disk.getMetaData(key);
  return {
    size: meta.contentLength,
    contentType: meta.contentType,
    lastModified: meta.lastModified,
  };
}
