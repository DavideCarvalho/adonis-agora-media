import type { MediaConversion, MediaRecord } from '../media_record.js';

/**
 * The wire contract between a media control plane (the Hub) and its tenants (the apps). Both sides
 * import it from here, so they cannot drift.
 */

/** The resource indicator (RFC 8707) every media control plane answers for: the `aud` of tenant tokens. */
export const MEDIA_RESOURCE = 'urn:agora:media';

/** What each control-plane endpoint requires in the token's `capabilities`. */
export const MEDIA_SCOPES = {
  /** Read records, their bytes and their URLs (and account files). */
  read: 'media:read',
  /** Add, rename and delete records. */
  write: 'media:write',
} as const;

/** Route prefix of the control-plane API. */
export const DEFAULT_CONTROL_PLANE_PREFIX = '/_media';

/** Where a media topology runs. */
export type MediaTopology = 'standalone' | 'control-plane' | 'tenant';

/** A partition (the tenant app's name, from its token): what an app key may be everywhere. */
export const PARTITION_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,64}$/;
/** An owner type a tenant may use: a model name, no `/`. */
export const OWNER_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** An owner id a tenant may use: a primary key, no `/`, never `.` or `..`. */
export const OWNER_ID_PATTERN = /^[A-Za-z0-9_@:-][A-Za-z0-9_.@:-]{0,127}$/;
/** A collection or conversion name on the wire. */
export const NAME_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * The owner type a tenant's record is stored under on the control plane: `<partition>/<ownerType>`.
 * Every lookup by owner goes through it, so two apps' `User 42` never meet, and the storage keys of
 * an app's files start with `<partition>/`.
 */
export function partitionOwnerType(partition: string, ownerType: string): string {
  return `${partition}/${ownerType}`;
}

/** Whether a stored record belongs to `partition`. */
export function inPartition(partition: string, record: Pick<MediaRecord, 'ownerType'>): boolean {
  return record.ownerType.startsWith(`${partition}/`);
}

/** A stored record as its tenant sees it: the owner type without the partition. */
export function withoutPartition(partition: string, record: MediaRecord): MediaRecord {
  return inPartition(partition, record)
    ? { ...record, ownerType: record.ownerType.slice(partition.length + 1) }
    : record;
}

/** A media record as JSON. */
export interface WireMediaRecord {
  id: string;
  ownerType: string;
  ownerId: string;
  collection: string;
  name: string;
  fileName: string;
  mimeType: string;
  size: number;
  disk: string;
  path: string;
  order: number;
  customProperties: Record<string, unknown>;
  conversions: Record<string, MediaConversion>;
  createdAt: string;
  updatedAt: string;
}

/** A record for the wire. The tenant never sees the control plane's tenant (organization) column. */
export function toWireRecord(record: MediaRecord): WireMediaRecord {
  return {
    id: record.id,
    ownerType: record.ownerType,
    ownerId: record.ownerId,
    collection: record.collection,
    name: record.name,
    fileName: record.fileName,
    mimeType: record.mimeType,
    size: record.size,
    disk: record.disk,
    path: record.path,
    order: record.order,
    customProperties: record.customProperties ?? {},
    conversions: record.conversions ?? {},
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

/** A record from the wire, with its dates revived. Throws on a body that is not a record. */
export function fromWireRecord(value: unknown): MediaRecord {
  const wire = value as Partial<WireMediaRecord> | null;
  if (
    !wire ||
    typeof wire !== 'object' ||
    typeof wire.id !== 'string' ||
    typeof wire.ownerType !== 'string' ||
    typeof wire.ownerId !== 'string' ||
    typeof wire.collection !== 'string' ||
    typeof wire.path !== 'string'
  ) {
    throw new TypeError('the media control plane answered something that is not a media record');
  }
  return {
    id: wire.id,
    ownerType: wire.ownerType,
    ownerId: wire.ownerId,
    collection: wire.collection,
    name: String(wire.name ?? ''),
    fileName: String(wire.fileName ?? ''),
    mimeType: String(wire.mimeType ?? 'application/octet-stream'),
    size: Number(wire.size ?? 0),
    disk: String(wire.disk ?? ''),
    path: wire.path,
    order: Number(wire.order ?? 0),
    customProperties: (wire.customProperties as Record<string, unknown>) ?? {},
    conversions: (wire.conversions as Record<string, MediaConversion>) ?? {},
    createdAt: new Date(String(wire.createdAt)),
    updatedAt: new Date(String(wire.updatedAt)),
  };
}

/**
 * Strong ETag of one rendition of a record: changes with the record (`updatedAt`) and differs per
 * conversion and size.
 */
export function mediaEtag(
  record: Pick<MediaRecord, 'id' | 'updatedAt'>,
  rendition: { conversion?: string | undefined; width?: number | string | undefined } = {},
): string {
  const variant =
    rendition.conversion ?? (rendition.width !== undefined ? `w${rendition.width}` : 'o');
  return `"${record.id}.${variant}.${record.updatedAt.getTime().toString(36)}"`;
}

/** `If-None-Match` matches `etag`? Accepts a list and the weak form. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === '*') return true;
  return ifNoneMatch
    .split(',')
    .map((value) => value.trim().replace(/^W\//, ''))
    .includes(etag);
}

/**
 * Stands for "the URL of this conversion" in a `ResponsiveImage` the control plane computes for a
 * tenant that serves the files itself: the tenant swaps each for its own URL.
 */
export const IMAGE_URL_TOKEN = 'agora-media-url:';
