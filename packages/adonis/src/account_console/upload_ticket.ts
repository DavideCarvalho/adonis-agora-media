import { createHmac, timingSafeEqual } from 'node:crypto';

/** What an upload ticket allows: one owner, one collection, one tenant, until it expires. */
export interface UploadTicket {
  ownerType: string;
  ownerId: string;
  collection: string;
  /** The tenant new files are stamped with (`null`: none; absent while tenancy is off). */
  tenantId?: string | null;
  /** The tenant's kind (`organization`, …). */
  tenantKind?: string;
  /** Expiry, epoch milliseconds. */
  expiresAt: number;
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(`media-account-upload:${payload}`).digest('base64url');
}

/** Issue a ticket the account console's upload component sends with the file. */
export function issueUploadTicket(secret: string, ticket: UploadTicket): string {
  const payload = Buffer.from(
    JSON.stringify({
      o: ticket.ownerType,
      i: ticket.ownerId,
      c: ticket.collection,
      ...(ticket.tenantId !== undefined ? { t: ticket.tenantId } : {}),
      ...(ticket.tenantKind !== undefined ? { k: ticket.tenantKind } : {}),
      e: ticket.expiresAt,
    }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/** Verify a ticket: `null` when malformed, forged or expired. */
export function verifyUploadTicket(
  secret: string,
  value: unknown,
  now: number = Date.now(),
): UploadTicket | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const payload = value.slice(0, dot);
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(value.slice(dot + 1));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const raw = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof raw.o !== 'string' ||
      typeof raw.i !== 'string' ||
      typeof raw.c !== 'string' ||
      typeof raw.e !== 'number' ||
      raw.e < now
    ) {
      return null;
    }
    return {
      ownerType: raw.o,
      ownerId: raw.i,
      collection: raw.c,
      ...('t' in raw ? { tenantId: typeof raw.t === 'string' ? raw.t : null } : {}),
      ...(typeof raw.k === 'string' ? { tenantKind: raw.k } : {}),
      expiresAt: raw.e,
    };
  } catch {
    return null;
  }
}
