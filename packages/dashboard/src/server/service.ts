import type { Readable } from 'node:stream';
import { isExtendedDisk } from '@adonis-agora/media';
import type {
  Disk,
  ExtendedDisk,
  MediaConversion,
  MediaListOptions,
  MediaListPage,
  MediaRecord,
  MultipartPart,
  UploadSession,
} from '@adonis-agora/media';
import type {
  CollectionFilter,
  CollectionListResponse,
  CollectionsSummaryResponse,
  DiskInfo,
  DiskListResponse,
  MediaDetailResponse,
  MediaEntry,
  ObjectDetailResponse,
  ObjectEntry,
  ObjectFolder,
  ObjectInsight,
  ObjectInsightsResponse,
  ObjectListResponse,
  Topology,
  UploadDetailResponse,
  UploadInfo,
  UploadListResponse,
} from '../types.js';
import type { ObjectInsightProvider } from './object_insights.js';
import { sanitizeInsight } from './object_insights.js';

/** TTL of the signed URLs handed to the browser for object preview/download. */
export const URL_TTL_SECONDS = 300;

/** Cap on the get→put streaming path used for cross-disk copy/move (drivers can't copy across disks). */
export const MAX_TRANSFER_BYTES = 100 * 1024 * 1024;

/** Page size for the flat sweep that recursive folder delete/copy/move paginates over. */
export const FOLDER_SWEEP_LIMIT = 1000;

/** Page size for the client-side scan behind {@link DashboardService.collectionsSummary}. */
export const COLLECTIONS_SUMMARY_PAGE_SIZE = 200;

/** Hard cap on records scanned by {@link DashboardService.collectionsSummary} — beyond this the
 *  rollup is partial rather than unbounded. */
export const COLLECTIONS_SUMMARY_SCAN_LIMIT = 5000;

/** Ceiling for a console (direct) upload — buffered in memory, so bounded to protect the process
 *  heap. Larger files belong on the resumable (TUS) upload path, not this convenience upload. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** Strip leading and trailing slashes — a folder prefix normalized to its bare path (no delimiter). */
function normalizeFolder(prefix: string): string {
  return prefix.replace(/^\/+/, '').replace(/\/+$/, '');
}

/** The slice of `MediaManager` the dashboard depends on — kept structural so it's trivial to fake in tests. */
export interface MediaManagerLike {
  readonly storage: { readonly defaultDisk: string; disk(name?: string): Disk };
  readonly hasResumable: boolean;
  readonly resumable: {
    list(filter?: { disk?: string; keyPrefix?: string }): Promise<UploadSession[]>;
    /** Discard an in-flight session (native multipart + buffered parts), then drop its record. */
    abort(id: string): Promise<void>;
    /** All recorded parts for a session (multipart-capable disks); empty for a buffered session. */
    listParts(id: string): Promise<MultipartPart[]>;
  };
  /** The persistence SPI — the console reads stored records via the cross-owner `list`, and a single
   *  record (+ delete) for the record-detail drill-in. */
  readonly store: {
    list(options?: MediaListOptions): Promise<MediaListPage>;
    find(id: string): Promise<MediaRecord | null>;
    delete(id: string): Promise<void>;
  };
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
    /** Host-registered {@link ObjectInsightProvider}s, from `config/media_dashboard.ts`'s `objectInsights`. */
    private readonly insightProviders: ObjectInsightProvider[] = [],
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
    // Drop phantom folders whose name is empty — a CommonPrefix of only slashes (`/`, `//`),
    // produced by a stray key with a leading slash. The S3 driver normalizes such a prefix back
    // to the root, so listing INTO one returns the root again (the phantom included) — a self-
    // reference that infinite-loops the browser (endless re-list of root). Filtering it out removes
    // the trap; those leading-slash keys are unreachable from the console anyway (the driver strips
    // the leading slash).
    const folders: ObjectFolder[] = result.folders
      .map((prefix) => ({ name: folderName(prefix), prefix }))
      .filter((folder) => folder.name !== '');
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

  /**
   * The object's raw byte stream plus the metadata the provider needs to serve it inline. Backs the
   * console's same-origin preview proxy so text/PDF render in the browser instead of downloading
   * (and so a CORS-locked bucket is still previewable).
   */
  async objectStream(
    diskName: string,
    key: string,
  ): Promise<{ stream: Readable; contentType: string; size: number }> {
    if (!key) throw new DashboardError('key is required', 400);
    const disk = this.manager.storage.disk(diskName);
    const stat = isExtendedDisk(disk) ? await disk.stat(key) : await metaAsStat(disk, key);
    const stream = await disk.getStream(key);
    return { stream, contentType: stat.contentType ?? 'application/octet-stream', size: stat.size };
  }

  /**
   * What the HOST knows about this object, from every registered `objectInsights` provider (see
   * `config/media_dashboard.ts`). `{ insights: [] }` when none are registered. A provider that
   * throws is skipped and logged — annotation must never be able to stop an admin opening a file, and
   * providers run concurrently so one host lookup being slow doesn't serialize the others.
   */
  async objectInsights(diskName: string, key: string): Promise<ObjectInsightsResponse> {
    if (this.insightProviders.length === 0) return { insights: [] };
    // Validates the disk the same way every other object read does, so an unknown disk 404s here too.
    this.manager.storage.disk(diskName);
    const settled = await Promise.all(
      this.insightProviders.map(async (provider): Promise<ObjectInsight | null> => {
        try {
          return await provider.resolve({ disk: diskName, key });
        } catch (error) {
          console.warn(
            `[media-dashboard] object-insight provider "${provider.id}" failed for ${diskName}:${key} — ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }
      }),
    );
    return {
      insights: settled
        .filter((insight): insight is ObjectInsight => insight !== null)
        .map(sanitizeInsight),
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

  /** Full detail (+ recorded parts) of one resumable upload session. */
  async uploadDetail(id: string): Promise<UploadDetailResponse> {
    if (!this.manager.hasResumable) throw new DashboardError('no upload store configured', 404);
    const sessions = await this.manager.resumable.list();
    const session = sessions.find((candidate) => candidate.id === id);
    if (!session) throw new DashboardError(`unknown upload: ${id}`, 404);
    const parts = await this.manager.resumable.listParts(id);
    return { upload: toUploadInfo(session), parts };
  }

  /**
   * Cancels a resumable session: discards its native multipart upload (or buffered parts) and drops
   * its record, so it stops appearing as in-progress. Actions-gated.
   */
  async abortUpload(id: string): Promise<void> {
    this.assertActions();
    if (!this.manager.hasResumable) throw new DashboardError('no upload store configured', 404);
    await this.manager.resumable.abort(id);
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

  /**
   * Per-collection rollup (record count + total bytes) for the console's collection chips.
   * `MediaStore` has no aggregate query, so this walks `list()` in batches and sums client-side —
   * bounded at {@link COLLECTIONS_SUMMARY_SCAN_LIMIT} records so a very large library degrades to a
   * partial (still useful) summary instead of an unbounded scan.
   */
  async collectionsSummary(): Promise<CollectionsSummaryResponse> {
    const totals = new Map<string, { count: number; sumSize: number }>();
    let cursor: string | undefined;
    let scanned = 0;
    do {
      const page = await this.manager.store.list({
        limit: COLLECTIONS_SUMMARY_PAGE_SIZE,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const record of page.items) {
        const bucket = totals.get(record.collection) ?? { count: 0, sumSize: 0 };
        bucket.count += 1;
        bucket.sumSize += record.size;
        totals.set(record.collection, bucket);
      }
      scanned += page.items.length;
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined && scanned < COLLECTIONS_SUMMARY_SCAN_LIMIT);
    return {
      collections: Array.from(totals.entries()).map(([key, agg]) => ({ key, ...agg })),
    };
  }

  /**
   * Full detail of one stored `MediaRecord`, plus signed URLs for its generated conversions. Only
   * conversions carrying a concrete `{disk, path}` artifact get a link — a metadata-only conversion
   * (probe results with no output file) has nothing to preview.
   */
  async mediaRecord(id: string): Promise<MediaDetailResponse> {
    const record = await this.manager.store.find(id);
    if (!record) throw new DashboardError(`unknown media record: ${id}`, 404);
    const linkable = Object.entries(record.conversions).filter(
      (entry): entry is [string, MediaConversion & { disk: string; path: string }] =>
        typeof entry[1].disk === 'string' && typeof entry[1].path === 'string',
    );
    const variants = await Promise.all(
      linkable.map(async ([name, conversion]) => {
        const disk = this.manager.storage.disk(conversion.disk);
        const url = await disk.getSignedUrl(conversion.path, { expiresIn: URL_TTL_SECONDS });
        return { name, url };
      }),
    );
    return { record: toMediaEntry(record), variants };
  }

  /** Deletes a stored `MediaRecord`. Actions-gated (does not touch its underlying disk object). */
  async deleteMediaRecord(id: string): Promise<void> {
    this.assertActions();
    const record = await this.manager.store.find(id);
    if (!record) throw new DashboardError(`unknown media record: ${id}`, 404);
    await this.manager.store.delete(id);
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

  /**
   * Writes an object from a byte stream (a browser upload) — the console's convenience upload,
   * distinct from the resumable TUS path. The caller supplies the full key (prefix + filename).
   * Bounded at {@link MAX_UPLOAD_BYTES} so a runaway upload can't exhaust the process heap. Actions-gated.
   */
  async putObject(
    diskName: string,
    key: string,
    body: AsyncIterable<Uint8Array>,
    contentType?: string,
  ): Promise<void> {
    this.assertActions();
    if (!key) throw new DashboardError('key is required', 400);
    const disk = this.manager.storage.disk(diskName);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_UPLOAD_BYTES) {
        throw new DashboardError(
          `upload exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB console limit`,
          413,
        );
      }
      chunks.push(buffer);
    }
    await disk.put(key, new Uint8Array(Buffer.concat(chunks)), contentType ? { contentType } : {});
  }

  /**
   * Create a "folder" — a zero-byte marker object at `<prefix>/`, which S3-style delimiter listing
   * surfaces as a navigable folder. Normalizes to exactly one trailing slash (so the key never
   * double-slashes); rejects an empty prefix. Actions-gated.
   */
  async createFolder(body: { disk: string; prefix: string }): Promise<void> {
    this.assertActions();
    const disk = this.extended(body.disk);
    const normalized = normalizeFolder(body.prefix);
    if (normalized === '') throw new DashboardError('folder name is required', 400);
    await disk.put(`${normalized}/`, new Uint8Array(0));
  }

  /**
   * Recursively delete a "folder": every object under `<prefix>/` (nested included) plus the
   * zero-byte marker itself. Sweeps with an EMPTY delimiter so the driver lists keys FLAT — the
   * default `/` delimiter would roll nested keys up into folder prefixes and the sweep would miss
   * them, deleting only direct children. Paginates until the disk reports no more, then deletes the
   * marker explicitly (its key equals the sweep prefix, which `list` filters out). Actions-gated.
   */
  async deleteFolder(body: { disk: string; prefix: string }): Promise<void> {
    this.assertActions();
    const disk = this.extended(body.disk);
    const normalized = normalizeFolder(body.prefix);
    if (normalized === '') throw new DashboardError('folder is required', 400);
    const sweepPrefix = `${normalized}/`;
    let cursor: string | undefined;
    do {
      const result = await disk.list(sweepPrefix, {
        delimiter: '',
        limit: FOLDER_SWEEP_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      if (result.files.length > 0) await disk.deleteMany(result.files.map((entry) => entry.key));
      cursor = result.cursor;
    } while (cursor !== undefined);
    await disk.delete(sweepPrefix);
  }

  /** Copy a whole "folder" (every object under `<from>/`, nested included) to `<to>/`, same or cross disk. */
  async copyFolder(body: {
    disk: string;
    from: string;
    to: string;
    toDisk?: string;
  }): Promise<void> {
    await this.transferFolder('copy', body);
  }

  /** Move a whole "folder" (every object under `<from>/`, nested included) to `<to>/`, same or cross disk. */
  async moveFolder(body: {
    disk: string;
    from: string;
    to: string;
    toDisk?: string;
  }): Promise<void> {
    await this.transferFolder('move', body);
  }

  private async transfer(
    body: { disk: string; from: string; to: string; toDisk?: string },
    remove: boolean,
  ): Promise<void> {
    this.assertActions();
    if (!body.from || !body.to) throw new DashboardError('from and to are required', 400);
    const toDisk = body.toDisk ?? body.disk;
    if (toDisk === body.disk && body.from === body.to)
      throw new DashboardError('source and destination are identical', 400);
    await this.transferKey(remove ? 'move' : 'copy', body.disk, body.from, toDisk, body.to);
  }

  /**
   * Relocate a single object, same disk or across disks. Same-disk uses the driver's native
   * `copy`/`move` (server-side, no bytes through the app). Cross-disk has no driver primitive, so the
   * object is streamed through the app (get→put, capped at {@link MAX_TRANSFER_BYTES}); a `move` then
   * deletes the source. Callers gate actions.
   */
  private async transferKey(
    op: 'copy' | 'move',
    fromDisk: string,
    from: string,
    toDisk: string,
    to: string,
  ): Promise<void> {
    const source = this.extended(fromDisk);
    if (toDisk === fromDisk) {
      if (op === 'move') await source.move(from, to);
      else await source.copy(from, to);
      return;
    }
    const dest = this.manager.storage.disk(toDisk);
    const stat = await source.stat(from);
    if (stat.size > MAX_TRANSFER_BYTES) {
      throw new DashboardError('object too large for cross-disk transfer', 413);
    }
    const bytes = await source.getBytes(from);
    await dest.put(to, bytes, {
      ...(stat.contentType !== undefined ? { contentType: stat.contentType } : {}),
    });
    if (op === 'move') await source.deleteMany([from]);
  }

  /**
   * Shared engine for {@link copyFolder}/{@link moveFolder}. Same flat-listing sweep as
   * {@link deleteFolder}; each key is relocated via {@link transferKey} (so cross-disk works
   * transparently), preserving its path relative to the source. On the SAME disk, rejects a
   * destination inside the source (which would recurse forever); across disks that can't happen. The
   * destination folder marker is written, and for a move the source marker removed, so both listings
   * stay consistent. Actions-gated.
   */
  private async transferFolder(
    op: 'copy' | 'move',
    body: { disk: string; from: string; to: string; toDisk?: string },
  ): Promise<void> {
    this.assertActions();
    const source = this.extended(body.disk);
    const toDisk = body.toDisk ?? body.disk;
    const dest = this.extended(toDisk);
    const fromNormalized = normalizeFolder(body.from);
    const toNormalized = normalizeFolder(body.to);
    if (fromNormalized === '') throw new DashboardError('source folder is required', 400);
    if (toNormalized === '') throw new DashboardError('destination folder is required', 400);
    const fromPrefix = `${fromNormalized}/`;
    const toPrefix = `${toNormalized}/`;
    if (toDisk === body.disk && toPrefix.startsWith(fromPrefix)) {
      throw new DashboardError(`cannot ${op} a folder into itself`, 400);
    }
    let cursor: string | undefined;
    do {
      const result = await source.list(fromPrefix, {
        delimiter: '',
        limit: FOLDER_SWEEP_LIMIT,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const entry of result.files) {
        const destKey = `${toPrefix}${entry.key.slice(fromPrefix.length)}`;
        await this.transferKey(op, body.disk, entry.key, toDisk, destKey);
      }
      cursor = result.cursor;
    } while (cursor !== undefined);
    // The marker's key equals the sweep prefix, so the sweep skipped it: write the destination
    // marker, and for a move drop the source one. Idempotent if there was no marker.
    await dest.put(toPrefix, new Uint8Array(0));
    if (op === 'move') await source.delete(fromPrefix);
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
