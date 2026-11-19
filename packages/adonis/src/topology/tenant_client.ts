import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { MediaConfig } from '../define_config.js';
import { MediaControlPlaneError } from '../errors.js';
import { resolveTenantToken, type TenantToken, type TenantTokenSource } from './auth.js';

/**
 * Where the control plane is: its base URL including the prefix (`https://hub.example.com/_media`),
 * or a function that resolves it, such as `controlPlaneUrl({ issuer, resource: 'urn:agora:media' })`
 * from `@adonis-agora/authkit-client` (looked up again through its `refresh()` after a connection
 * error).
 */
export type ControlPlaneUrlSource =
  | string
  | ((() => Promise<string>) & { refresh?: () => Promise<string> });

export interface MediaTenantClientOptions {
  url: ControlPlaneUrlSource;
  /** This app's name on the control plane (sent as `x-media-app`; the token decides). */
  partition: string;
  token: TenantTokenSource;
  /** Per request (reads, deletes). Default 10000. */
  timeoutMs?: number;
  /** Per upload. Default 120000. */
  uploadTimeoutMs?: number;
  /** Retries of a read after a network error or a 5xx. Default 1. Writes are never retried. */
  retries?: number;
  fetch?: typeof fetch;
}

export interface TenantRequest {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** A buffer or a stream (streamed as is, never buffered here). */
  body?: Uint8Array | Readable | string;
  /** A person's own access token instead of this app's service token. */
  bearer?: string;
  /** Upload timeout instead of the read one. */
  upload?: boolean;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/**
 * The HTTP client of a media tenant: this app's service token on every call (a fresh one once after
 * a `401`), reads retried after a network error or a `5xx`, writes never retried, every failure a
 * {@link MediaControlPlaneError} (`503` when the control plane did not answer).
 */
export class MediaTenantClient {
  readonly partition: string;
  readonly #url: ControlPlaneUrlSource;
  readonly #token: TenantToken;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #uploadTimeoutMs: number;
  readonly #retries: number;
  #resolved: string | undefined;

  constructor(options: MediaTenantClientOptions) {
    this.partition = options.partition;
    this.#url = options.url;
    this.#token = resolveTenantToken(options.token);
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#uploadTimeoutMs = options.uploadTimeoutMs ?? 120_000;
    this.#retries = options.retries ?? 1;
  }

  /** The control plane's base URL (resolved through discovery when it is a function). */
  async baseUrl(): Promise<string> {
    if (typeof this.#url === 'string') return trimSlash(this.#url);
    if (this.#resolved) return this.#resolved;
    try {
      this.#resolved = trimSlash(await this.#url());
    } catch (error) {
      throw new MediaControlPlaneError(
        `media control plane: its URL did not resolve (${(error as Error).message})`,
        503,
      );
    }
    return this.#resolved;
  }

  /** The last resolved base URL, without I/O. */
  get url(): string | undefined {
    return typeof this.#url === 'string' ? trimSlash(this.#url) : this.#resolved;
  }

  /** After a connection error: look the URL up again (a function source only). */
  async #rediscover(): Promise<boolean> {
    if (typeof this.#url === 'string') return false;
    const refresh = this.#url.refresh;
    try {
      const fresh = trimSlash(refresh ? await refresh() : await this.#url());
      const moved = fresh !== this.#resolved;
      this.#resolved = fresh;
      return moved;
    } catch {
      return false;
    }
  }

  /**
   * One call. Answers the response when it is a 2xx or a 304; anything else is thrown as a
   * {@link MediaControlPlaneError} carrying the control plane's status and code.
   */
  async request(path: string, request: TenantRequest = {}): Promise<Response> {
    const method = request.method ?? 'GET';
    const idempotent = method === 'GET' || method === 'HEAD';
    const replayable = !(request.body instanceof Readable);
    let attempt = 0;
    let refreshedToken = false;
    let rediscovered = false;
    for (;;) {
      let response: Response;
      try {
        response = await this.#send(path, request);
      } catch (error) {
        if (error instanceof MediaControlPlaneError) throw error;
        // Not reached: it may have moved (discovery), or be restarting.
        if (!rediscovered && replayable && (await this.#rediscover())) {
          rediscovered = true;
          continue;
        }
        if (idempotent && attempt < this.#retries) {
          attempt++;
          continue;
        }
        throw new MediaControlPlaneError(
          `media control plane did not answer ${method} ${path}: ${(error as Error).message}`,
          503,
        );
      }
      if (
        response.status === 401 &&
        request.bearer === undefined &&
        !refreshedToken &&
        replayable &&
        this.#token.reset
      ) {
        await response.body?.cancel();
        this.#token.reset();
        refreshedToken = true;
        continue;
      }
      if (response.status >= 500 && idempotent && attempt < this.#retries) {
        await response.body?.cancel();
        attempt++;
        continue;
      }
      if (response.ok || response.status === 304) return response;
      throw await failureOf(response, `${method} ${path}`);
    }
  }

  /** A JSON call. */
  async json<T>(path: string, request: TenantRequest = {}): Promise<T> {
    const response = await this.request(path, {
      ...request,
      headers: { accept: 'application/json', ...request.headers },
    });
    return (await response.json()) as T;
  }

  async #send(path: string, request: TenantRequest): Promise<Response> {
    const base = await this.baseUrl();
    const url = new URL(`${base}/v1${path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const bearer = request.bearer ?? (await this.#bearer());
    const body = request.body;
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method ?? 'GET',
      headers: {
        authorization: `Bearer ${bearer}`,
        'x-media-app': this.partition,
        ...request.headers,
      },
      signal: AbortSignal.timeout(request.upload ? this.#uploadTimeoutMs : this.#timeoutMs),
    };
    if (body instanceof Readable) {
      init.body = Readable.toWeb(body) as unknown as NonNullable<RequestInit['body']>;
      init.duplex = 'half';
    } else if (body !== undefined) {
      init.body = body as NonNullable<RequestInit['body']>;
    }
    return this.#fetch(url, init);
  }

  async #bearer(): Promise<string> {
    try {
      return await this.#token.get();
    } catch (error) {
      throw new MediaControlPlaneError(
        `media control plane: no token for ${this.partition} (${(error as Error).message})`,
        503,
        'E_MEDIA_CONTROL_PLANE_TOKEN',
      );
    }
  }
}

/** A failed answer as an error: the control plane's own code and message when it sent them. */
export async function failureOf(response: Response, what: string): Promise<MediaControlPlaneError> {
  const body = (await response.json().catch(() => null)) as {
    code?: unknown;
    message?: unknown;
  } | null;
  const message =
    typeof body?.message === 'string'
      ? body.message
      : `media control plane answered ${response.status} to ${what}`;
  return new MediaControlPlaneError(
    message,
    response.status,
    typeof body?.code === 'string' ? body.code : undefined,
  );
}

/** A response body as a Node stream. */
export function nodeStreamOf(response: Response): Readable {
  if (!response.body) return Readable.from([]);
  return Readable.fromWeb(response.body as unknown as WebReadableStream);
}

/** The client a tenant config describes. */
export function tenantClientOf(
  config: MediaConfig,
  options: { fetch?: typeof fetch } = {},
): MediaTenantClient {
  const tenant = config.tenant;
  if (!tenant) throw new Error('media: not a tenant (no `tenant` in config/media.ts)');
  return clientOf(tenant, options);
}

/** The client `accounts` describes (a standalone app's account files), or none. */
export function accountsClientOf(
  config: MediaConfig,
  options: { fetch?: typeof fetch } = {},
): MediaTenantClient | undefined {
  return config.accounts ? clientOf(config.accounts, options) : undefined;
}

function clientOf(
  source: NonNullable<MediaConfig['accounts']>,
  options: { fetch?: typeof fetch },
): MediaTenantClient {
  return new MediaTenantClient({
    url: source.url,
    partition: source.partition,
    token: source.token,
    ...(source.timeoutMs !== undefined ? { timeoutMs: source.timeoutMs } : {}),
    ...(source.uploadTimeoutMs !== undefined ? { uploadTimeoutMs: source.uploadTimeoutMs } : {}),
    ...(source.retries !== undefined ? { retries: source.retries } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
