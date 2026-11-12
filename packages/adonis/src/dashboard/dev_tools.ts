import type { HttpContext } from '@adonisjs/core/http';
import type { DashboardService } from './service.js';

/*
 * The dev-tools registration contract, version 1, declared here STRUCTURALLY: the hub is bound at
 * `'agora.devTools'` by `@adonis-agora/agent/mcp_provider` when the app has it, and this package
 * never imports the agent (it stays an optional, undeclared peer). Same shapes as
 * `@adonis-agora/agent/dev-tools`.
 */

/** The container binding the dev-tools hub lives at. */
export const DEV_TOOLS_BINDING = 'agora.devTools';

/** The hub a lib registers its developer tools into. */
export interface DevToolsHub {
  readonly version: 1;
  register(lib: DevToolsLib): void;
}

/** One lib's tools and the gate that decides who may use them. */
export interface DevToolsLib {
  lib: string;
  title: string;
  authorize(ctx: HttpContext): Promise<DevToolsDecision>;
  tools: DevTool[];
}

/** What a lib's `authorize` answers: the console decision. */
export type DevToolsDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden'; redirectTo?: string };

/** One developer tool. */
export interface DevTool {
  name: string;
  kind: 'read' | 'action';
  description: string;
  input: DevToolInputSchema;
  destructive?: boolean;
  available?(): boolean | Promise<boolean>;
  run(input: Record<string, unknown>, call: DevToolCall): Promise<unknown>;
}

/** What a tool's `run` receives besides its input. */
export interface DevToolCall {
  ctx: HttpContext;
  caller: DevToolsCaller;
  limits: { maxRows: number; maxBytes: number };
}

/** Who is calling. Never a token value. */
export interface DevToolsCaller {
  id: string;
  via: 'token' | 'session' | 'open';
}

/** One property of a {@link DevToolInputSchema}. */
export interface DevToolInputProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  description?: string;
  enum?: readonly string[];
  items?: { type: 'string' };
  minimum?: number;
  maximum?: number;
}

/** An object of scalar / enum / array-of-string properties. */
export interface DevToolInputSchema {
  type: 'object';
  properties: Record<string, DevToolInputProperty>;
  required?: string[];
}

/** What {@link mediaDevTools} needs from the console. */
export interface MediaDevToolsOptions {
  /**
   * The console's service, built per call for the request being served (the same one the console's
   * JSON API uses, so its disk list and `actions` switch apply).
   */
  service: (ctx: HttpContext) => Promise<DashboardService>;
  /** Whether the console's mutating actions are on (`actions` in `config/media_dashboard.ts`). */
  actions: boolean;
}

/** List tools default to this many rows. */
const DEFAULT_LIMIT = 20;
/** List tools return at most this many rows. */
const MAX_LIMIT = 100;
/** `media_delete_objects` deletes at most this many keys per call. */
export const MAX_DELETE_KEYS = 100;

/** Thrown from a tool to answer an MCP error result (the agent turns it into `isError`). */
class DevToolError extends Error {}

function str(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function required(input: Record<string, unknown>, key: string): string {
  const value = str(input, key);
  if (value === undefined) throw new DevToolError(`${key} is required`);
  return value;
}

function limitOf(input: Record<string, unknown>): number {
  const raw = input.limit;
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

/** A service error (unknown disk, missing record…) becomes the tool's error message. */
async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new DevToolError(error instanceof Error ? error.message : String(error));
  }
}

const LIMIT_PROPERTY: DevToolInputProperty = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_LIMIT,
  description: `Rows per page (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`,
};

const CURSOR_PROPERTY: DevToolInputProperty = {
  type: 'string',
  description: 'The `next` of the previous page.',
};

/**
 * The media console's developer tools: the same {@link DashboardService} the console's JSON API runs,
 * under `media_*` names. Signed URLs never leave: object and record reads drop every `url`. Reads
 * are listed by default; the two actions (abort an upload, delete objects) only when the app opts in
 * on the dev endpoint AND the console's own `actions` switch is on.
 */
export function mediaDevTools(options: MediaDevToolsOptions): DevTool[] {
  const actionsOn = () => options.actions;

  return [
    {
      name: 'media_list_disks',
      kind: 'read',
      description:
        'List the disks the media console may browse, with which one is the default and what each supports (list, presign, multipart, public URLs). Returns { items }.',
      input: { type: 'object', properties: {} },
      run: async (_input, call) => {
        const svc = await options.service(call.ctx);
        return { items: svc.disks().disks };
      },
    },
    {
      name: 'media_list_objects',
      kind: 'read',
      description:
        'List one page of a disk under a prefix, folders rolled up on "/": each item is a folder ({ type: "folder", name, prefix }) or a file ({ type: "file", key, name, sizeBytes, lastModified }). Paged: pass `next` back as `cursor`. Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          disk: { type: 'string', description: 'Disk name (see media_list_disks).' },
          prefix: { type: 'string', description: 'Key prefix, e.g. "User/42/" (default: root).' },
          cursor: CURSOR_PROPERTY,
          limit: LIMIT_PROPERTY,
        },
        required: ['disk'],
      },
      run: async (input, call) => {
        const disk = required(input, 'disk');
        const prefix = str(input, 'prefix');
        const cursor = str(input, 'cursor');
        const svc = await options.service(call.ctx);
        const page = await guarded(() =>
          svc.objects(disk, {
            ...(prefix !== undefined ? { prefix } : {}),
            ...(cursor !== undefined ? { after: cursor } : {}),
            first: limitOf(input),
          }),
        );
        return {
          items: [
            ...page.folders.map((folder) => ({ type: 'folder', ...folder })),
            ...page.files.map((file) => ({ type: 'file', ...file })),
          ],
          next: page.nextCursor,
        };
      },
    },
    {
      name: 'media_get_object',
      kind: 'read',
      description:
        'One object on a disk: size, content type, last modified, plus what the app knows about it (object insights). No URL is returned. Returns { object, insights }.',
      input: {
        type: 'object',
        properties: {
          disk: { type: 'string', description: 'Disk name.' },
          key: { type: 'string', description: 'Full object key.' },
        },
        required: ['disk', 'key'],
      },
      run: async (input, call) => {
        const disk = required(input, 'disk');
        const key = required(input, 'key');
        const svc = await options.service(call.ctx);
        const object = await guarded(() => svc.objectMeta(disk, key));
        const insights = await guarded(() => svc.objectInsights(disk, key));
        return { object, insights: insights.insights };
      },
    },
    {
      name: 'media_list_uploads',
      kind: 'read',
      description:
        'Resumable (TUS) uploads in progress: id, disk, key, bytes received, size, percent, parts. Empty when resumable uploads are not configured. Returns { items }.',
      input: {
        type: 'object',
        properties: {
          disk: { type: 'string', description: 'Only uploads to this disk.' },
          prefix: { type: 'string', description: 'Only uploads whose key starts with this.' },
        },
      },
      run: async (input, call) => {
        const disk = str(input, 'disk');
        const prefix = str(input, 'prefix');
        const svc = await options.service(call.ctx);
        const result = await guarded(() =>
          svc.uploads({
            ...(disk !== undefined ? { disk } : {}),
            ...(prefix !== undefined ? { prefix } : {}),
          }),
        );
        return { items: result.uploads };
      },
    },
    {
      name: 'media_get_upload',
      kind: 'read',
      description:
        'One resumable upload in progress with its recorded parts (part number and ETag). Returns { upload, parts }.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Upload session id.' } },
        required: ['id'],
      },
      run: async (input, call) => {
        const id = required(input, 'id');
        const svc = await options.service(call.ctx);
        return guarded(() => svc.uploadDetail(id));
      },
    },
    {
      name: 'media_list_collections',
      kind: 'read',
      description:
        'Stored media records across owners, newest first: id, owner type and id, collection, name, file name, MIME type, size, disk, path, generated conversions, times. Filters: collection, ownerType, ownerId, prefix (of the stored path). Paged: pass `next` back as `cursor`. Returns { items, next }.',
      input: {
        type: 'object',
        properties: {
          collection: { type: 'string', description: 'Collection name.' },
          ownerType: { type: 'string', description: 'Owner type, e.g. "User".' },
          ownerId: { type: 'string', description: 'Owner id (usually with ownerType).' },
          prefix: { type: 'string', description: 'Stored path prefix.' },
          cursor: CURSOR_PROPERTY,
          limit: LIMIT_PROPERTY,
        },
      },
      run: async (input, call) => {
        const filters: Record<string, string> = {};
        for (const key of ['collection', 'ownerType', 'ownerId', 'prefix'] as const) {
          const value = str(input, key);
          if (value !== undefined) filters[key] = value;
        }
        const cursor = str(input, 'cursor');
        const svc = await options.service(call.ctx);
        const page = await guarded(() =>
          svc.collections({
            ...filters,
            ...(cursor !== undefined ? { after: cursor } : {}),
            first: limitOf(input),
          }),
        );
        return { items: page.items, next: page.nextCursor };
      },
    },
    {
      name: 'media_get_collections_summary',
      kind: 'read',
      description:
        'Record count and total bytes per collection. Returns { items: [{ key, count, sumSize }] }.',
      input: { type: 'object', properties: {} },
      run: async (_input, call) => {
        const svc = await options.service(call.ctx);
        const summary = await guarded(() => svc.collectionsSummary());
        return { items: summary.collections };
      },
    },
    {
      name: 'media_get_media',
      kind: 'read',
      description:
        'One stored media record by id: owner, collection, name, file name, MIME type, size, disk, path, the names of its generated conversions, times. No URLs. Returns { record }.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Media record id.' } },
        required: ['id'],
      },
      run: async (input, call) => {
        const id = required(input, 'id');
        const svc = await options.service(call.ctx);
        return { record: await guarded(() => svc.mediaEntry(id)) };
      },
    },
    {
      name: 'media_abort_upload',
      kind: 'action',
      destructive: true,
      description:
        'Cancel a resumable upload in progress: discards its parts and drops the session. Returns { ok }.',
      input: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Upload session id.' } },
        required: ['id'],
      },
      available: actionsOn,
      run: async (input, call) => {
        const id = required(input, 'id');
        const svc = await options.service(call.ctx);
        await guarded(() => svc.abortUpload(id));
        return { ok: true };
      },
    },
    {
      name: 'media_delete_objects',
      kind: 'action',
      destructive: true,
      description: `Delete objects from a disk, by full key (at most ${MAX_DELETE_KEYS} per call). Deletes the bytes only: media records pointing at them are left as they are. Returns { deleted }.`,
      input: {
        type: 'object',
        properties: {
          disk: { type: 'string', description: 'Disk name.' },
          keys: { type: 'array', items: { type: 'string' }, description: 'Full object keys.' },
        },
        required: ['disk', 'keys'],
      },
      available: actionsOn,
      run: async (input, call) => {
        const disk = required(input, 'disk');
        const keys = Array.isArray(input.keys)
          ? input.keys.filter((key): key is string => typeof key === 'string' && key !== '')
          : [];
        if (keys.length === 0) throw new DevToolError('keys is required');
        if (keys.length > MAX_DELETE_KEYS) {
          throw new DevToolError(`at most ${MAX_DELETE_KEYS} keys per call`);
        }
        const svc = await options.service(call.ctx);
        await guarded(() => svc.remove({ disk, keys }));
        return { deleted: keys.length };
      },
    },
  ];
}

/**
 * Register the media console's tools into the app's dev-tools hub, when one is bound (the app
 * registered `@adonis-agora/agent/mcp_provider`). Returns whether it registered.
 */
export async function registerMediaDevTools(
  container: {
    hasBinding(binding: string): boolean;
    make(binding: string): Promise<unknown>;
  },
  options: MediaDevToolsOptions & {
    authorize: (ctx: HttpContext) => Promise<DevToolsDecision>;
  },
): Promise<boolean> {
  if (typeof container.hasBinding !== 'function' || !container.hasBinding(DEV_TOOLS_BINDING)) {
    return false;
  }
  const hub = (await container.make(DEV_TOOLS_BINDING)) as Partial<DevToolsHub> | undefined;
  if (hub?.version !== 1 || typeof hub.register !== 'function') return false;
  hub.register({
    lib: 'media',
    title: 'Media library',
    authorize: options.authorize,
    tools: mediaDevTools(options),
  });
  return true;
}
