import { createHmac, timingSafeEqual } from 'node:crypto';
import { DeliverySignatureError } from './errors.js';

/**
 * Signed delivery URLs (`delivery.signing`) — the imgproxy/Thumbor model: the app signs the exact
 * request (record, conversion, size, expiry) with a secret, and the delivery route serves only
 * requests it signed. Nothing about the URL can be changed without breaking the signature, so a
 * signed URL can ask for any width (the app chose it) and still not be turned into a key to other
 * records or sizes — and an `<img>`, which cannot send an auth header, carries its authorization
 * in the URL until it expires.
 */
export interface DeliverySigningConfig {
  /** HMAC key — e.g. `env.get('APP_KEY')`. Rotating it invalidates every outstanding URL. */
  secret: string;
  /**
   * How long a signed URL stays valid, in seconds. Default 3600. Expiries are rounded up to a
   * multiple of this, so a page rendered twice within the window gets the same URLs and the
   * browser cache keeps working — a URL is valid for between one and two windows.
   */
  expiresIn?: number;
  /**
   * Refuse unsigned requests at the delivery route. Default `true`: with signing configured, the
   * point is usually that nothing is reachable without a URL the app handed out.
   */
  required?: boolean;
}

/** What a signature covers. */
export interface SignedDeliveryParams {
  mediaId: string;
  conversion?: string | undefined;
  width?: number | undefined;
  quality?: number | undefined;
  /** Unix seconds. */
  expires: number;
}

/** The query parameters of a delivery URL, as the route receives them. */
export interface DeliveryQuery {
  conversion?: string | undefined;
  w?: string | undefined;
  q?: string | undefined;
  exp?: string | undefined;
  sig?: string | undefined;
}

export const DEFAULT_DELIVERY_SIGNING_TTL_SECONDS = 3600;

/** HMAC-SHA256 over the canonical form of the params, base64url. */
export function signDelivery(secret: string, params: SignedDeliveryParams): string {
  const canonical = [
    params.mediaId,
    params.conversion ?? '',
    params.width ?? '',
    params.quality ?? '',
    params.expires,
  ].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('base64url');
}

/**
 * Expiry for a URL signed now: `now + ttl`, rounded up to a multiple of `ttl` so the URL is stable
 * for the rest of the window.
 */
export function deliveryExpiry(nowMs: number, ttlSeconds: number): number {
  const now = Math.floor(nowMs / 1000);
  return Math.ceil((now + ttlSeconds) / ttlSeconds) * ttlSeconds;
}

/**
 * Check a request's signature. Throws {@link DeliverySignatureError} when it is invalid or expired.
 * Returns `false` when the request carries no signature at all (the caller decides whether that is
 * allowed), `true` when it is signed and valid.
 */
export function verifyDelivery(
  secret: string,
  request: {
    mediaId: string;
    conversion?: string | undefined;
    width?: number | string | undefined;
    quality?: number | string | undefined;
    expires?: number | string | undefined;
    signature?: string | undefined;
  },
  nowMs: number,
): boolean {
  const { signature, expires } = request;
  if ((signature === undefined || signature === '') && (expires === undefined || expires === '')) {
    return false;
  }
  if (!signature || expires === undefined || expires === '') {
    throw new DeliverySignatureError('invalid');
  }
  const exp = Number(expires);
  if (!Number.isInteger(exp)) throw new DeliverySignatureError('invalid');

  const expected = signDelivery(secret, {
    mediaId: request.mediaId,
    conversion: emptyToUndefined(request.conversion),
    width: toOptionalInt(request.width),
    quality: toOptionalInt(request.quality),
    expires: exp,
  });
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
    throw new DeliverySignatureError('invalid');
  }
  // Checked after the signature: an attacker learns nothing from "expired" on a forged URL.
  if (exp * 1000 < nowMs) throw new DeliverySignatureError('expired');
  return true;
}

/** Build the query string of a delivery URL. */
export function deliveryQueryString(params: {
  conversion?: string | undefined;
  width?: number | undefined;
  quality?: number | undefined;
  expires?: number | undefined;
  signature?: string | undefined;
}): string {
  const query = new URLSearchParams();
  if (params.conversion !== undefined) query.set('conversion', params.conversion);
  if (params.width !== undefined) query.set('w', String(params.width));
  if (params.quality !== undefined) query.set('q', String(params.quality));
  if (params.expires !== undefined) query.set('exp', String(params.expires));
  if (params.signature !== undefined) query.set('sig', params.signature);
  const text = query.toString();
  return text ? `?${text}` : '';
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
}

function toOptionalInt(value: number | string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed =
    typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : Number.NaN;
  // A non-numeric value cannot have been signed by us; NaN makes the HMAC mismatch.
  return parsed;
}
