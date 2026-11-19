import { Readable } from 'node:stream';
import { MediaControlPlaneError } from '../errors.js';
import type { MediaRecord } from '../media_record.js';
import { fromWireRecord, type WireMediaRecord } from './protocol.js';
import { type MediaTenantClient, nodeStreamOf } from './tenant_client.js';

const enc = encodeURIComponent;

/** What reading a person's file answered. */
export type AccountFileRead =
  | {
      kind: 'file';
      stream: Readable;
      contentType: string;
      size?: number | undefined;
      etag?: string | undefined;
    }
  | { kind: 'not-modified'; etag?: string | undefined }
  | { kind: 'not-found' };

/** The response slice {@link TenantAccounts.serve} writes to (an AdonisJS `HttpContext`). */
export interface AccountServeContext {
  request: { header(name: string): string | undefined | null };
  response: {
    status(code: number): unknown;
    header(name: string, value: string): unknown;
    send(body: unknown): unknown;
    stream(stream: Readable): unknown;
  };
}

/**
 * A person's own files on the media control plane (`controlPlane.accounts` there), shared by every
 * app: an avatar uploaded in one app shows in all of them.
 *
 * - reading uses this app's service token (`media:read`);
 * - writing and removing use the person's own access token: the control plane writes to the token's
 *   `sub`, so no app can change another person's file.
 *
 * ```ts
 * // a controller: the person's avatar, served by this app
 * return media.accounts.serve(ctx, params.id, 'avatar', { conversion: 'md' })
 *
 * // the person changes it (their session's access token)
 * await media.accounts.replace(session.accessToken, 'avatar', { contents, mimeType })
 * ```
 */
export class TenantAccounts {
  constructor(private readonly client: MediaTenantClient) {}

  /** The person's records in `collection` (one for a `single` collection). */
  async records(accountId: string, collection: string): Promise<MediaRecord[]> {
    const body = await this.client.json<{ data: WireMediaRecord[] }>(
      `/accounts/${enc(accountId)}/${enc(collection)}`,
    );
    return body.data.map(fromWireRecord);
  }

  /** The bytes of the person's file (a conversion of it), with `If-None-Match` passed on. */
  async read(
    accountId: string,
    collection: string,
    options: { conversion?: string; width?: number; ifNoneMatch?: string } = {},
  ): Promise<AccountFileRead> {
    let response: Response;
    try {
      response = await this.client.request(`/accounts/${enc(accountId)}/${enc(collection)}/file`, {
        query: { conversion: options.conversion, w: options.width },
        ...(options.ifNoneMatch ? { headers: { 'if-none-match': options.ifNoneMatch } } : {}),
      });
    } catch (error) {
      if (error instanceof MediaControlPlaneError && error.status === 404) {
        return { kind: 'not-found' };
      }
      throw error;
    }
    const etag = response.headers.get('etag') ?? undefined;
    if (response.status === 304) {
      await response.body?.cancel();
      return { kind: 'not-modified', etag };
    }
    const length = Number(response.headers.get('content-length'));
    return {
      kind: 'file',
      stream: nodeStreamOf(response),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      ...(Number.isFinite(length) && length > 0 ? { size: length } : {}),
      etag,
    };
  }

  /**
   * Answer a request with the person's file: `200` with the bytes, `304` when the browser's copy is
   * current, `404` when there is none. Cached privately for a minute by default.
   */
  async serve(
    ctx: AccountServeContext,
    accountId: string,
    collection: string,
    options: { conversion?: string; width?: number; cacheControl?: string } = {},
  ): Promise<unknown> {
    const ifNoneMatch = ctx.request.header('if-none-match') ?? undefined;
    const read = await this.read(accountId, collection, {
      ...(options.conversion !== undefined ? { conversion: options.conversion } : {}),
      ...(options.width !== undefined ? { width: options.width } : {}),
      ...(ifNoneMatch ? { ifNoneMatch } : {}),
    });
    ctx.response.header('cache-control', options.cacheControl ?? 'private, max-age=60');
    if (read.kind === 'not-found') {
      ctx.response.status(404);
      return ctx.response.send('');
    }
    if (read.etag) ctx.response.header('etag', read.etag);
    if (read.kind === 'not-modified') {
      ctx.response.status(304);
      return ctx.response.send('');
    }
    ctx.response.header('content-type', read.contentType);
    if (read.size !== undefined) ctx.response.header('content-length', String(read.size));
    ctx.response.header('x-content-type-options', 'nosniff');
    return ctx.response.stream(read.stream);
  }

  /**
   * Replace the person's file in `collection` with `contents`, as the owner of `accessToken`
   * (their own access token, never this app's). Refused content answers `422` with the media error
   * code (`E_MEDIA_MIME_NOT_ALLOWED`, `E_MEDIA_CONTENT_TYPE_MISMATCH`, …).
   */
  async replace(
    accessToken: string,
    collection: string,
    input: { contents: Buffer | Readable; mimeType: string; fileName?: string; size?: number },
  ): Promise<MediaRecord> {
    const size = Buffer.isBuffer(input.contents) ? input.contents.byteLength : input.size;
    const body = await this.client.json<{ data: WireMediaRecord }>(
      `/accounts/me/${enc(collection)}`,
      {
        method: 'PUT',
        upload: true,
        bearer: accessToken,
        headers: {
          'content-type': 'application/octet-stream',
          'x-media-mime-type': input.mimeType,
          ...(input.fileName ? { 'x-media-file-name': input.fileName } : {}),
          ...(size !== undefined ? { 'x-media-size': String(size) } : {}),
        },
        body:
          input.contents instanceof Readable
            ? input.contents
            : new Uint8Array(input.contents as Buffer),
      },
    );
    return fromWireRecord(body.data);
  }

  /** Remove the person's files in `collection`, as the owner of `accessToken`. Idempotent. */
  async remove(accessToken: string, collection: string): Promise<void> {
    const response = await this.client.request(`/accounts/me/${enc(collection)}`, {
      method: 'DELETE',
      bearer: accessToken,
    });
    await response.body?.cancel();
  }
}
