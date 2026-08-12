import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Built-in session-cookie login for the dashboard, ported from the NestJS sibling console
 * (`@dudousxd/nestjs-media-dashboard`'s `server/auth/*`) so both ecosystems gate the console the
 * same way. Framework-free by design (no AdonisJS import here) — the provider is the only piece
 * that knows about `HttpContext`/cookies; this module only signs and verifies a stateless
 * HMAC-SHA256 session, exactly as the NestJS version does (same wire format, same TTL/grace rules),
 * so a host running both consoles can share one mental model of "how the console gate works".
 */

/** Clock-skew grace applied to `exp` so a marginally-late clock doesn't bounce a valid cookie. */
const EXP_GRACE_MS = 30_000;

/** The validated console session decoded from a verified cookie. */
export interface ConsoleSession {
  /** Stable user id (the session user's `id`). */
  sub: string;
  /** Optional display name. */
  name?: string;
  /** Free-form role strings; the console does not interpret them. */
  roles: string[];
  /** Issued-at, epoch milliseconds. */
  iat: number;
  /** Expiry, epoch milliseconds. */
  exp: number;
}

/** The session user a host `login`/`session` hook returns to mint a cookie. */
export interface ConsoleSessionUser {
  id: string;
  name?: string;
  roles?: string[];
}

export interface SignOptions {
  secret: string;
  ttlMs: number;
  /** Injectable clock (epoch ms) for deterministic tests. Defaults to `Date.now()`. */
  now?: number;
}

export interface VerifyOptions {
  secret: string;
  now?: number;
}

function base64urlEncode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64urlDecode(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Sign a session into the cookie value `base64url(payload).base64url(hmac)`. Stateless
 * HMAC-SHA256, no store — `node:crypto` only, no JWT dependency.
 */
export function signSessionCookie(user: ConsoleSessionUser, options: SignOptions): string {
  const issuedAt = options.now ?? Date.now();
  const session: ConsoleSession = {
    sub: user.id,
    ...(user.name !== undefined ? { name: user.name } : {}),
    roles: user.roles ?? [],
    iat: issuedAt,
    exp: issuedAt + options.ttlMs,
  };
  const encodedPayload = base64urlEncode(JSON.stringify(session));
  return `${encodedPayload}.${hmac(options.secret, encodedPayload)}`;
}

/** Type guard for the decoded payload shape — defends against tampered/legacy payloads. */
function isSessionPayload(value: unknown): value is ConsoleSession {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.sub !== 'string') return false;
  if (record.name !== undefined && typeof record.name !== 'string') return false;
  if (!Array.isArray(record.roles)) return false;
  if (!record.roles.every((role) => typeof role === 'string')) return false;
  if (typeof record.iat !== 'number' || !Number.isFinite(record.iat)) return false;
  if (typeof record.exp !== 'number' || !Number.isFinite(record.exp)) return false;
  return true;
}

/**
 * Verify a cookie value and return the session, or `null` for anything tampered, malformed, or
 * expired (past `exp` + a 30s grace). Constant-time signature comparison. NEVER throws — any parse
 * failure yields `null`.
 */
export function verifySessionCookie(value: string, options: VerifyOptions): ConsoleSession | null {
  try {
    const dot = value.indexOf('.');
    if (dot <= 0 || dot === value.length - 1) return null;
    const encodedPayload = value.slice(0, dot);
    const provided = Buffer.from(value.slice(dot + 1), 'base64url');
    const expected = Buffer.from(hmac(options.secret, encodedPayload), 'base64url');
    // timingSafeEqual throws on a length mismatch — guard it so a wrong-length (tampered)
    // signature returns null instead of throwing.
    if (provided.length !== expected.length) return null;
    if (!timingSafeEqual(provided, expected)) return null;
    const decoded: unknown = JSON.parse(base64urlDecode(encodedPayload));
    if (!isSessionPayload(decoded)) return null;
    const now = options.now ?? Date.now();
    if (now > decoded.exp + EXP_GRACE_MS) return null;
    return decoded;
  } catch {
    return null;
  }
}

/** Host hook for Mode A — validates the host's own auth on the raw AdonisJS request. */
export type SessionHook = (
  request: unknown,
) => Promise<ConsoleSessionUser | null> | ConsoleSessionUser | null;

/** Host hook for Mode B — validates submitted credentials from the built-in login screen. */
export type LoginHook = (
  username: string,
  password: string,
) => Promise<ConsoleSessionUser | null> | ConsoleSessionUser | null;

/** Re-checks a LIVE session when the cookie is slid forward. Return `false` to revoke. */
export type RevalidateHook = (session: ConsoleSessionUser) => Promise<boolean> | boolean;

export type AuthMode = 'session' | 'login';

/** Author-facing `auth` option on `config/media_dashboard.ts`. Mirrors the NestJS console's shape. */
export interface ConsoleAuthOptions {
  /** REQUIRED HMAC-SHA256 signing key. Missing/empty => boot error (fail closed). */
  secret: string;
  /** Cookie TTL as a duration string (`'8h'`, `'30m'`, `'7d'`). Default `'8h'`. */
  ttl?: string;
  /** Mode A: validate the host's own auth on the raw request. */
  session?: SessionHook;
  /** Mode B: validate credentials from the built-in login screen. */
  login?: LoginHook;
  /** Re-checks the session on sliding renewal. Not a mode — it cannot mint a session on its own. */
  revalidate?: RevalidateHook;
}

/** Resolved, validated console-auth config shared by the guard and the auth routes. */
export interface ResolvedConsoleAuth {
  secret: string;
  ttlMs: number;
  modes: AuthMode[];
  session?: SessionHook;
  login?: LoginHook;
  revalidate?: RevalidateHook;
}

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;
const DURATION_UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/** Parse a `'<number><s|m|h|d>'` duration to ms; falls back to the 8h default on a bad value. */
function durationToMs(ttl: string | undefined): number {
  if (ttl === undefined) return DEFAULT_TTL_MS;
  const match = /^(\d+)([smhd])$/.exec(ttl.trim());
  if (!match) return DEFAULT_TTL_MS;
  const unit = DURATION_UNITS[match[2] ?? ''];
  if (unit === undefined) return DEFAULT_TTL_MS;
  return Number(match[1]) * unit;
}

/**
 * Validate + resolve the `auth` option. Returns `null` when unconfigured (the console stays open —
 * front it with your own `middleware`). Throws at boot (fail closed) when configured but missing a
 * secret or any hook — the host learns immediately rather than shipping an un-mintable gate.
 */
export function resolveConsoleAuth(
  options: ConsoleAuthOptions | undefined,
): ResolvedConsoleAuth | null {
  if (!options) return null;
  if (!options.secret) {
    throw new Error('media-dashboard: auth.secret is required when `auth` is configured.');
  }
  const modes: AuthMode[] = [];
  if (options.session) modes.push('session');
  if (options.login) modes.push('login');
  if (modes.length === 0) {
    throw new Error('media-dashboard: auth needs a `login` and/or `session` hook.');
  }
  return {
    secret: options.secret,
    ttlMs: durationToMs(options.ttl),
    modes,
    ...(options.session ? { session: options.session } : {}),
    ...(options.login ? { login: options.login } : {}),
    ...(options.revalidate ? { revalidate: options.revalidate } : {}),
  };
}
