import type { Readable } from 'node:stream';
import { withTenant } from '../agora/tenancy.js';
import type { MediaRecord } from '../media_record.js';
import {
  ACCOUNT_DEFAULTS,
  accountCollections,
  type MediaAccountConsoleOptions,
} from './extension.js';
import { verifyUploadTicket } from './upload_ticket.js';

/** What the upload endpoint needs from the request. */
export interface AccountUploadRequest {
  header(name: string): string | undefined | null;
  body: Readable;
}

/** What it answers. */
export interface AccountUploadResponse {
  status: number;
  body: { id: string } | { error: string };
}

/** What it stores through. */
export interface AccountUploadMedia {
  readonly tenancy: { enabled: boolean };
  readonly library: {
    attach(input: {
      ownerType: string;
      ownerId: string;
      collection: string;
      fileName: string;
      mimeType: string;
      contents: Readable;
      size?: number;
      tenantId?: string | null;
    }): Promise<MediaRecord>;
  };
}

/**
 * `POST <accountConsole.path>/uploads`: stores one file for the account console's upload
 * component. The request carries the ticket the page issued (owner, collection, tenant, expiry,
 * HMAC-signed) in `x-media-upload-ticket`, the file name in `x-file-name` and the bytes as the body.
 * Everything a collection enforces on attach (MIME whitelist, content check) still applies.
 */
export async function handleAccountUpload(
  request: AccountUploadRequest,
  deps: {
    media: () => Promise<AccountUploadMedia>;
    options: MediaAccountConsoleOptions;
    secret: string;
    now?: () => number;
  },
): Promise<AccountUploadResponse> {
  const ticket = verifyUploadTicket(
    deps.secret,
    request.header('x-media-upload-ticket'),
    (deps.now ?? Date.now)(),
  );
  if (!ticket) return { status: 401, body: { error: 'invalid or expired upload ticket' } };
  const collection = accountCollections(deps.options).find((c) => c.name === ticket.collection);
  if (!collection || collection.upload === false) {
    return { status: 403, body: { error: 'uploads are not allowed in this collection' } };
  }
  const max = deps.options.maxUploadBytes ?? ACCOUNT_DEFAULTS.maxUploadBytes;
  const length = Number(request.header('content-length'));
  if (!Number.isFinite(length) || length <= 0) {
    return { status: 411, body: { error: 'content-length is required' } };
  }
  if (length > max) return { status: 413, body: { error: 'file too large' } };
  let fileName = 'file';
  try {
    fileName = decodeURIComponent(request.header('x-file-name') ?? '') || 'file';
  } catch {
    return { status: 400, body: { error: 'invalid x-file-name' } };
  }
  const mimeType = (request.header('content-type') ?? 'application/octet-stream').split(';')[0]!;
  const media = await deps.media();
  const attach = () =>
    media.library.attach({
      ownerType: ticket.ownerType,
      ownerId: ticket.ownerId,
      collection: ticket.collection,
      fileName: fileName.slice(0, 255),
      mimeType: mimeType.trim() || 'application/octet-stream',
      contents: request.body,
      size: length,
      ...(ticket.tenantId !== undefined ? { tenantId: ticket.tenantId } : {}),
    });
  try {
    const record = media.tenancy.enabled
      ? await withTenant(
          ticket.tenantId
            ? { id: ticket.tenantId, kind: ticket.tenantKind ?? 'organization' }
            : null,
          attach,
        )
      : await attach();
    return { status: 201, body: { id: record.id } };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const status = typeof code === 'string' && code.startsWith('E_MEDIA_') ? 422 : 500;
    return {
      status,
      body: { error: status === 422 && error instanceof Error ? error.message : 'upload failed' },
    };
  }
}
