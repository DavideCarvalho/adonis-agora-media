/**
 * Minimal, framework-free `Cookie`/`Set-Cookie` header codec for the console's session cookie.
 * Deliberately NOT using AdonisJS's own `plainCookie`/`cookie` helpers — this cookie is signed by
 * `./auth.ts` itself (HMAC, matching the NestJS sibling console byte-for-byte), so it needs no
 * further encoding, and writing the header directly keeps `./auth.ts` fully framework-free and
 * trivially unit-testable (same reasoning as the NestJS console's `auth/cookie-header.ts`).
 */

export const SESSION_COOKIE_NAME = 'media_dashboard_session';

/** Parse a `Cookie` request header into a `{name: value}` map. Malformed pairs are skipped. */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    const value = pair.slice(eq + 1).trim();
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export interface SetCookieOptions {
  path: string;
  maxAgeSeconds: number;
  secure: boolean;
  /** When true, serializes an already-expired cookie (clears it) regardless of `maxAgeSeconds`. */
  clear?: boolean;
}

/** Serialize one `Set-Cookie` header value: `HttpOnly`, `SameSite=Lax`, and `Secure` over https. */
export function serializeSetCookie(name: string, value: string, options: SetCookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path}`);
  parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  if (options.clear) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  parts.push('HttpOnly');
  parts.push('SameSite=Lax');
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
