import type { IncomingMessage } from 'node:http';
import { type Readable, Transform } from 'node:stream';
import type { DeliveryMode, DeliveryResult } from '../delivery.js';
import {
  ContentSignatureUnrecognizedError,
  ContentTypeMismatchError,
  ConversionArtifactMissingError,
  ConversionNotDefinedError,
  ImageSizeNotAllowedError,
  MediaNotFoundError,
  MimeNotAllowedError,
  NotAnImageError,
  TransformNotReadyError,
  UnsafeFileNameError,
} from '../errors.js';
import type { MediaLibrary } from '../media_library.js';
import type { MediaRecord } from '../media_record.js';
import type { MediaStore } from '../media_store.js';
import {
  bearerOf,
  checkVerifiedTenant,
  type TenantAuthRequest,
  type VerifiedTenant,
  type VerifiedUser,
} from './auth.js';
import {
  DEFAULT_CONTROL_PLANE_PREFIX,
  etagMatches,
  IMAGE_URL_TOKEN,
  MEDIA_SCOPES,
  mediaEtag,
  NAME_PATTERN,
  OWNER_ID_PATTERN,
  OWNER_TYPE_PATTERN,
  PARTITION_PATTERN,
  partitionOwnerType,
  toWireRecord,
  withoutPartition,
} from './protocol.js';

/** The slice of an AdonisJS `HttpContext` the control plane uses (the test harness fakes it). */
export interface ControlPlaneContext {
  params: Record<string, unknown>;
  request: {
    header(name: string): string | undefined | null;
    qs(): Record<string, unknown>;
    body?(): unknown;
    /** The raw Node request: upload bodies are streamed from it. */
    request: IncomingMessage;
  };
  response: {
    status(code: number): unknown;
    header(name: string, value: string): unknown;
    send(body: unknown): unknown;
    json(body: unknown): unknown;
    stream(stream: Readable): unknown;
  };
}

type Handler = (ctx: ControlPlaneContext) => Promise<unknown>;

/** The router methods the control plane needs (AdonisJS' router has them). */
export interface ControlPlaneRouter {
  route(pattern: string, methods: string[], handler: Handler): unknown;
}

/** A person's own files (`controlPlane.accounts` in config/media.ts). */
export interface ControlPlaneAccountsOptions {
  /** The collections a person's own token writes to. Make them `single: true` (one avatar). */
  collections: readonly string[];
  /** Verifies a person's access token. `null` (or a throw) refuses it. */
  verifyUser: (token: string) => Promise<VerifiedUser | null> | VerifiedUser | null;
  /** The owner type of account files on the control plane. Default `Account`. */
  ownerType?: string;
  /** The OIDC clients whose tokens may write. Default: any client. */
  clients?: readonly string[];
  /** The scope a person's token needs to write. Default `profile`. */
  scope?: string;
  /** Largest upload, in bytes. Default 5 MiB. */
  maxBytes?: number;
}

export interface MediaControlPlaneOptions {
  /** The library of one partition (`undefined`: the whole store, for account files). */
  library: (partition?: string) => MediaLibrary | Promise<MediaLibrary>;
  /** The store of one partition (only its records), for the cross-owner listing. */
  store: (partition: string) => MediaStore | Promise<MediaStore>;
  /** Verifies a tenant's token. */
  verifyTenant: (request: TenantAuthRequest) => Promise<VerifiedTenant | null>;
  /** `/_media`. */
  prefix?: string;
  /** Collections tenants may use. Default: every collection. */
  collections?: readonly string[] | undefined;
  /** Largest upload, in bytes. Default 100 MiB. */
  maxBytes?: number;
  /** This app's `delivery.mode`: `proxy` means tenants get bytes, never storage URLs. */
  deliveryMode?: DeliveryMode | undefined;
  accounts?: ControlPlaneAccountsOptions | undefined;
  logger?: { warn(message: string): void; error?(message: string): void };
}

const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_ACCOUNT_MAX_BYTES = 5 * 1024 * 1024;
/** Between the control plane and the app: the app may keep it a minute and revalidate. */
const CACHE_CONTROL = 'private, max-age=60';

/** A request this API refuses, with its HTTP status and a stable code. */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The HTTP status of a media error a tenant caused, `undefined` for anything else (a 500). */
function statusOf(error: unknown): number | undefined {
  if (error instanceof Refusal) return error.status;
  if (
    error instanceof MediaNotFoundError ||
    error instanceof ConversionNotDefinedError ||
    error instanceof TransformNotReadyError ||
    error instanceof ConversionArtifactMissingError
  ) {
    return 404;
  }
  if (
    error instanceof MimeNotAllowedError ||
    error instanceof ContentTypeMismatchError ||
    error instanceof ContentSignatureUnrecognizedError
  ) {
    return 422;
  }
  if (
    error instanceof ImageSizeNotAllowedError ||
    error instanceof NotAnImageError ||
    error instanceof UnsafeFileNameError
  ) {
    return 400;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' && first !== '' ? first : undefined;
}

/** Counts the bytes going through and fails past `limit`. */
function limitBytes(limit: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > limit) {
        callback(new Refusal(413, 'E_MEDIA_TOO_LARGE', `The file is larger than ${limit} bytes.`));
        return;
      }
      callback(null, chunk);
    },
  });
}

/** What a tenant sends with an upload, in `x-media-attach` (base64url JSON). */
interface AttachHeader {
  ownerType?: unknown;
  ownerId?: unknown;
  collection?: unknown;
  fileName?: unknown;
  mimeType?: unknown;
  name?: unknown;
  id?: unknown;
  customProperties?: unknown;
}

/**
 * The media control plane's tenant API, under `<prefix>/v1` (default `/_media/v1`). Every request
 * carries a bearer token: a tenant app's service token (the partition and capabilities come from
 * it, never from the request) or, for the `accounts/me` writes, a person's own access token.
 *
 * - `GET    /whoami` — the token's partition, capabilities and what it may use;
 * - `GET    /records` — one page of the app's records (`collection`, `ownerType`, `ownerId`, `cursor`, `limit`);
 * - `GET    /owners/:ownerType/:ownerId/records` — one owner's records (`collection`);
 * - `POST   /records` — add a file (body: the bytes; `x-media-attach`: what it is);
 * - `GET    /records/:id`, `PATCH /records/:id` (`{ name }`), `DELETE /records/:id`;
 * - `POST   /records/:id/conversions/:conversion` — generate a conversion now;
 * - `GET    /records/:id/file` — the bytes (`conversion`, `w`, `q`; `ETag`, `304`);
 * - `GET    /records/:id/url` — a storage URL, when this app does not deliver by proxy;
 * - `GET    /records/:id/image` — the responsive-image props;
 * - `GET    /accounts/:accountId/:collection[/file]` — a person's files (service token);
 * - `PUT    /accounts/me/:collection`, `DELETE /accounts/me/:collection` — the person's own token.
 */
export class MediaControlPlane {
  readonly prefix: string;
  readonly #options: MediaControlPlaneOptions;
  readonly #collections: Set<string> | undefined;

  constructor(options: MediaControlPlaneOptions) {
    this.#options = options;
    this.prefix = (options.prefix ?? DEFAULT_CONTROL_PLANE_PREFIX).replace(/\/+$/, '');
    this.#collections = options.collections ? new Set(options.collections) : undefined;
  }

  register(router: ControlPlaneRouter): void {
    const v1 = `${this.prefix}/v1`;
    const on = (method: string, path: string, handler: Handler) =>
      router.route(`${v1}${path}`, [method], (ctx) => this.#handle(ctx, handler));
    on('GET', '/whoami', (ctx) => this.whoami(ctx));
    on('GET', '/records', (ctx) => this.listRecords(ctx));
    on('POST', '/records', (ctx) => this.addRecord(ctx));
    on('GET', '/owners/:ownerType/:ownerId/records', (ctx) => this.ownerRecords(ctx));
    on('GET', '/records/:id', (ctx) => this.showRecord(ctx));
    on('PATCH', '/records/:id', (ctx) => this.renameRecord(ctx));
    on('DELETE', '/records/:id', (ctx) => this.deleteRecord(ctx));
    on('POST', '/records/:id/conversions/:conversion', (ctx) => this.ensureConversion(ctx));
    on('GET', '/records/:id/file', (ctx) => this.recordFile(ctx));
    on('GET', '/records/:id/url', (ctx) => this.recordUrl(ctx));
    on('GET', '/records/:id/image', (ctx) => this.recordImage(ctx));
    if (this.#options.accounts) {
      on('PUT', '/accounts/me/:collection', (ctx) => this.replaceOwnFile(ctx));
      on('DELETE', '/accounts/me/:collection', (ctx) => this.removeOwnFiles(ctx));
      on('GET', '/accounts/:accountId/:collection', (ctx) => this.accountRecords(ctx));
      on('GET', '/accounts/:accountId/:collection/file', (ctx) => this.accountFile(ctx));
    }
  }

  /** Runs a handler, answering refusals and media errors as JSON. */
  async #handle(ctx: ControlPlaneContext, handler: Handler): Promise<unknown> {
    try {
      return await handler(ctx);
    } catch (error) {
      const status = statusOf(error);
      if (status === undefined) {
        this.#options.logger?.error?.(
          `[@adonis-agora/media] control plane: ${error instanceof Error ? error.message : String(error)}`,
        );
        ctx.response.status(500);
        return ctx.response.json({ code: 'E_MEDIA_CONTROL_PLANE', message: 'internal error' });
      }
      const { code, message } = error as { code?: string; message: string };
      if (status === 401) {
        ctx.response.header('www-authenticate', 'Bearer realm="media", error="invalid_token"');
      }
      ctx.response.status(status);
      return ctx.response.json({ code: code ?? 'E_MEDIA_CONTROL_PLANE', message });
    }
  }

  /** The verified tenant of a request with `capability` (`null`: any), or a refusal. */
  async #tenant(ctx: ControlPlaneContext, capability: string | null): Promise<VerifiedTenant> {
    const claimed = ctx.request.header('x-media-app') ?? undefined;
    let verified: VerifiedTenant | null;
    try {
      verified = checkVerifiedTenant(
        await this.#options.verifyTenant({
          token: bearerOf(ctx.request.header('authorization') ?? undefined),
          partition: claimed,
          tenant: claimed,
          app: claimed,
        }),
      );
    } catch (error) {
      // A verifier that throws (discovery down, malformed answer) never accepts a tenant.
      this.#options.logger?.warn(
        `[@adonis-agora/media] control plane: verifyTenant failed: ${(error as Error).message}`,
      );
      verified = null;
    }
    if (!verified) throw new Refusal(401, 'E_MEDIA_UNAUTHORIZED', 'Invalid or missing token.');
    if (!PARTITION_PATTERN.test(verified.partition)) {
      throw new Refusal(403, 'E_MEDIA_FORBIDDEN', 'The token names an invalid partition.');
    }
    if (capability !== null && !verified.capabilities.includes(capability)) {
      throw new Refusal(
        403,
        'E_MEDIA_INSUFFICIENT_SCOPE',
        `The token of ${verified.partition} lacks the ${capability} capability.`,
      );
    }
    return verified;
  }

  #collection(name: unknown): string {
    const collection = str(name);
    if (!collection || !NAME_PATTERN.test(collection)) {
      throw new Refusal(400, 'E_MEDIA_BAD_REQUEST', 'A collection is required.');
    }
    if (this.#collections && !this.#collections.has(collection)) {
      throw new Refusal(
        403,
        'E_MEDIA_COLLECTION_NOT_OFFERED',
        `Collection "${collection}" is not offered to tenants.`,
      );
    }
    return collection;
  }

  #owner(ownerType: unknown, ownerId: unknown): { ownerType: string; ownerId: string } {
    const type = str(ownerType);
    const id = str(ownerId);
    if (!type || !OWNER_TYPE_PATTERN.test(type) || !id || !OWNER_ID_PATTERN.test(id)) {
      throw new Refusal(400, 'E_MEDIA_BAD_REQUEST', 'A valid ownerType and ownerId are required.');
    }
    return { ownerType: type, ownerId: id };
  }

  /** The record `id` of the tenant's partition (another app's reads as missing). */
  async #record(library: MediaLibrary, id: unknown): Promise<MediaRecord> {
    const mediaId = str(id) ?? '';
    const record = await library.find(mediaId);
    if (!record || (this.#collections && !this.#collections.has(record.collection))) {
      throw new MediaNotFoundError(mediaId);
    }
    return record;
  }

  #library(partition?: string): Promise<MediaLibrary> {
    return Promise.resolve(this.#options.library(partition));
  }

  #wire(partition: string, record: MediaRecord) {
    return toWireRecord(withoutPartition(partition, record));
  }

  async whoami(ctx: ControlPlaneContext) {
    // Any valid token: the doctor reads what it may do from the answer.
    const tenant = await this.#tenant(ctx, null);
    return ctx.response.json({
      partition: tenant.partition,
      capabilities: tenant.capabilities,
      collections: this.#collections ? [...this.#collections] : '*',
      delivery: this.#options.deliveryMode === 'proxy' ? 'proxy' : 'urls',
      accounts: this.#options.accounts
        ? { collections: [...this.#options.accounts.collections] }
        : null,
    });
  }

  async listRecords(ctx: ControlPlaneContext) {
    const { partition } = await this.#tenant(ctx, MEDIA_SCOPES.read);
    const store = await this.#options.store(partition);
    const qs = ctx.request.qs();
    const ownerType = str(qs.ownerType);
    const ownerId = str(qs.ownerId);
    const collection = qs.collection === undefined ? undefined : this.#collection(qs.collection);
    const limit = Number(str(qs.limit));
    const cursor = str(qs.cursor);
    const page = await store.list({
      ...(collection !== undefined ? { collection } : {}),
      ...(ownerType !== undefined
        ? { ownerType: partitionOwnerType(partition, this.#owner(ownerType, '0').ownerType) }
        : {}),
      ...(ownerId !== undefined ? { ownerId } : {}),
      ...(cursor !== undefined ? { cursor } : {}),
      ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
    });
    const items = this.#collections
      ? page.items.filter((r) => this.#collections!.has(r.collection))
      : page.items;
    return ctx.response.json({
      data: items.map((r) => this.#wire(partition, r)),
      nextCursor: page.nextCursor,
    });
  }

  async ownerRecords(ctx: ControlPlaneContext) {
    const { partition } = await this.#tenant(ctx, MEDIA_SCOPES.read);
    const owner = this.#owner(ctx.params.ownerType, ctx.params.ownerId);
    const qs = ctx.request.qs();
    const collection = qs.collection === undefined ? undefined : this.#collection(qs.collection);
    const library = await this.#library(partition);
    const records = await library.list(
      partitionOwnerType(partition, owner.ownerType),
      owner.ownerId,
      collection,
    );
    const visible = this.#collections
      ? records.filter((r) => this.#collections!.has(r.collection))
      : records;
    return ctx.response.json({ data: visible.map((r) => this.#wire(partition, r)) });
  }

  async addRecord(ctx: ControlPlaneContext) {
    const { partition } = await this.#tenant(ctx, MEDIA_SCOPES.write);
    const header = this.#attachHeader(ctx);
    const owner = this.#owner(header.ownerType, header.ownerId);
    const collection = this.#collection(header.collection);
    const fileName = str(header.fileName);
    const mimeType = str(header.mimeType);
    if (!fileName || !mimeType) {
      throw new Refusal(400, 'E_MEDIA_BAD_REQUEST', 'fileName and mimeType are required.');
    }
    const id = str(header.id);
    if (id !== undefined && !OWNER_ID_PATTERN.test(id)) {
      throw new Refusal(400, 'E_MEDIA_BAD_REQUEST', 'An invalid id.');
    }
    const customProperties =
      header.customProperties && typeof header.customProperties === 'object'
        ? (header.customProperties as Record<string, unknown>)
        : undefined;
    const name = str(header.name);
    const body = this.#body(ctx, this.#options.maxBytes ?? DEFAULT_MAX_BYTES);
    const library = await this.#library(partition);
    const record = await library.attach({
      ownerType: partitionOwnerType(partition, owner.ownerType),
      ownerId: owner.ownerId,
      collection,
      fileName,
      mimeType,
      contents: body.contents,
      ...(body.size !== undefined ? { size: body.size } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(customProperties !== undefined ? { customProperties } : {}),
    });
    ctx.response.status(201);
    return ctx.response.json({ data: this.#wire(partition, record) });
  }

  async showRecord(ctx: ControlPlaneContext) {
    const { partition } = await this.#tenant(ctx, MEDIA_SCOPES.read);
    const record = await this.#record(await this.#library(partition), ctx.params.id);
    return ctx.response.json({ data: this.#wire(partition, record) });
  }

  async renameRecord(ctx: ControlPlaneContext) {
    const { partition } = await this.#tenant(ctx, MEDIA_SCOPES.write);
    const library = await this.#library(partition);
    const record = await this.#record(library, ctx.params.id);
    const body = (ctx.request.body?.() ?? {}) as { name?: unknown };
    const name = str(body.name);
    if (!name) throw new Refusal(400, 'E_MEDIA_BAD_REQUEST', 'A name is required.');
    const renamed = await library.rename(record.id, name);
    return ctx.response.json({ data: this.#wire(partition, renamed) });
  }

  async deleteRecord(ctx: ControlPlaneContext) {
    const { partition } = await this.#tenant(ctx, MEDIA_SCOPES.write);
    const library = await this.#library(partition);
    const id = str(ctx.params.id) ?? '';
    const record = await library.find(id);
    if (record && (!this.#collections || this.#collections.has(record.collection))) {
      await library.delete(record.id);
    }
    ctx.response.status(204);
    return ctx.response.send('');
  }

  async ensureConversion(ctx: ControlPlaneContext) {
    const { partition } = await this.#tenant(ctx, MEDIA_SCOPES.read);
    const library = await this.#library(partition);
    const record = await this.#record(library, ctx.params.id);
    const conversion = str(ctx.params.conversion) ?? '';
    const updated = await library.ensureConversion(record.id, conversion);
    return ctx.response.json({ data: this.#wire(partition, updated) });
  }

  async recordFile(ctx: ControlPlaneContext) {
    const { partition } = await this.#tenant(ctx, MEDIA_SCOPES.read);
    const library = await this.#library(partition);
    const record = await this.#record(library, ctx.params.id);
    const qs = ctx.request.qs();
    return this.#sendFile(ctx, library, record, {
      conversion: str(qs.conversion),
      width: str(qs.w),
      quality: str(qs.q),
    });
  }

  async recordUrl(ctx: ControlPlaneContext) {
    const { partition } = await this.#tenant(ctx, MEDIA_SCOPES.read);
    if (this.#options.deliveryMode === 'proxy') {
      throw new Refusal(
        409,
        'E_MEDIA_PROXY_ONLY',
        'This control plane delivers bytes only (delivery.mode: proxy): read the file instead.',
      );
    }
    const library = await this.#library(partition);
    const record = await this.#record(library, ctx.params.id);
    const qs = ctx.request.qs();
    const conversion = str(qs.conversion);
    const expiresIn = Number(str(qs.expiresIn));
    const signed = Number.isFinite(expiresIn) && expiresIn > 0;
    const result: DeliveryResult = await library.deliver(record.id, {
      ...(conversion !== undefined ? { conversion } : {}),
      ...(signed ? { mode: 'signed' as const, signedTtlSeconds: expiresIn } : {}),
      ...(!signed && this.#options.deliveryMode !== undefined
        ? { mode: this.#options.deliveryMode }
        : {}),
    });
    if (result.kind !== 'redirect') {
      result.stream.destroy();
      throw new Refusal(409, 'E_MEDIA_PROXY_ONLY', 'This file is delivered as bytes only.');
    }
    return ctx.response.json({ url: result.url });
  }

  async recordImage(ctx: ControlPlaneContext) {
    const { partition } = await this.#tenant(ctx, MEDIA_SCOPES.read);
    const library = await this.#library(partition);
    const record = await this.#record(library, ctx.params.id);
    const qs = ctx.request.qs();
    const conversions = str(qs.conversions)
      ?.split(',')
      .filter((name) => NAME_PATTERN.test(name));
    const image = await library.image(record.id, {
      ...(conversions !== undefined && conversions.length > 0 ? { conversions } : {}),
      ...(str(qs.generate) === '1' ? { generate: true } : {}),
      // The tenant builds the URLs (its own route, or this server's): each is a token here.
      url: (conversion) => `${IMAGE_URL_TOKEN}${conversion ?? ''}`,
    });
    return ctx.response.json({ data: image });
  }

  // ---- account files: a person's own, shared by every app ----

  #accounts(): ControlPlaneAccountsOptions {
    const accounts = this.#options.accounts;
    if (!accounts) throw new Refusal(404, 'E_MEDIA_NOT_FOUND', 'No account files here.');
    return accounts;
  }

  #accountCollection(name: unknown): string {
    const collection = str(name);
    if (!collection || !this.#accounts().collections.includes(collection)) {
      throw new Refusal(
        404,
        'E_MEDIA_COLLECTION_NOT_OFFERED',
        `Collection "${collection ?? ''}" holds no account files.`,
      );
    }
    return collection;
  }

  #accountOwnerType(): string {
    return this.#accounts().ownerType ?? 'Account';
  }

  /** The person behind a user access token allowed to write their own files. */
  async #person(ctx: ControlPlaneContext): Promise<{ sub: string; clientId?: string | undefined }> {
    const accounts = this.#accounts();
    const token = bearerOf(ctx.request.header('authorization') ?? undefined);
    if (!token) throw new Refusal(401, 'E_MEDIA_UNAUTHORIZED', 'The person’s token is missing.');
    let verified: VerifiedUser | null;
    try {
      verified = await accounts.verifyUser(token);
    } catch {
      verified = null;
    }
    if (!verified || typeof verified.sub !== 'string' || !OWNER_ID_PATTERN.test(verified.sub)) {
      throw new Refusal(401, 'E_MEDIA_UNAUTHORIZED', 'The person’s token is invalid.');
    }
    if (verified.actor) {
      throw new Refusal(
        403,
        'E_MEDIA_INSUFFICIENT_SCOPE',
        'An impersonation token does not change the person’s files.',
      );
    }
    if (accounts.clients && !accounts.clients.includes(verified.clientId ?? '')) {
      throw new Refusal(403, 'E_MEDIA_INSUFFICIENT_SCOPE', 'This client may not change files.');
    }
    const scope = accounts.scope ?? 'profile';
    if (!(verified.scopes ?? []).includes(scope)) {
      throw new Refusal(403, 'E_MEDIA_INSUFFICIENT_SCOPE', `The token needs the ${scope} scope.`);
    }
    return { sub: verified.sub, clientId: verified.clientId };
  }

  async replaceOwnFile(ctx: ControlPlaneContext) {
    const person = await this.#person(ctx);
    const collection = this.#accountCollection(ctx.params.collection);
    const mimeType = str(ctx.request.header('x-media-mime-type'));
    if (!mimeType) throw new Refusal(415, 'E_MEDIA_BAD_REQUEST', 'x-media-mime-type is required.');
    const fileName = str(ctx.request.header('x-media-file-name')) ?? 'file';
    const body = this.#body(ctx, this.#accounts().maxBytes ?? DEFAULT_ACCOUNT_MAX_BYTES);
    const library = await this.#library();
    const record = await library.attach({
      ownerType: this.#accountOwnerType(),
      ownerId: person.sub,
      collection,
      fileName,
      mimeType,
      contents: body.contents,
      ...(body.size !== undefined ? { size: body.size } : {}),
      ...(person.clientId ? { customProperties: { source: person.clientId } } : {}),
    });
    return ctx.response.json({ data: toWireRecord(record) });
  }

  async removeOwnFiles(ctx: ControlPlaneContext) {
    const person = await this.#person(ctx);
    const collection = this.#accountCollection(ctx.params.collection);
    const library = await this.#library();
    const records = await library.list(this.#accountOwnerType(), person.sub, collection);
    for (const record of records) await library.delete(record.id);
    ctx.response.status(204);
    return ctx.response.send('');
  }

  async #accountRecords(ctx: ControlPlaneContext): Promise<{
    library: MediaLibrary;
    records: MediaRecord[];
  }> {
    await this.#tenant(ctx, MEDIA_SCOPES.read);
    const collection = this.#accountCollection(ctx.params.collection);
    const accountId = str(ctx.params.accountId);
    const library = await this.#library();
    if (!accountId || !OWNER_ID_PATTERN.test(accountId)) return { library, records: [] };
    return {
      library,
      records: await library.list(this.#accountOwnerType(), accountId, collection),
    };
  }

  async accountRecords(ctx: ControlPlaneContext) {
    const { records } = await this.#accountRecords(ctx);
    return ctx.response.json({ data: records.map(toWireRecord) });
  }

  async accountFile(ctx: ControlPlaneContext) {
    const { library, records } = await this.#accountRecords(ctx);
    const record = records[0];
    if (!record) {
      ctx.response.header('cache-control', CACHE_CONTROL);
      throw new MediaNotFoundError(`${str(ctx.params.accountId) ?? ''}`);
    }
    const qs = ctx.request.qs();
    return this.#sendFile(ctx, library, record, {
      conversion: str(qs.conversion),
      width: str(qs.w),
      quality: str(qs.q),
    });
  }

  // ---- shared ----

  /** The bytes of one rendition, always through this server, with an `ETag` (a `304` touches no storage). */
  async #sendFile(
    ctx: ControlPlaneContext,
    library: MediaLibrary,
    record: MediaRecord,
    rendition: {
      conversion?: string | undefined;
      width?: string | undefined;
      quality?: string | undefined;
    },
  ) {
    const etag = mediaEtag(record, { conversion: rendition.conversion, width: rendition.width });
    ctx.response.header('etag', etag);
    ctx.response.header('cache-control', CACHE_CONTROL);
    if (etagMatches(ctx.request.header('if-none-match') ?? undefined, etag)) {
      ctx.response.status(304);
      return ctx.response.send('');
    }
    const accept = ctx.request.header('accept') ?? undefined;
    const result = await library.deliver(record.id, {
      mode: 'proxy',
      ...(rendition.conversion !== undefined ? { conversion: rendition.conversion } : {}),
      ...(rendition.width !== undefined
        ? { width: rendition.width, quality: rendition.quality, accept }
        : {}),
    });
    if (result.kind !== 'stream') throw new Error('media: proxy delivery answered a redirect');
    ctx.response.header('content-type', result.mimeType);
    if (result.size !== undefined) ctx.response.header('content-length', String(result.size));
    if (result.fileName)
      ctx.response.header('x-media-file-name', encodeURIComponent(result.fileName));
    if (result.vary) ctx.response.header('vary', result.vary);
    ctx.response.header('x-content-type-options', 'nosniff');
    return ctx.response.stream(result.stream);
  }

  #attachHeader(ctx: ControlPlaneContext): AttachHeader {
    const raw = str(ctx.request.header('x-media-attach'));
    if (!raw) throw new Refusal(400, 'E_MEDIA_BAD_REQUEST', 'x-media-attach is required.');
    try {
      const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as AttachHeader;
    } catch {
      // answered below
    }
    throw new Refusal(400, 'E_MEDIA_BAD_REQUEST', 'x-media-attach is not valid.');
  }

  /** The upload body, streamed and capped at `limit` bytes. */
  #body(ctx: ControlPlaneContext, limit: number): { contents: Readable; size?: number } {
    // A streamed upload has no Content-Length: the tenant says the size in `x-media-size`.
    const declared = Number(
      ctx.request.header('content-length') ?? ctx.request.header('x-media-size') ?? Number.NaN,
    );
    if (Number.isFinite(declared) && declared > limit) {
      throw new Refusal(413, 'E_MEDIA_TOO_LARGE', `The file is larger than ${limit} bytes.`);
    }
    const contents = ctx.request.request.pipe(limitBytes(limit));
    ctx.request.request.on('error', (error) => contents.destroy(error));
    return {
      contents,
      ...(Number.isFinite(declared) && declared > 0 ? { size: declared } : {}),
    };
  }
}
