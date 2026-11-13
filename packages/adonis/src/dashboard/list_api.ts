import {
  applyCustomFilter,
  BaseFilter,
  type FilterRequestContext,
  InvalidColumnFilterError,
  parseCursorParams,
  readCursorParams,
  resolveSort,
} from '@adonis-agora/filter';
import { MAX_MEDIA_LIST_LIMIT } from '../media_store.js';
import { DashboardError } from './service.js';
import type { CollectionFilter, CursorParams, UploadFilter } from './types.js';

/**
 * The console's list routes in the `@adonis-agora/filter` wire format: filters as `filter[field]=v`,
 * `sort=` checked against each route's allow-list, cursor paging with `after` / `first`. Each reader
 * turns a request into the arguments of the matching `DashboardService` method, or throws a `400`
 * {@link DashboardError}: an unknown filter field, an unsupported operator, a sort outside the
 * allow-list, a missing required filter or a backward page.
 */

/** Default and largest `first` for `GET /objects` (S3 lists at most 1,000 keys per request). */
export const OBJECTS_PAGE_SIZE = { defaultSize: 1000, maxSize: 1000 } as const;
/** Default and largest `first` for `GET /collections`. */
export const COLLECTIONS_PAGE_SIZE = { defaultSize: 50, maxSize: MAX_MEDIA_LIST_LIMIT } as const;

/** The filters a draft collects: field name to its single value. */
type Draft = Record<string, string>;

/** Read a single string value for an equality filter; `in`-style or dotted spellings are refused. */
function single(value: unknown, operator: string, field: string, name: string): string | undefined {
  if (field !== name) throw new InvalidColumnFilterError(`Unknown filter field: "${field}".`);
  if (operator !== 'equals') {
    throw new InvalidColumnFilterError(`"${name}" does not support the "${operator}" operator.`);
  }
  if (Array.isArray(value)) {
    throw new InvalidColumnFilterError(`"${name}" takes a single value.`);
  }
  if (value === undefined || value === null || value === '') return undefined;
  return String(value);
}

/** Shared body of every console list filter: each method narrows the draft by one field. */
abstract class DraftFilter extends BaseFilter<Draft> {
  declare $query: Draft;

  protected narrow(name: string, value: unknown, operator: string, field: string): void {
    const parsed = single(value, operator, field, name);
    if (parsed !== undefined) this.$query[name] = parsed;
  }
}

/** `GET /objects` filters: `filter[disk]` (required) and `filter[prefix]` (a key prefix). */
export class ObjectListFilter extends DraftFilter {
  disk(value: unknown, operator: string, field: string): void {
    this.narrow('disk', value, operator, field);
  }

  prefix(value: unknown, operator: string, field: string): void {
    this.narrow('prefix', value, operator, field);
  }
}

/** `GET /collections` filters: `filter[collection]`, `filter[ownerType]`, `filter[ownerId]`, `filter[prefix]`. */
export class CollectionListFilter extends DraftFilter {
  collection(value: unknown, operator: string, field: string): void {
    this.narrow('collection', value, operator, field);
  }

  ownerType(value: unknown, operator: string, field: string): void {
    this.narrow('ownerType', value, operator, field);
  }

  ownerId(value: unknown, operator: string, field: string): void {
    this.narrow('ownerId', value, operator, field);
  }

  prefix(value: unknown, operator: string, field: string): void {
    this.narrow('prefix', value, operator, field);
  }
}

/** `GET /uploads` filters: `filter[disk]` and `filter[prefix]` (a key prefix). */
export class UploadListFilter extends DraftFilter {
  disk(value: unknown, operator: string, field: string): void {
    this.narrow('disk', value, operator, field);
  }

  prefix(value: unknown, operator: string, field: string): void {
    this.narrow('prefix', value, operator, field);
  }
}

function queryString(ctx: FilterRequestContext): Record<string, unknown> {
  return ctx.request?.qs?.() ?? {};
}

/**
 * Forward cursor params. The console's listings cannot step backward, so `before` / `last` are a
 * `400` rather than silently read as a forward page.
 */
function forwardCursor(
  qs: Record<string, unknown>,
  size: { defaultSize: number; maxSize: number },
): CursorParams {
  const raw = readCursorParams(qs);
  if (raw.before !== undefined || raw.last !== undefined) {
    throw new DashboardError('this listing pages forward only: send `after` and `first`', 400);
  }
  const { after, size: first } = parseCursorParams(qs, size);
  return { ...(after !== undefined ? { after } : {}), first };
}

/**
 * Check `sort` against a listing whose store has one fixed order: only that order (`field` in
 * `direction`) is accepted, so a client never gets rows in an order it did not ask for.
 */
function fixedSort(sort: unknown, field: string, direction: 'asc' | 'desc'): void {
  const resolved = resolveSort(sort as string | undefined, {
    sortable: [field],
    default: [{ field, direction }],
  });
  if (resolved.length !== 1 || resolved[0]?.direction !== direction) {
    const spelled = direction === 'desc' ? `-${field}` : field;
    throw new InvalidColumnFilterError(`This listing can only be sorted by "${spelled}".`);
  }
}

/** Run `read`, turning the filter lib's refusals into the console's `400`. */
async function badRequestOnInvalid<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof InvalidColumnFilterError) throw new DashboardError(error.message, 400);
    throw error;
  }
}

/** `GET /objects` → `DashboardService.objects(disk, params)`. Sort: `key` only (the store's order). */
export function readObjectsQuery(
  ctx: FilterRequestContext,
): Promise<{ disk: string; params: CursorParams & { prefix?: string } }> {
  return badRequestOnInvalid(() => objectsQuery(ctx));
}

async function objectsQuery(
  ctx: FilterRequestContext,
): Promise<{ disk: string; params: CursorParams & { prefix?: string } }> {
  const qs = queryString(ctx);
  const draft: Draft = {};
  await applyCustomFilter(draft, ObjectListFilter, ctx);
  fixedSort(qs.sort, 'key', 'asc');
  const { disk, prefix } = draft;
  if (disk === undefined) throw new DashboardError('filter[disk] is required', 400);
  return {
    disk,
    params: {
      ...(prefix !== undefined ? { prefix } : {}),
      ...forwardCursor(qs, OBJECTS_PAGE_SIZE),
    },
  };
}

/** `GET /collections` → `DashboardService.collections(params)`. Sort: `-createdAt` only (newest first). */
export function readCollectionsQuery(
  ctx: FilterRequestContext,
): Promise<CollectionFilter & CursorParams> {
  return badRequestOnInvalid(() => collectionsQuery(ctx));
}

async function collectionsQuery(
  ctx: FilterRequestContext,
): Promise<CollectionFilter & CursorParams> {
  const qs = queryString(ctx);
  const draft: Draft = {};
  await applyCustomFilter(draft, CollectionListFilter, ctx);
  fixedSort(qs.sort, 'createdAt', 'desc');
  return { ...(draft as CollectionFilter), ...forwardCursor(qs, COLLECTIONS_PAGE_SIZE) };
}

/** `GET /uploads` → `DashboardService.uploads(filter)`. Sort: `createdAt` either way, `-createdAt` by default. */
export function readUploadsQuery(
  ctx: FilterRequestContext,
): Promise<UploadFilter & { order: 'asc' | 'desc' }> {
  return badRequestOnInvalid(() => uploadsQuery(ctx));
}

async function uploadsQuery(
  ctx: FilterRequestContext,
): Promise<UploadFilter & { order: 'asc' | 'desc' }> {
  const qs = queryString(ctx);
  const draft: Draft = {};
  await applyCustomFilter(draft, UploadListFilter, ctx);
  const [sort] = resolveSort(qs.sort as string | undefined, {
    sortable: ['createdAt'],
    default: '-createdAt',
  });
  return { ...(draft as UploadFilter), order: sort?.direction ?? 'desc' };
}
