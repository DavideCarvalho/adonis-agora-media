import type { Readable } from 'node:stream';
import type { DeliveryResult } from '../delivery.js';
import {
  MediaControlPlaneError,
  MediaNotFoundError,
  MediaTenantUnsupportedError,
} from '../errors.js';
import type { FocalPoint } from '../image_processor.js';
import { deliverRecord, imageOfRecord } from '../internal_symbols.js';
import {
  type AttachExistingInput,
  type AttachInput,
  type DeliverOptions,
  MediaLibrary,
  type MediaLibraryOptions,
  type MediaSignedUrlOptions,
  type StreamFileResult,
} from '../media_library.js';
import type { MediaRecord } from '../media_record.js';
import type { MediaListOptions, MediaListPage, MediaStore } from '../media_store.js';
import type { ResponsiveImage, ResponsiveImageOptions } from '../responsive_image.js';
import type { MediaStream } from '../streaming.js';
import { fromWireRecord, IMAGE_URL_TOKEN, type WireMediaRecord } from './protocol.js';
import { type MediaTenantClient, nodeStreamOf } from './tenant_client.js';

/**
 * Where a tenant's file URLs point:
 * - `app` (default): this app's own delivery route (`delivery.path`, `media.access.deliveryRoute()`),
 *   which reads the bytes from the control plane. Same origin as the page, so a strict
 *   `img-src 'self'` holds, and it works when the control plane delivers by proxy.
 * - `control-plane`: the storage URL the control plane hands out (signed or public). Needs a control
 *   plane that does not deliver by proxy.
 */
export type TenantUrls = 'app' | 'control-plane';

const enc = encodeURIComponent;

function isNotFound(error: unknown): boolean {
  return error instanceof MediaControlPlaneError && error.status === 404;
}

/** `30`, `'30'`, `'30s'`, `'5m'`, `'2h'`, `'1d'` → seconds. */
export function seconds(value: string | number): number {
  if (typeof value === 'number') return value;
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(value.trim());
  if (!match)
    throw new TypeError(`media: "${value}" is not a duration (30, '30s', '5m', '1h', '1d')`);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[(match[2] ?? 's').toLowerCase() as 's'];
  return Number(match[1]) * unit;
}

/**
 * The records of a tenant, read from the control plane. Only the reads the library makes go
 * through it; every write is a call of its own on {@link TenantMediaLibrary}.
 */
export class RemoteMediaStore implements MediaStore {
  constructor(private readonly client: MediaTenantClient) {}

  async find(id: string): Promise<MediaRecord | null> {
    try {
      const body = await this.client.json<{ data: WireMediaRecord }>(`/records/${enc(id)}`);
      return fromWireRecord(body.data);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async listByOwner(ownerType: string, ownerId: string, collection?: string) {
    const body = await this.client.json<{ data: WireMediaRecord[] }>(
      `/owners/${enc(ownerType)}/${enc(ownerId)}/records`,
      { query: { collection } },
    );
    return body.data.map(fromWireRecord);
  }

  async list(options: MediaListOptions = {}): Promise<MediaListPage> {
    const body = await this.client.json<{ data: WireMediaRecord[]; nextCursor: string | null }>(
      '/records',
      {
        query: {
          collection: options.collection,
          ownerType: options.ownerType,
          ownerId: options.ownerId,
          cursor: options.cursor,
          limit: options.limit,
        },
      },
    );
    return { items: body.data.map(fromWireRecord), nextCursor: body.nextCursor };
  }

  save(): Promise<MediaRecord> {
    return Promise.reject(new MediaTenantUnsupportedError('Writing a record to the store'));
  }

  delete(): Promise<void> {
    return Promise.reject(new MediaTenantUnsupportedError('Deleting from the store'));
  }

  nextOrder(): Promise<number> {
    return Promise.reject(new MediaTenantUnsupportedError('nextOrder'));
  }
}

/**
 * `media.library` on a tenant: the same API, run on the control plane. Records, files and
 * conversions live there; this app keeps its collection `access` rules, its delivery route and its
 * signing secret.
 */
export class TenantMediaLibrary extends MediaLibrary {
  readonly #client: MediaTenantClient;
  readonly #urls: TenantUrls;

  constructor(
    options: MediaLibraryOptions,
    tenant: { client: MediaTenantClient; urls?: TenantUrls | undefined },
  ) {
    super(options);
    this.#client = tenant.client;
    this.#urls = tenant.urls ?? 'app';
  }

  /** Upload the file to the control plane, which stores it and runs the collection's conversions. */
  override async attach(input: AttachInput): Promise<MediaRecord> {
    const meta = {
      ownerType: input.ownerType,
      ownerId: String(input.ownerId),
      collection: input.collection,
      fileName: input.fileName,
      mimeType: input.mimeType,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.id !== undefined ? { id: input.id } : {}),
      ...(input.customProperties !== undefined ? { customProperties: input.customProperties } : {}),
    };
    const contents = input.contents;
    const size = Buffer.isBuffer(contents) ? contents.byteLength : input.size;
    const body = await this.#client.json<{ data: WireMediaRecord }>('/records', {
      method: 'POST',
      upload: true,
      headers: {
        'content-type': 'application/octet-stream',
        'x-media-attach': Buffer.from(JSON.stringify(meta), 'utf8').toString('base64url'),
        ...(size !== undefined ? { 'x-media-size': String(size) } : {}),
      },
      body: Buffer.isBuffer(contents) ? new Uint8Array(contents) : (contents as Readable),
    });
    return fromWireRecord(body.data);
  }

  override attachExisting(_input: AttachExistingInput): Promise<MediaRecord> {
    return Promise.reject(
      new MediaTenantUnsupportedError('attachExisting (an object already on a disk)'),
    );
  }

  override async rename(id: string, name: string): Promise<MediaRecord> {
    try {
      const body = await this.#client.json<{ data: WireMediaRecord }>(`/records/${enc(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      return fromWireRecord(body.data);
    } catch (error) {
      if (isNotFound(error)) throw new MediaNotFoundError(id);
      throw error;
    }
  }

  override async delete(id: string): Promise<void> {
    await this.#client.request(`/records/${enc(id)}`, { method: 'DELETE' }).then(
      (response) => response.body?.cancel(),
      (error: unknown) => {
        if (!isNotFound(error)) throw error;
      },
    );
  }

  override async ensureConversion(id: string, conversionName: string): Promise<MediaRecord> {
    try {
      const body = await this.#client.json<{ data: WireMediaRecord }>(
        `/records/${enc(id)}/conversions/${enc(conversionName)}`,
        { method: 'POST' },
      );
      return fromWireRecord(body.data);
    } catch (error) {
      if (isNotFound(error)) throw new MediaNotFoundError(`${id}#${conversionName}`);
      throw error;
    }
  }

  /**
   * The URL of a file: this app's delivery route (`urls: 'app'`, signed when `delivery.signing` is
   * set), or the control plane's storage URL (`urls: 'control-plane'`).
   */
  override async url(id: string, conversion?: string): Promise<string> {
    if (this.#urls === 'app') return this.deliveryUrl(id, conversion ? { conversion } : {});
    return this.#remoteUrl(id, conversion);
  }

  /** A time-limited storage URL, signed by the control plane (not by proxy). */
  override async signedUrl(
    id: string,
    expiresIn: string | number,
    options: MediaSignedUrlOptions = {},
  ): Promise<string> {
    return this.#remoteUrl(id, options.conversion, seconds(expiresIn));
  }

  async #remoteUrl(id: string, conversion?: string, expiresIn?: number): Promise<string> {
    try {
      const body = await this.#client.json<{ url: string }>(`/records/${enc(id)}/url`, {
        query: { conversion, expiresIn },
      });
      return body.url;
    } catch (error) {
      if (isNotFound(error)) throw new MediaNotFoundError(conversion ? `${id}#${conversion}` : id);
      throw error;
    }
  }

  override async deliver(id: string, options: DeliverOptions = {}): Promise<DeliveryResult> {
    return this.#deliver(id, options);
  }

  /** @internal */
  override async [deliverRecord](
    record: MediaRecord,
    options: DeliverOptions = {},
  ): Promise<DeliveryResult> {
    return this.#deliver(record.id, options);
  }

  async #deliver(id: string, options: DeliverOptions): Promise<DeliveryResult> {
    const resize = options.width !== undefined && options.width !== '';
    if (this.#urls === 'control-plane' && options.mode !== 'proxy' && !resize) {
      try {
        return { kind: 'redirect', url: await this.#remoteUrl(id, options.conversion) };
      } catch (error) {
        // A control plane that delivers by proxy only: read the bytes instead.
        if (!(error instanceof MediaControlPlaneError && error.status === 409)) throw error;
      }
    }
    let response: Response;
    try {
      response = await this.#client.request(`/records/${enc(id)}/file`, {
        query: {
          conversion: options.conversion,
          ...(resize ? { w: String(options.width), q: options.quality } : {}),
        },
        ...(options.accept ? { headers: { accept: options.accept } } : {}),
      });
    } catch (error) {
      if (isNotFound(error)) {
        throw new MediaNotFoundError(options.conversion ? `${id}#${options.conversion}` : id);
      }
      throw error;
    }
    const length = Number(response.headers.get('content-length'));
    const fileName = response.headers.get('x-media-file-name');
    const vary = response.headers.get('vary');
    return {
      kind: 'stream',
      stream: nodeStreamOf(response),
      mimeType: response.headers.get('content-type') ?? 'application/octet-stream',
      ...(Number.isFinite(length) && length > 0 ? { size: length } : {}),
      ...(fileName ? { fileName: decodeURIComponent(fileName) } : {}),
      ...(vary === 'Accept' ? { vary: 'Accept' as const } : {}),
    };
  }

  /**
   * The responsive-image props, computed by the control plane from its collection presets; each
   * URL is this app's (`urls: 'app'`) or the control plane's.
   * @internal
   */
  override async [imageOfRecord](
    record: MediaRecord,
    options: ResponsiveImageOptions = {},
  ): Promise<ResponsiveImage> {
    if (options.onDemand) return super[imageOfRecord](record, options);
    let image: ResponsiveImage;
    try {
      const body = await this.#client.json<{ data: ResponsiveImage }>(
        `/records/${enc(record.id)}/image`,
        {
          query: {
            conversions: options.conversions?.join(','),
            generate: options.generate ? '1' : undefined,
          },
        },
      );
      image = body.data;
    } catch (error) {
      if (isNotFound(error)) throw new MediaNotFoundError(record.id);
      throw error;
    }
    const urls = new Map<string, Promise<string>>();
    const urlOf = (conversion: string): Promise<string> => {
      let url = urls.get(conversion);
      if (!url) {
        const name = conversion === '' ? undefined : conversion;
        url = Promise.resolve(
          options.url
            ? options.url(name)
            : options.expiresIn !== undefined
              ? this.signedUrl(record.id, options.expiresIn, name ? { conversion: name } : {})
              : this.url(record.id, name),
        );
        urls.set(conversion, url);
      }
      return url;
    };
    const swap = async (value: string): Promise<string> =>
      value.startsWith(IMAGE_URL_TOKEN) ? urlOf(value.slice(IMAGE_URL_TOKEN.length)) : value;
    const src = await swap(image.src);
    let srcSet: string | undefined;
    if (image.srcSet) {
      const parts = await Promise.all(
        image.srcSet.split(', ').map(async (candidate) => {
          const space = candidate.lastIndexOf(' ');
          return `${await swap(candidate.slice(0, space))}${candidate.slice(space)}`;
        }),
      );
      srcSet = parts.join(', ');
    }
    return { ...image, src, ...(srcSet !== undefined ? { srcSet } : {}) };
  }

  override transform(_id: string, transformerName: string): Promise<MediaRecord> {
    return Promise.reject(
      new MediaTenantUnsupportedError(
        `transform("${transformerName}") (the control plane runs it)`,
      ),
    );
  }

  override setFocalPoint(_id: string, _point: FocalPoint | null): Promise<MediaRecord> {
    return Promise.reject(new MediaTenantUnsupportedError('setFocalPoint'));
  }

  override stream(): Promise<MediaStream> {
    return Promise.reject(new MediaTenantUnsupportedError('stream (HLS/DASH packages)'));
  }

  override streamFile(): Promise<StreamFileResult> {
    return Promise.reject(new MediaTenantUnsupportedError('streamFile (HLS/DASH packages)'));
  }
}
