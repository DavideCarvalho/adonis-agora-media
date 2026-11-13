/**
 * The JSON API contract shared by the dashboard's browser client and its AdonisJS provider routes.
 *
 * These shapes are framework-free (no DOM, no Node) so the same declarations type both the server
 * responses (`DashboardService`) and the SPA's fetch client. They mirror the real
 * `@adonis-agora/media` surface: disk `list`/`stat`/`copy`/`move`/`deleteMany` and the resumable
 * `UploadSessionStore.list()` — never a bespoke server model.
 */

/**
 * Cursor paging input of the console's paginated listings (`objects`, `collections`): `after` is a
 * previous page's `meta.nextCursor`, `first` the page size. On the wire these are the `after` /
 * `first` query params of the `@adonis-agora/filter` list format.
 *
 * Forward-only: the listings are backed by S3's `ListObjectsV2` continuation token and by the media
 * store's newest-first keyset, neither of which can step backward. The routes answer `400` to
 * `before` / `last`.
 */
export interface CursorParams {
  /** Opaque cursor from a previous page's `meta.nextCursor`; omit for the first page. */
  after?: string;
  /** Page size. */
  first?: number;
}

/**
 * The `meta` of a cursor page, field for field `@adonis-agora/filter`'s `CursorPageMeta`. The
 * console's listings page forward only, so `prevCursor` is always `null` and `hasPrev` `false`.
 */
export interface CursorPageMeta {
  /** Opaque cursor for the next page (send it as `after`), or `null` on the last page. */
  nextCursor: string | null;
  prevCursor: string | null;
  hasNext: boolean;
  hasPrev: boolean;
}

/** A cursor-paged list response: `{ data, meta }`, as `@adonis-agora/filter`'s `CursorPageResponse<T>`. */
export interface CursorPageResponse<T> {
  data: T[];
  meta: CursorPageMeta;
}

/** A small list that is not paged (disks, collection totals, uploads in progress): `{ data }`. */
export interface ListResponse<T> {
  data: T[];
}

/** Coarse capability descriptor for a disk, mirroring `@adonis-agora/media`'s `DiskCapabilities`. */
export interface DiskCapabilities {
  presign: boolean;
  multipart: boolean;
  publicUrls: boolean;
  /** Can enumerate keys under a prefix — only such disks are browsable in the console. */
  list: boolean;
}

/** One disk (bucket) exposed to the console. */
export interface DiskInfo {
  name: string;
  /** Whether this is the manager's default disk. */
  default: boolean;
  capabilities: DiskCapabilities;
}

/** `GET /disks`. */
export type DiskListResponse = ListResponse<DiskInfo>;

/** A sub-folder under the browsed prefix (a `CommonPrefix`; `prefix` carries the trailing slash). */
export interface ObjectFolder {
  name: string;
  prefix: string;
}

/** A file entry directly under the browsed prefix. */
export interface ObjectEntry {
  key: string;
  name: string;
  sizeBytes: number | null;
  /** ISO-8601 string, or null when the backend does not report it. */
  lastModified: string | null;
}

/** One row of a bucket listing: a folder (common prefix) or a file, told apart by `type`. */
export type ObjectListItem = ({ type: 'folder' } & ObjectFolder) | ({ type: 'file' } & ObjectEntry);

/**
 * `GET /objects`: one page of a bucket listing, folders first, then files, in key order. Folders and
 * files share one page because S3 returns both from the same request.
 */
export type ObjectListResponse = CursorPageResponse<ObjectListItem>;

/** Object metadata plus a short-lived signed URL for preview/download. */
export interface ObjectDetailResponse {
  key: string;
  size: number;
  contentType?: string;
  lastModified?: string;
  url: string;
}

/** An in-progress resumable upload session, projected from `UploadSession`. */
export interface UploadInfo {
  id: string;
  disk: string;
  key: string;
  offset: number;
  size: number | null;
  /** 0..100, or null when the total size is unknown. */
  percent: number | null;
  parts: number;
  multipart: boolean;
  createdAt?: string;
  /** The organization (tenant) of the upload, when the app turned tenancy on (`null`: none). */
  tenantId?: string | null;
}

/** `GET /uploads`: resumable uploads in progress. */
export type UploadListResponse = ListResponse<UploadInfo>;

/** A stored media-library record, projected from `@adonis-agora/media`'s `MediaRecord` for the console. */
export interface MediaEntry {
  id: string;
  ownerType: string;
  ownerId: string;
  collection: string;
  /** Logical display name. */
  name: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  disk: string;
  path: string;
  /** Names of the generated conversions present on the record (e.g. `["thumb"]`). */
  conversions: string[];
  createdAt: string;
  updatedAt: string;
  /** The organization (tenant) of the file, when the app turned tenancy on (`null`: none). */
  tenantId?: string | null;
}

/** `GET /collections`: one page of stored media records, newest first. */
export type CollectionListResponse = CursorPageResponse<MediaEntry>;

/** Filters for the collections listing (`filter[collection]` …), every field optional and `AND`ed. */
export interface CollectionFilter {
  collection?: string;
  ownerType?: string;
  ownerId?: string;
  prefix?: string;
}

/** Coarse console topology used to enable/disable UI affordances. */
export interface Topology {
  disks: number;
  hasUploads: boolean;
  /** Whether mutating actions (copy/move/delete) are enabled on this console. */
  actions: boolean;
}

/** Body for the copy/move actions — `toDisk` defaults to the source disk (same-bucket). */
export interface CopyMoveBody {
  disk: string;
  from: string;
  to: string;
  toDisk?: string;
}

/** Body for the batched delete action. */
export interface DeleteBody {
  disk: string;
  keys: string[];
}

/** Body for the folder create/delete actions — a disk and the folder prefix. */
export interface FolderBody {
  disk: string;
  prefix: string;
}

/** One resumable part recorded for an in-progress upload session. */
export interface UploadPart {
  partNumber: number;
  etag: string;
}

/** Full detail of one resumable upload session, plus its recorded parts. */
export interface UploadDetailResponse {
  upload: UploadInfo;
  parts: UploadPart[];
}

/** One generated conversion/variant of a stored `MediaRecord`, with a short-lived signed URL. */
export interface MediaVariant {
  name: string;
  url: string;
}

/** Full detail of one stored `MediaRecord`, plus its generated conversions. */
export interface MediaDetailResponse {
  record: MediaEntry;
  variants: MediaVariant[];
}

/** Per-collection rollup (count + total bytes), for the console's collection chips. */
export interface CollectionSummary {
  key: string;
  count: number;
  sumSize: number;
}

/** `GET /collections/summary`. */
export type CollectionsSummaryResponse = ListResponse<CollectionSummary>;

/** Filters for the uploads listing (`filter[disk]`, `filter[prefix]`), both optional. */
export interface UploadFilter {
  disk?: string;
  prefix?: string;
}

/** One label/value row of an {@link ObjectInsight}. Rendered verbatim as text — no markup. */
export interface ObjectInsightFact {
  label: string;
  value: string;
}

/** A link out to the host's own screens, rendered as an anchor. */
export interface ObjectInsightLink {
  label: string;
  href: string;
}

/**
 * Host-supplied context about one disk object, rendered in the console preview.
 *
 * The console can describe a file only as storage sees it (key, size, type). This is what the HOST
 * knows about it — which knowledge base indexed it, which work order it belongs to — handed over as
 * data, because the console ships as a prebuilt bundle a host cannot inject components into.
 */
export interface ObjectInsight {
  /** Section heading, e.g. `Knowledge base`. */
  title: string;
  facts?: ObjectInsightFact[];
  links?: ObjectInsightLink[];
  /** One line of prose under the facts — a caveat, a status explanation. */
  note?: string;
}

/** What `GET /object/insights` returns. Empty when the host registered no providers. */
export interface ObjectInsightsResponse {
  insights: ObjectInsight[];
}

/** The console's "Organization" control (`GET /tenants`). */
export interface TenantPickerResponse {
  /** `off`: tenancy off. `none`: the viewer has no organization. `fixed`: one. `pick`: several. */
  mode: 'off' | 'none' | 'fixed' | 'pick';
  /** The viewer may see every organization (and "All organizations" is offered). */
  all: boolean;
  selected: string | null;
  tenants: Array<{ id: string; label: string }>;
}
