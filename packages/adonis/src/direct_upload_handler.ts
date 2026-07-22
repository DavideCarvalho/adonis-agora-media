import { randomUUID } from 'node:crypto';
import type { DirectUploadManager } from './direct_upload.js';
import {
  MimeNotAllowedError,
  UploadNotSupportedError,
  UploadPartOutOfRangeError,
  UploadPartSizeError,
  UploadPartsIncompleteError,
  UploadSessionExpiredError,
  UploadSessionNotFoundError,
} from './errors.js';
import type { MultipartPart } from './types.js';

/**
 * A web-framework-neutral direct-upload request, one variant per lifecycle step (the provider maps
 * an AdonisJS `HttpContext` to this; any other framework maps its own request the same way).
 */
export type DirectUploadRequest =
  | {
      action: 'initiate';
      /** Name of the file being uploaded — feeds `keyFor`, never used as a key verbatim. */
      fileName: string;
      /** Total size in bytes. */
      size: number;
      contentType?: string | undefined;
      /** Extra metadata persisted on the session. */
      metadata?: Record<string, string> | undefined;
    }
  | { action: 'status'; uploadId: string }
  | { action: 'confirm-part'; uploadId: string; partNumber: number; etag: string }
  | { action: 'complete'; uploadId: string; parts?: MultipartPart[] | undefined }
  | { action: 'abort'; uploadId: string };

/** A web-framework-neutral response: a status code and a JSON-serializable body. */
export interface DirectUploadResponse {
  status: number;
  body?: unknown;
}

export interface DirectUploadHandlerOptions {
  manager: DirectUploadManager;
  /** Disk uploads land on. Defaults to the manager's default disk. */
  disk?: string | undefined;
  /**
   * Collection this endpoint uploads into. Forwarded to the manager's `initiate`, whose MIME gate
   * (against the registry the manager holds) rejects a wrong declared type with `415` before the
   * multipart upload opens. The collection config stays the single source of truth.
   */
  collection?: string | undefined;
  /** Reject initiations whose `size` exceeds this many bytes (`413`). */
  maxSize?: number | undefined;
  /** Compute the final object key. Default: `uploads/<token>/<fileName>`. */
  keyFor?:
    | ((fileName: string, token: string, metadata: Record<string, string>) => string)
    | undefined;
  idGenerator?: (() => string) | undefined;
}

/**
 * HTTP half of the session-backed direct upload flow, mirroring {@link TusUploadHandler}: the core
 * ({@link DirectUploadManager}) never sees HTTP, this class never sees a framework, and a thin
 * AdonisJS route adapter maps `HttpContext` to {@link DirectUploadRequest}/{@link DirectUploadResponse}.
 *
 * The endpoint surface it expects to be mounted on (see the provider's `uploads.direct.routes`):
 *
 * - `POST   /`                       → `initiate` — `201` + session id, part size, presigned URLs
 * - `GET    /:id`                    → `status` — confirmed ETags + fresh URLs for pending parts
 * - `POST   /:id/parts/:partNumber`  → `confirm-part` — record one uploaded part's ETag
 * - `POST   /:id/complete`           → `complete` — assemble; `409` names any missing parts
 * - `DELETE /:id`                    → `abort`
 *
 * **This handler performs NO authorization** — the same split as `TusUploadHandler` and
 * `MediaDeliveryHandler`. Who may upload, and into whose namespace the key resolves, are questions
 * only the app can answer: guard the route, and resolve the key server-side via {@link keyFor}
 * (the client sends a `fileName`, never a key).
 */
export class DirectUploadHandler {
  private readonly manager: DirectUploadManager;
  private readonly disk: string | undefined;
  private readonly collection: string | undefined;
  private readonly maxSize: number | undefined;
  private readonly keyFor: (f: string, t: string, m: Record<string, string>) => string;
  private readonly newId: () => string;

  constructor(options: DirectUploadHandlerOptions) {
    this.manager = options.manager;
    this.disk = options.disk;
    this.collection = options.collection;
    this.maxSize = options.maxSize;
    this.keyFor = options.keyFor ?? ((fileName, token) => `uploads/${token}/${fileName}`);
    this.newId = options.idGenerator ?? (() => randomUUID());
  }

  async handle(req: DirectUploadRequest): Promise<DirectUploadResponse> {
    switch (req.action) {
      case 'initiate': {
        if (typeof req.fileName !== 'string' || req.fileName.length === 0) {
          return { status: 400, body: { error: 'fileName is required' } };
        }
        if (!Number.isInteger(req.size) || req.size <= 0) {
          return { status: 400, body: { error: 'size must be a positive integer' } };
        }
        if (this.maxSize !== undefined && req.size > this.maxSize) {
          return {
            status: 413,
            body: { error: `Upload exceeds the maximum size of ${this.maxSize} bytes` },
          };
        }
        const metadata = req.metadata ?? {};
        try {
          const created = await this.manager.initiate({
            key: this.keyFor(req.fileName, this.newId(), metadata),
            size: req.size,
            contentType: req.contentType,
            metadata,
            ...(this.disk !== undefined ? { disk: this.disk } : {}),
            ...(this.collection !== undefined ? { collection: this.collection } : {}),
          });
          return {
            status: 201,
            body: {
              id: created.id,
              key: created.key,
              disk: created.disk,
              partSize: created.partSize,
              size: created.size,
              totalParts: created.totalParts,
              parts: created.parts,
              ...(created.expiresAt !== undefined
                ? { expiresAt: created.expiresAt.toISOString() }
                : {}),
            },
          };
        } catch (err) {
          return this.mapError(err);
        }
      }

      case 'status': {
        try {
          const status = await this.manager.status(req.uploadId);
          return {
            status: 200,
            body: {
              id: status.id,
              key: status.key,
              disk: status.disk,
              partSize: status.partSize,
              size: status.size,
              totalParts: status.totalParts,
              ...(status.contentType !== undefined ? { contentType: status.contentType } : {}),
              completedParts: status.completedParts,
              pendingParts: status.pendingParts,
              ...(status.expiresAt !== undefined
                ? { expiresAt: status.expiresAt.toISOString() }
                : {}),
            },
          };
        } catch (err) {
          return this.mapError(err);
        }
      }

      case 'confirm-part': {
        if (!Number.isInteger(req.partNumber) || req.partNumber < 1) {
          return { status: 400, body: { error: 'partNumber must be a positive integer' } };
        }
        if (typeof req.etag !== 'string' || req.etag.length === 0) {
          return { status: 400, body: { error: 'etag is required' } };
        }
        try {
          const progress = await this.manager.confirmPart(req.uploadId, {
            partNumber: req.partNumber,
            etag: req.etag,
          });
          return { status: 200, body: progress };
        } catch (err) {
          return this.mapError(err);
        }
      }

      case 'complete': {
        const parts = req.parts ?? [];
        if (
          !Array.isArray(parts) ||
          parts.some(
            (part) =>
              !Number.isInteger(part?.partNumber) ||
              part.partNumber < 1 ||
              typeof part?.etag !== 'string' ||
              part.etag.length === 0,
          )
        ) {
          return {
            status: 400,
            body: { error: 'parts must be an array of { partNumber, etag }' },
          };
        }
        try {
          const done = await this.manager.complete(req.uploadId, parts);
          return { status: 200, body: done };
        } catch (err) {
          return this.mapError(err);
        }
      }

      case 'abort': {
        await this.manager.abort(req.uploadId);
        return { status: 204 };
      }

      default:
        return { status: 400, body: { error: 'Unknown action' } };
    }
  }

  /** Map manager errors onto HTTP statuses; anything unexpected keeps propagating. */
  private mapError(err: unknown): DirectUploadResponse {
    if (err instanceof UploadSessionNotFoundError) {
      return { status: 404, body: { error: err.message, code: err.code } };
    }
    if (err instanceof UploadSessionExpiredError) {
      return { status: 410, body: { error: err.message, code: err.code } };
    }
    if (err instanceof MimeNotAllowedError) {
      return { status: 415, body: { error: err.message, code: err.code } };
    }
    // Not-yet-uploaded parts are client state out of sync with the session, not a bad request.
    if (err instanceof UploadPartsIncompleteError) {
      return {
        status: 409,
        body: { error: err.message, code: err.code, missingParts: [...err.missingParts] },
      };
    }
    if (
      err instanceof UploadPartOutOfRangeError ||
      err instanceof UploadPartSizeError ||
      err instanceof UploadNotSupportedError ||
      err instanceof RangeError
    ) {
      const code = (err as { code?: string }).code;
      return { status: 400, body: { error: err.message, ...(code ? { code } : {}) } };
    }
    throw err;
  }
}
