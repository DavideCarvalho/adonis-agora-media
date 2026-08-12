/**
 * The JSON API contract shared by the dashboard's browser client and its AdonisJS provider routes.
 *
 * These shapes are framework-free (no DOM, no Node) so the same declarations type both the server
 * responses (`DashboardService`) and the SPA's fetch client. They mirror the real
 * `@adonis-agora/media` surface: disk `list`/`stat`/`copy`/`move`/`deleteMany` and the resumable
 * `UploadSessionStore.list()` — never a bespoke server model.
 */

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

export interface DiskListResponse {
  disks: DiskInfo[];
}

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

/** One page of a bucket listing (cursor-based, from the disk `list`). */
export interface ObjectListResponse {
  folders: ObjectFolder[];
  files: ObjectEntry[];
  /** Present only when the page is truncated; pass back as `cursor`. */
  cursor?: string;
}

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
}

export interface UploadListResponse {
  uploads: UploadInfo[];
}

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
}

/** One page of the cross-owner collections listing (cursor-based, from the `MediaStore.list`). */
export interface CollectionListResponse {
  items: MediaEntry[];
  /** Present (non-null) only when a further page exists; pass back as `cursor`. */
  nextCursor: string | null;
}

/** Filters for the collections listing — every field optional and `AND`ed server-side. */
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

export interface CollectionsSummaryResponse {
  collections: CollectionSummary[];
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

/** A signed-in console user, carried by the session cookie and returned by `/me`. */
export interface ConsoleSessionUserInfo {
  id: string;
  name?: string;
  roles: string[];
}

/** Response of `GET /me`: the console SPA renders the login screen or the console from this. */
export type MeResponse = { authRequired: false } | { user: ConsoleSessionUserInfo };

/** Body for `POST /login`. */
export interface LoginBody {
  username: string;
  password: string;
}
