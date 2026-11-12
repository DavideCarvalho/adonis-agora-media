import { type MediaAuthorizer, type MediaSubject, toAuthorizer } from '../access.js';
import {
  inScope,
  type ResolvedMediaTenancy,
  scopeIds,
  type TenantScope,
  withTenant,
} from '../agora/tenancy.js';
import type { MediaCollectionRegistry } from '../media_collection.js';
import type { MediaRecord } from '../media_record.js';
import type { MediaListPage, MediaOwnerPageOptions } from '../media_store.js';
import type {
  AccountAction,
  AccountActionResult,
  AccountExtension,
  AccountExtensionContext,
  AccountPage,
  Block,
  ListItem,
  Text,
} from './contract.js';
import { ACCOUNT_MESSAGES, message } from './messages.js';
import { issueUploadTicket } from './upload_ticket.js';

/** One collection on the "My files" page, with the operations it offers (all on by default). */
export interface MediaAccountCollection {
  /** The collection name (as in `config/media.ts` `collections`). */
  name: string;
  /** Tab label. Default: the collection name. */
  label?: string;
  /** Offer uploads into it. Default `true` (still needs the collection's `access.write`). */
  upload?: boolean;
  /** Offer renaming its files. Default `true` (needs `access.write`). */
  rename?: boolean;
  /** Offer deleting its files (confirmed, after re-authentication). Default `true` (needs `access.write`). */
  delete?: boolean;
  /** Offer downloads (short-lived signed URLs). Default `true` (needs `access.read`). */
  download?: boolean;
}

/** `config/media.ts` → `accountConsole`: media's "My files" page in the authkit account console. */
export interface MediaAccountConsoleOptions {
  /**
   * The collections the page shows. Nothing is exposed until you list one. Each listed collection
   * gets browse, upload, rename, delete and download, each allowed by that collection's own
   * `access` rules (`read` for browse and download, `write` for the rest).
   */
  collections: ReadonlyArray<string | MediaAccountCollection>;
  /**
   * Who owns "my" files. Default: the app user authkit mapped the account to (`subject`), else
   * `{ type: 'User', id: account.id }`.
   */
  owner?: (
    ctx: AccountExtensionContext,
  ) => { type: string; id: string } | Promise<{ type: string; id: string }>;
  /** Files per page. Default 20. */
  pageSize?: number;
  /** Lifetime of a download link, in seconds. Default 300. */
  downloadTtlSeconds?: number;
  /** Largest upload accepted, in bytes. Default 50 MiB. */
  maxUploadBytes?: number;
  /** Where the upload endpoint and its script are mounted. Default `/media/account`. */
  path?: string;
  /**
   * This app's public https URL, when its pages are shown by an IdP running in another app
   * (authkit-client `accountConsole.remote`): the upload script, the upload endpoint and download
   * links then point here.
   */
  publicUrl?: string;
}

/** The media manager slice the page reads and acts through. */
export interface MediaAccountManager {
  readonly tenancy: ResolvedMediaTenancy;
  readonly library: {
    readonly collections: MediaCollectionRegistry;
    find(id: string): Promise<MediaRecord | null>;
    page(
      ownerType: string,
      ownerId: string,
      options?: MediaOwnerPageOptions,
    ): Promise<MediaListPage>;
    rename(id: string, name: string): Promise<MediaRecord>;
    delete(id: string): Promise<void>;
    signedUrl(
      id: string,
      expiresIn: string | number,
      options?: { contentDisposition?: string },
    ): Promise<string>;
  };
}

/** What {@link mediaAccountExtension} needs. */
export interface MediaAccountDeps {
  media: () => Promise<MediaAccountManager>;
  options: MediaAccountConsoleOptions;
  /** HMAC secret for upload tickets. */
  secret: string;
  now?: () => number;
}

/** The longest display name a rename accepts (the `name` column is `VARCHAR(255)`). */
const MAX_NAME_LENGTH = 255;

/** Defaults. */
export const ACCOUNT_DEFAULTS = {
  pageSize: 20,
  downloadTtlSeconds: 300,
  maxUploadBytes: 50 * 1024 * 1024,
  path: '/media/account',
  ticketTtlMs: 15 * 60 * 1000,
} as const;

/** The listed collections, normalized (duplicates dropped). */
export function accountCollections(options: MediaAccountConsoleOptions): MediaAccountCollection[] {
  const seen = new Set<string>();
  const out: MediaAccountCollection[] = [];
  for (const entry of options.collections ?? []) {
    const collection = typeof entry === 'string' ? { name: entry } : entry;
    if (!collection?.name || seen.has(collection.name)) continue;
    seen.add(collection.name);
    out.push(collection);
  }
  return out;
}

/** The mount path of the upload endpoint (no trailing slash). */
export function accountPath(options: MediaAccountConsoleOptions): string {
  const path = `/${options.path ?? ACCOUNT_DEFAULTS.path}`.replace(/\/+/g, '/').replace(/\/+$/, '');
  return path === '' ? '/media/account' : path;
}

const NOT_FOUND: AccountActionResult = {
  ok: false,
  error: { key: 'media.files.not_found' },
  status: 404,
};
const FORBIDDEN: AccountActionResult = {
  ok: false,
  error: { key: 'media.files.forbidden' },
  status: 403,
};

/** The tenant the account console request acts in, when media's tenancy is on. */
function accountTenant(
  tenancy: ResolvedMediaTenancy,
  ctx: AccountExtensionContext,
): { id: string; kind: string } | null {
  const tenant =
    ctx.tenant ?? (ctx.activeOrg ? { id: ctx.activeOrg.id, kind: 'organization' } : null);
  if (!tenant) return null;
  if (tenancy.kinds !== undefined && !tenancy.kinds.includes(tenant.kind)) return null;
  return { id: tenant.id, kind: tenant.kind };
}

/** The read scope of the request (`undefined` with tenancy off). */
function accountScope(
  tenancy: ResolvedMediaTenancy,
  ctx: AccountExtensionContext,
): TenantScope | undefined {
  if (!tenancy.enabled) return undefined;
  const tenant = accountTenant(tenancy, ctx);
  return tenant
    ? { tenants: [tenant.id], includeNull: tenancy.nullRows === 'shared' }
    : { tenants: [], includeNull: true };
}

/** `Content-Disposition` for a download, with the file name RFC 6266-encoded. */
function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/**
 * Media's "My files" page for the authkit account console (`/account/files`): the signed-in
 * user's files in the collections the app listed, with upload, rename, delete and download, each
 * gated by that collection's own `access` rules. Every action re-checks ownership from the account
 * (a file that is not theirs answers not found).
 */
export function mediaAccountExtension(deps: MediaAccountDeps): AccountExtension {
  const { options } = deps;
  const collections = accountCollections(options);
  const byName = new Map(collections.map((c) => [c.name, c]));
  const pageSize = Math.max(1, Math.min(100, options.pageSize ?? ACCOUNT_DEFAULTS.pageSize));
  const now = deps.now ?? Date.now;
  const base = accountPath(options);
  const publicUrl = options.publicUrl?.replace(/\/+$/, '');
  const absolute = (path: string) => (publicUrl ? `${publicUrl}${path}` : path);
  const scriptOrigins = publicUrl ? [new URL(publicUrl).origin] : [];

  const owner = async (ctx: AccountExtensionContext) =>
    options.owner
      ? await options.owner(ctx)
      : (ctx.subject ?? { type: 'User', id: ctx.account.id });

  const subjectOf = (
    ctx: AccountExtensionContext,
    who: { type: string; id: string },
    tenancy: ResolvedMediaTenancy,
  ): MediaSubject => ({
    id: who.id,
    type: who.type,
    realId: ctx.account.id,
    roles: ctx.account.roles,
    tenantId: tenancy.enabled ? (accountTenant(tenancy, ctx)?.id ?? null) : null,
  });

  const rule = (
    registry: MediaCollectionRegistry,
    collection: string,
    action: 'read' | 'write',
  ): MediaAuthorizer => toAuthorizer(registry.get(collection).access?.[action]);

  /** Run `fn` as the account's tenant (stamps, single-file replace, reads), through context. */
  const asTenant = <T>(
    tenancy: ResolvedMediaTenancy,
    ctx: AccountExtensionContext,
    fn: () => Promise<T>,
  ): Promise<T> => (tenancy.enabled ? withTenant(accountTenant(tenancy, ctx), fn) : fn());

  const may = async (
    media: MediaAccountManager,
    ctx: AccountExtensionContext,
    who: { type: string; id: string },
    action: 'read' | 'write',
    collection: string,
    record?: MediaRecord,
  ): Promise<boolean> => {
    try {
      return await rule(
        media.library.collections,
        collection,
        action,
      )({
        ctx,
        action,
        collection,
        record,
        subject: subjectOf(ctx, who, media.tenancy),
      });
    } catch {
      return false;
    }
  };

  /** The account's own file in a listed collection, or `null` (not theirs reads as missing). */
  const ownFile = async (
    media: MediaAccountManager,
    ctx: AccountExtensionContext,
    id: string | null,
    access: 'read' | 'write' = 'read',
  ): Promise<{ record: MediaRecord; who: { type: string; id: string } } | null> => {
    if (!id) return null;
    const who = await owner(ctx);
    const record = await asTenant(media.tenancy, ctx, () => media.library.find(id));
    if (!record || !byName.has(record.collection)) return null;
    if (record.ownerType !== who.type || String(record.ownerId) !== String(who.id)) return null;
    if (!inScope(accountScope(media.tenancy, ctx), record.tenantId)) return null;
    if (!(await may(media, ctx, who, access, record.collection, record))) return null;
    return { record, who };
  };

  const downloadHref = async (
    media: MediaAccountManager,
    ctx: AccountExtensionContext,
    record: MediaRecord,
  ): Promise<Pick<ListItem, 'href' | 'external'>> => {
    try {
      const url = await asTenant(media.tenancy, ctx, () =>
        media.library.signedUrl(
          record.id,
          options.downloadTtlSeconds ?? ACCOUNT_DEFAULTS.downloadTtlSeconds,
          { contentDisposition: attachment(record.fileName) },
        ),
      );
      if (url.startsWith('https://')) return { href: url, external: true };
      if (url.startsWith('/') && !url.startsWith('//')) {
        return publicUrl ? { href: absolute(url), external: true } : { href: url };
      }
    } catch {
      // A disk that cannot sign: no download link.
    }
    return {};
  };

  const actions: Record<string, AccountAction> = {
    rename: {
      label: { key: 'media.files.rename' },
      fields: [
        {
          name: 'name',
          label: { key: 'media.files.rename_field' },
          kind: 'text',
          required: true,
          maxLength: MAX_NAME_LENGTH,
        },
      ],
      async handle(ctx, input) {
        const media = await deps.media();
        const found = await ownFile(media, ctx, input.target);
        if (!found) return NOT_FOUND;
        const { record, who } = found;
        if (byName.get(record.collection)?.rename === false) return FORBIDDEN;
        if (!(await may(media, ctx, who, 'write', record.collection, record))) return FORBIDDEN;
        const name = (input.fields.name ?? '').trim();
        if (name === '') {
          return { ok: false, error: { key: 'media.files.name_required' }, status: 400 };
        }
        if (name.length > MAX_NAME_LENGTH) {
          return { ok: false, error: { key: 'media.files.name_too_long' }, status: 400 };
        }
        await asTenant(media.tenancy, ctx, () => media.library.rename(record.id, name));
        return { ok: true, flash: { key: 'media.files.renamed' } };
      },
    },
    delete: {
      label: { key: 'media.files.delete' },
      tone: 'danger',
      confirm: { key: 'media.files.delete_confirm' },
      sudo: true,
      async handle(ctx, input) {
        if (ctx.impersonatedBy !== null) return FORBIDDEN;
        const media = await deps.media();
        const found = await ownFile(media, ctx, input.target);
        if (!found) return NOT_FOUND;
        const { record, who } = found;
        if (byName.get(record.collection)?.delete === false) return FORBIDDEN;
        if (!(await may(media, ctx, who, 'write', record.collection, record))) return FORBIDDEN;
        await asTenant(media.tenancy, ctx, () => media.library.delete(record.id));
        return { ok: true, flash: { key: 'media.files.deleted' } };
      },
    },
    upload: {
      label: { key: 'media.files.upload' },
      fields: [
        { name: 'media', label: { key: 'media.files.upload' }, kind: 'text', maxLength: 255 },
      ],
      async handle(ctx, input) {
        // The file is already stored by the upload endpoint (under a ticket issued to this account);
        // this confirms it belongs to the account before saying so.
        const media = await deps.media();
        // Checked against `write`, the rule the upload ticket was issued under.
        const found = await ownFile(media, ctx, input.fields.media || input.target, 'write');
        if (!found) return NOT_FOUND;
        return { ok: true, flash: { key: 'media.files.uploaded' } };
      },
    },
  };

  const page: AccountPage = {
    id: 'media.files',
    segment: 'files',
    title: { key: 'media.files.title' },
    nav: { label: { key: 'media.files.nav' }, group: 'content', order: 100 },
    async visible(ctx) {
      if (collections.length === 0) return false;
      const media = await deps.media();
      const who = await owner(ctx);
      for (const collection of collections) {
        if (collection.upload !== false && (await may(media, ctx, who, 'write', collection.name))) {
          return true;
        }
      }
      const scope = accountScope(media.tenancy, ctx);
      const first = await asTenant(media.tenancy, ctx, () =>
        media.library.page(who.type, who.id, {
          collections: collections.map((c) => c.name),
          limit: 1,
          ...(scope !== undefined ? { tenantIds: scopeIds(scope) ?? [] } : {}),
        }),
      );
      return first.items.length > 0;
    },
    async load(ctx) {
      const media = await deps.media();
      const who = await owner(ctx);
      const active = (ctx.query.tab && byName.get(ctx.query.tab)) || collections[0];
      if (!active) return { blocks: [] };
      const scope = accountScope(media.tenancy, ctx);
      const blocks: Block[] = [];

      if (active.upload !== false && (await may(media, ctx, who, 'write', active.name))) {
        const accepts = media.library.collections.get(active.name).acceptsMimeTypes;
        const tenant = media.tenancy.enabled ? accountTenant(media.tenancy, ctx) : undefined;
        const ticket = issueUploadTicket(deps.secret, {
          ownerType: who.type,
          ownerId: who.id,
          collection: active.name,
          ...(tenant !== undefined ? { tenantId: tenant?.id ?? null } : {}),
          ...(tenant ? { tenantKind: tenant.kind } : {}),
          expiresAt: now() + ACCOUNT_DEFAULTS.ticketTtlMs,
        });
        blocks.push({
          kind: 'component',
          provider: 'media-upload',
          scripts: [{ src: absolute(`${base}/upload.js`) }],
          props: {
            endpoint: absolute(`${base}/uploads`),
            ticket,
            sameOrigin: publicUrl === undefined,
            maxBytes: options.maxUploadBytes ?? ACCOUNT_DEFAULTS.maxUploadBytes,
            ...(accepts && accepts.length > 0 ? { accept: accepts.join(',') } : {}),
            labels: {
              choose: message(ctx.locale, 'media.upload.choose'),
              upload: message(ctx.locale, 'media.files.upload'),
              pick: message(ctx.locale, 'media.upload.pick'),
              tooLarge: message(ctx.locale, 'media.upload.too_large'),
              uploading: message(ctx.locale, 'media.upload.uploading'),
              failed: message(ctx.locale, 'media.upload.failed'),
            },
          },
          submit: { action: 'upload' },
        });
      }

      if (scope !== undefined && scope.tenants.length === 0 && !scope.includeNull) {
        blocks.push({ kind: 'notice', tone: 'info', text: { key: 'media.files.no_tenant' } });
      }

      const result = await asTenant(media.tenancy, ctx, () =>
        media.library.page(who.type, who.id, {
          collections: [active.name],
          limit: pageSize,
          ...(ctx.query.cursor ? { cursor: ctx.query.cursor } : {}),
          ...(scope !== undefined ? { tenantIds: scopeIds(scope) ?? [] } : {}),
        }),
      );
      const canWrite = await may(media, ctx, who, 'write', active.name);
      const items: ListItem[] = [];
      for (const record of result.items) {
        if (!(await may(media, ctx, who, 'read', record.collection, record))) continue;
        const refs = [
          ...(canWrite && active.rename !== false ? [{ action: 'rename', target: record.id }] : []),
          ...(canWrite && active.delete !== false && ctx.impersonatedBy === null
            ? [{ action: 'delete', target: record.id }]
            : []),
        ];
        const link = active.download !== false ? await downloadHref(media, ctx, record) : {};
        items.push({
          title: record.name,
          subtitle: `${record.fileName} · ${formatSize(record.size)}`,
          meta: [{ type: 'date', at: record.createdAt, style: 'date' }],
          ...link,
          ...(refs.length > 0 ? { actions: refs } : {}),
        });
      }
      blocks.push({
        kind: 'list',
        title: { key: 'media.files.list_title' },
        empty: { key: 'media.files.empty' },
        items,
        nextCursor: result.nextCursor,
      });

      const tabs: Array<{ id: string; label: Text }> | undefined =
        collections.length > 1
          ? collections.map((c) => ({ id: c.name, label: c.label ?? c.name }))
          : undefined;
      return { blocks, ...(tabs ? { tabs } : {}) };
    },
    actions,
  };

  return {
    id: 'media',
    contract: 1,
    messages: ACCOUNT_MESSAGES,
    ...(scriptOrigins.length > 0 ? { scriptOrigins } : {}),
    pages: collections.length > 0 ? [page] : [],
  };
}
