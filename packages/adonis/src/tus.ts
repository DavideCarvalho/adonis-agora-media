import { randomUUID } from 'node:crypto';
import { SIGNATURE_HEAD_BYTES, verifyContentAgainstWhitelist } from './content_type.js';
import {
  UploadOffsetConflictError,
  UploadSessionExpiredError,
  UploadSessionNotFoundError,
} from './errors.js';
import type { MediaCollectionRegistry } from './media_collection.js';
import type { CreateUploadInput, ResumableUploadManager } from './resumable_upload.js';

/** The TUS protocol version this server implements. */
export const TUS_VERSION = '1.0.0';

/** A web-framework-neutral TUS request (the provider maps an AdonisJS `HttpContext` to this). */
export interface TusRequest {
  method: 'OPTIONS' | 'POST' | 'HEAD' | 'PATCH' | 'DELETE';
  /** Upload id parsed from the URL (for HEAD/PATCH/DELETE). */
  uploadId?: string;
  headers: Record<string, string | undefined>;
  body?: Uint8Array;
}

/** A web-framework-neutral TUS response (the provider writes it back onto the `HttpContext`). */
export interface TusResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

export interface TusUploadHandlerOptions {
  manager: ResumableUploadManager;
  /** Disk uploads land on. */
  disk: string;
  /**
   * Collection this endpoint uploads into. When set (together with {@link collections}), its
   * `acceptsMimeTypes` is enforced at `POST` and on the first `PATCH` — see the class docs. The
   * collection config stays the single source of truth: nothing here restates the MIME list.
   */
  collection?: string;
  /**
   * The collection registry to read {@link collection} from — `media.collections` in an app. Passed
   * rather than the resolved list precisely so the app cannot drift from `config/media.ts`.
   */
  collections?: MediaCollectionRegistry;
  /** Base path the upload resources are exposed at, for the `Location` header. Default `/uploads`. */
  basePath?: string;
  /** Reject creations whose `Upload-Length` exceeds this. */
  maxSize?: number;
  /** Compute the final object key. Default: `uploads/<token>/<filename>`. */
  keyFor?: (filename: string, token: string, metadata: Record<string, string>) => string;
  idGenerator?: () => string;
}

/** Parse a TUS `Upload-Metadata` header (`key b64val,key2 b64val2`). */
export function parseTusMetadata(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(',')) {
    const [key, value] = pair.trim().split(' ');
    if (key) out[key] = value ? Buffer.from(value, 'base64').toString('utf8') : '';
  }
  return out;
}

/**
 * TUS 1.0.0 server core (`creation` + `termination` + `expiration` extensions), delegating storage
 * to a {@link ResumableUploadManager}. It is framework-agnostic: a thin AdonisJS route adapter maps
 * the `HttpContext` request/response to/from {@link TusRequest}/{@link TusResponse}.
 *
 * Protocol surface:
 * - `OPTIONS` — advertise `Tus-Version`/`Tus-Extension`/`Tus-Max-Size`.
 * - `POST` — create with `Upload-Length` + `Upload-Metadata`; returns `201` + `Location`.
 * - `HEAD` — report `Upload-Offset` (+ `Upload-Length`/`Upload-Expires`).
 * - `PATCH` — append at `Upload-Offset` with `Content-Type: application/offset+octet-stream`;
 *   auto-completes at the declared length.
 * - `DELETE` — terminate (abort) an in-flight upload.
 *
 * ## Collection-aware MIME validation (optional)
 *
 * Given a `collection` + `collections` registry, the handler enforces that collection's
 * `acceptsMimeTypes` at the two earliest moments the protocol allows, so a client learns it sent the
 * wrong file *before* spending the bandwidth a resumable upload exists to protect:
 *
 * 1. **`POST`** — the declared `filetype` in `Upload-Metadata`, if present, must be whitelisted.
 *    Rejected with `415 Unsupported Media Type`, before a single byte is uploaded.
 * 2. **first `PATCH`** — the real magic-byte signature of the leading bytes is checked with
 *    {@link verifyContentAgainstWhitelist}. This catches a client that lied in `filetype`. Also
 *    `415`, and the session plus any partial object are aborted so nothing is left behind.
 *
 * This is **bandwidth economy and fast feedback, not the security boundary**. The storage invariant
 * is still guaranteed by `MediaLibrary.attach` / `attachExisting`, which re-validate the assembled
 * object at attach time and remain the final barrier — the TUS checks only see the first chunk, and
 * an endpoint configured without a `collection` performs no MIME validation at all.
 */
export class TusUploadHandler {
  private readonly manager: ResumableUploadManager;
  private readonly disk: string;
  private readonly collection: string | undefined;
  /** Resolved from the collection registry at construction; `undefined` ⇒ no MIME gate here. */
  private readonly accepts: readonly string[] | undefined;
  private readonly basePath: string;
  private readonly maxSize: number | undefined;
  private readonly keyFor: (f: string, t: string, m: Record<string, string>) => string;
  private readonly newId: () => string;

  constructor(options: TusUploadHandlerOptions) {
    this.manager = options.manager;
    this.disk = options.disk;
    this.collection = options.collection;
    this.accepts =
      options.collection !== undefined && options.collections !== undefined
        ? options.collections.get(options.collection).acceptsMimeTypes
        : undefined;
    this.basePath = (options.basePath ?? '/uploads').replace(/\/+$/, '');
    this.maxSize = options.maxSize;
    this.keyFor = options.keyFor ?? ((filename, token) => `uploads/${token}/${filename}`);
    this.newId = options.idGenerator ?? (() => randomUUID());
  }

  async handle(req: TusRequest): Promise<TusResponse> {
    const base: Record<string, string> = { 'Tus-Resumable': TUS_VERSION };
    switch (req.method) {
      case 'OPTIONS':
        return {
          status: 204,
          headers: {
            ...base,
            'Tus-Version': TUS_VERSION,
            'Tus-Extension': 'creation,termination,expiration',
            ...(this.maxSize ? { 'Tus-Max-Size': String(this.maxSize) } : {}),
          },
        };

      case 'POST': {
        const length = Number(req.headers['upload-length']);
        if (this.maxSize && Number.isFinite(length) && length > this.maxSize) {
          return { status: 413, headers: base, body: 'Upload exceeds maximum size' };
        }
        const metadata = parseTusMetadata(req.headers['upload-metadata']);
        // Cheapest possible rejection: the client already told us what it is about to send, so a
        // wrong `filetype` costs zero bytes. Absent metadata just defers the call to the first PATCH.
        if (this.accepts && metadata.filetype && !this.accepts.includes(metadata.filetype)) {
          return {
            status: 415,
            headers: base,
            body: `Content type "${metadata.filetype}" is not accepted by collection "${this.collection}" (accepts: ${this.accepts.join(', ')})`,
          };
        }
        const filename = metadata.filename ?? 'upload';
        const token = this.newId();
        const input: CreateUploadInput = {
          disk: this.disk,
          key: this.keyFor(filename, token, metadata),
          metadata,
        };
        if (Number.isFinite(length)) input.size = length;
        if (metadata.filetype) input.contentType = metadata.filetype;
        const session = await this.manager.createUpload(input);
        const headers: Record<string, string> = {
          ...base,
          Location: `${this.basePath}/${session.id}`,
          'Upload-Offset': '0',
        };
        if (session.expiresAt) headers['Upload-Expires'] = session.expiresAt.toUTCString();
        return { status: 201, headers };
      }

      case 'HEAD': {
        try {
          const status = await this.manager.status(req.uploadId ?? '');
          const headers: Record<string, string> = {
            ...base,
            'Upload-Offset': String(status.offset),
            'Cache-Control': 'no-store',
            ...(status.size != null ? { 'Upload-Length': String(status.size) } : {}),
          };
          if (status.expiresAt) headers['Upload-Expires'] = status.expiresAt.toUTCString();
          return { status: 200, headers };
        } catch (err) {
          return this.mapError(err, base);
        }
      }

      case 'PATCH': {
        if (req.headers['content-type'] !== 'application/offset+octet-stream') {
          return { status: 415, headers: base, body: 'Unsupported Media Type' };
        }
        const offset = Number(req.headers['upload-offset']);
        const body = req.body ?? new Uint8Array();
        try {
          const rejection = await this.#rejectMistypedFirstChunk(
            req.uploadId ?? '',
            offset,
            body,
            base,
          );
          if (rejection) return rejection;

          const result = await this.manager.writeChunk(req.uploadId ?? '', offset, body);
          const status = await this.manager.status(req.uploadId ?? '');
          if (status.size != null && result.offset >= status.size) {
            await this.manager.complete(req.uploadId ?? '');
          }
          const headers: Record<string, string> = {
            ...base,
            'Upload-Offset': String(result.offset),
          };
          if (status.expiresAt) headers['Upload-Expires'] = status.expiresAt.toUTCString();
          return { status: 204, headers };
        } catch (err) {
          return this.mapError(err, base);
        }
      }

      case 'DELETE':
        await this.manager.abort(req.uploadId ?? '');
        return { status: 204, headers: base };

      default:
        return { status: 405, headers: base };
    }
  }

  /**
   * Sniff the FIRST chunk against the collection's `acceptsMimeTypes` and, on a contradiction, throw
   * the whole upload away: the session and any partial object are aborted, so a liar pays for one
   * chunk instead of the whole file and leaves nothing behind.
   *
   * Only the first chunk (`offset === 0`) is inspected, and only its leading
   * {@link SIGNATURE_HEAD_BYTES} — a signature lives at the head of the file or nowhere. Returns
   * `undefined` when the upload may proceed.
   */
  async #rejectMistypedFirstChunk(
    id: string,
    offset: number,
    body: Uint8Array,
    base: Record<string, string>,
  ): Promise<TusResponse | undefined> {
    if (this.accepts === undefined || offset !== 0 || body.byteLength === 0) return undefined;

    const status = await this.manager.status(id);
    const verdict = verifyContentAgainstWhitelist(
      body.subarray(0, SIGNATURE_HEAD_BYTES),
      this.accepts,
      status.contentType,
    );
    if (verdict.outcome === 'accepted') return undefined;

    await this.manager.abort(id);
    const detail =
      verdict.outcome === 'unrecognized'
        ? 'its contents match no accepted signature'
        : `its contents are actually "${verdict.detected}"`;
    return {
      status: 415,
      headers: base,
      body: `Upload rejected: ${detail}, which collection "${this.collection}" does not accept (accepts: ${this.accepts.join(', ')}). The upload has been discarded.`,
    };
  }

  /** Map storage errors onto TUS status codes (409 conflict, 410 expired, 404 unknown). */
  private mapError(err: unknown, base: Record<string, string>): TusResponse {
    if (err instanceof UploadOffsetConflictError) return { status: 409, headers: base };
    if (err instanceof UploadSessionExpiredError) return { status: 410, headers: base };
    if (err instanceof UploadSessionNotFoundError) return { status: 404, headers: base };
    throw err;
  }
}
