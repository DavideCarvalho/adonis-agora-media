import { randomUUID } from 'node:crypto';
import {
  UploadOffsetConflictError,
  UploadSessionExpiredError,
  UploadSessionNotFoundError,
} from './errors.js';
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
 */
export class TusUploadHandler {
  private readonly manager: ResumableUploadManager;
  private readonly disk: string;
  private readonly basePath: string;
  private readonly maxSize: number | undefined;
  private readonly keyFor: (f: string, t: string, m: Record<string, string>) => string;
  private readonly newId: () => string;

  constructor(options: TusUploadHandlerOptions) {
    this.manager = options.manager;
    this.disk = options.disk;
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
        try {
          const result = await this.manager.writeChunk(
            req.uploadId ?? '',
            offset,
            req.body ?? new Uint8Array(),
          );
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

  /** Map storage errors onto TUS status codes (409 conflict, 410 expired, 404 unknown). */
  private mapError(err: unknown, base: Record<string, string>): TusResponse {
    if (err instanceof UploadOffsetConflictError) return { status: 409, headers: base };
    if (err instanceof UploadSessionExpiredError) return { status: 410, headers: base };
    if (err instanceof UploadSessionNotFoundError) return { status: 404, headers: base };
    throw err;
  }
}
