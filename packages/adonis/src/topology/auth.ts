import { timingSafeEqual } from 'node:crypto';
/**
 * Service-tenant auth, in the shape every Agora control plane uses: a tenant presents a bearer token
 * (`authkitTenantToken(...)` from `@adonis-agora/authkit-client`), the control plane verifies it
 * (`authkitTenantVerifier(...)`), and the partition and capabilities come from the verified token,
 * never from the request.
 */

/** What a control plane trusts about a request: derived from the verified token. */
export interface VerifiedTenant {
  /** The application (the partition). The ONLY source of the app a request acts for. */
  partition: string;
  /** `media:read`, `media:write`. */
  capabilities: string[];
  /** The service-tenant client behind the token, when it says. */
  clientId?: string;
}

/** What a verifier receives. Only `token` is trusted, once verified. */
export interface TenantAuthRequest {
  token?: string | undefined;
  /** The partition the caller claims (`x-media-app`). Advisory only: the token decides. */
  partition?: string | undefined;
  /** Same as `partition`. Advisory only. */
  tenant?: string | undefined;
  /** Same as `partition`. Advisory only. */
  app?: string | undefined;
}

/** The function form of `verifyTenant`. Authkit's `authkitTenantVerifier()` is one. */
export type TenantVerifier = (
  request: TenantAuthRequest,
) => VerifiedTenant | null | Promise<VerifiedTenant | null>;

/** A class instance implementing `verify`. */
export interface TenantVerifierObject {
  verify(request: TenantAuthRequest): VerifiedTenant | null | Promise<VerifiedTenant | null>;
}

/** A lazily imported verifier module. */
export interface TenantVerifierModule {
  default?: TenantVerifier | TenantVerifierObject | (new () => TenantVerifierObject);
  verify?: TenantVerifier | TenantVerifierObject;
  tenantVerifier?: TenantVerifier | TenantVerifierObject;
}

/** The accepted forms: a function, a class instance, a class, or a lazy `() => import(...)`. */
export type TenantVerifierInput =
  | TenantVerifier
  | TenantVerifierObject
  | (new () => TenantVerifierObject)
  | (() => Promise<TenantVerifierModule> | TenantVerifierModule);

function hasVerify(value: unknown): value is TenantVerifierObject {
  return (
    !!value &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { verify?: unknown }).verify === 'function'
  );
}

function isVerifierClass(value: unknown): value is new () => TenantVerifierObject {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { verify?: unknown } }).prototype?.verify === 'function'
  );
}

/**
 * Validates a verifier's answer. `null` refuses; `{ partition, capabilities }` accepts; anything else
 * throws, so a malformed answer is never taken for an accepted tenant. Capabilities are not
 * defaulted: a verifier must say what the token may do.
 */
export function checkVerifiedTenant(result: unknown): VerifiedTenant | null {
  if (result === null || result === undefined) return null;
  const value = result as Partial<VerifiedTenant>;
  if (
    typeof value === 'object' &&
    typeof value.partition === 'string' &&
    value.partition.length > 0 &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every((capability) => typeof capability === 'string') &&
    (value.clientId === undefined || typeof value.clientId === 'string')
  ) {
    return {
      partition: value.partition,
      capabilities: value.capabilities,
      ...(value.clientId !== undefined ? { clientId: value.clientId } : {}),
    };
  }
  throw new TypeError(
    '[@adonis-agora/media] verifyTenant must return { partition: string, capabilities: string[] } or null',
  );
}

/** Turns any `verifyTenant` form into the function the control plane calls. */
export function resolveTenantVerifier(
  input: TenantVerifierInput,
): (request: TenantAuthRequest) => Promise<VerifiedTenant | null> {
  if (isVerifierClass(input)) {
    let instance: TenantVerifierObject | undefined;
    return async (request) => {
      instance ??= new input();
      return checkVerifiedTenant(await instance.verify(request));
    };
  }
  if (hasVerify(input)) {
    return async (request) => checkVerifiedTenant(await input.verify(request));
  }
  if (typeof input !== 'function') {
    throw new TypeError(
      '[@adonis-agora/media] `verifyTenant` must be a function, an object with verify() (a class instance), or a lazy import of one',
    );
  }
  // A verifier function, or a lazy import factory: call it; a module that comes back names the
  // verifier to use from then on.
  const fn = input as (request: TenantAuthRequest) => unknown;
  let lazy: ((request: TenantAuthRequest) => Promise<VerifiedTenant | null>) | undefined;
  return async (request) => {
    if (lazy) return lazy(request);
    const result = await fn(request);
    const module =
      result && typeof result === 'object' ? (result as TenantVerifierModule) : undefined;
    const named = module?.default ?? module?.tenantVerifier ?? module?.verify;
    if (named !== undefined && !('partition' in (module as object))) {
      lazy = resolveTenantVerifier(named as TenantVerifierInput);
      return lazy(request);
    }
    return checkVerifiedTenant(result);
  };
}

/** Where a tenant gets the bearer token it presents to the control plane. */
export interface TenantToken {
  get(): Promise<string>;
  /** Drops a cached token (after a 401), so the next `get` fetches a fresh one. */
  reset?(): void;
}

/**
 * A fixed secret, a function returning a token (`authkitTenantToken(...)` from
 * `@adonis-agora/authkit-client`, whose `reset()` a 401 calls), or an object with `get()`.
 */
export type TenantTokenSource =
  | string
  | (() => Promise<string>)
  | { get(): Promise<string>; reset?(): void; invalidate?(): void };

/** Normalizes every accepted token source into {@link TenantToken}. */
export function resolveTenantToken(source: TenantTokenSource): TenantToken {
  if (typeof source === 'string') {
    if (source === '') throw new Error('[@adonis-agora/media] tenant.token is empty');
    return { get: async () => source };
  }
  if (typeof source === 'function') {
    const reset = (source as { reset?: unknown }).reset;
    return {
      get: () => source(),
      ...(typeof reset === 'function' ? { reset: () => reset.call(source) } : {}),
    };
  }
  if (source && typeof source === 'object' && typeof source.get === 'function') {
    const reset = source.reset ?? source.invalidate;
    return {
      get: () => source.get(),
      ...(typeof reset === 'function' ? { reset: () => reset.call(source) } : {}),
    };
  }
  throw new Error(
    '[@adonis-agora/media] tenant.token must be a string, a function returning a token, or an object with get()',
  );
}

/**
 * A person's own access token, verified: who they are, what the token may do. What
 * `controlPlane.accounts.verifyUser` returns — `inProcessAccessTokenVerifier(...)` (authkit-server)
 * and `verifyAccessToken(...)` (authkit-client) both answer this shape.
 */
export interface VerifiedUser {
  /** The account (`sub`): the only owner a person's token writes to. */
  sub: string;
  scopes?: readonly string[] | undefined;
  /** The OIDC client the token was issued to. */
  clientId?: string | undefined;
  /** Set on an impersonation token (`act`); such a token never writes someone's files. */
  actor?: unknown;
}

/** `Authorization: Bearer <token>`, or `undefined`. */
export function bearerOf(header: string | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  return /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1];
}

/** One app's shared secret, and what it may do (default: read and write). */
export interface SharedSecretTenant {
  secret: string;
  capabilities?: string[];
}

/** Constant-time comparison that does not leak where two secrets differ. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * One shared secret per app, compared in constant time: the app names itself with `x-media-app`
 * (the tenant client sends its `partition`), the secret proves it. For setups without authkit.
 *
 * ```ts
 * verifyTenant: sharedSecretVerifier({ partitions: { 'entre-textos': env.get('MEDIA_ET_SECRET') } })
 * ```
 */
export function sharedSecretVerifier(options: {
  partitions: Record<string, string | SharedSecretTenant>;
}): TenantVerifier {
  return (request) => {
    const app = request.app ?? request.partition ?? request.tenant;
    if (!request.token || !app || !Object.hasOwn(options.partitions, app)) return null;
    const entry = options.partitions[app]!;
    const config = typeof entry === 'string' ? { secret: entry } : entry;
    if (!config.secret || !sameSecret(request.token, config.secret)) return null;
    return {
      partition: app,
      capabilities: config.capabilities ?? ['media:read', 'media:write'],
    };
  };
}
