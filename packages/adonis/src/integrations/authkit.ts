import type { MediaIdentityResolver, MediaSubject } from '../access.js';

/**
 * The bits of `@adonis-agora/authkit-server` this integration uses — typed structurally so the
 * media package carries no dependency on it.
 */
interface AuthkitServerModule {
  getAccountId(ctx: unknown): string | null;
  realAccountId(ctx: unknown): string | null;
}

/** The bits of `@adonis-agora/authkit-client` this integration uses. */
interface AuthkitClientModule {
  getAuthkit(ctx: unknown): Promise<{
    getIdentity(): Promise<{
      userId: string;
      globalRoles?: string[];
      orgId?: string | null;
    } | null>;
  }>;
}

export interface AuthkitIdentityOptions {
  /**
   * Which side of authkit this app is:
   * - `'server'` — the app IS the identity provider (`@adonis-agora/authkit-server`): the account
   *   comes from the console session (`getAccountId`, impersonation-aware; `realAccountId` for
   *   permission checks);
   * - `'client'` — the app signs in against one (`@adonis-agora/authkit-client`): the identity
   *   comes from `ctx.authkit` (`getAuthkit(ctx).getIdentity()`), with its global roles and active
   *   organization;
   * - `'auto'` (default) — the client when the request carries `ctx.authkit`, the server when its
   *   package is installed, the client otherwise.
   */
  side?: 'auto' | 'server' | 'client';
  /** Subject type handed to authz. Default `'user'`. */
  type?: string;
  /** @internal test seams: how the authkit packages are loaded. */
  load?: {
    server?: () => Promise<AuthkitServerModule>;
    client?: () => Promise<AuthkitClientModule>;
  };
}

const importServer = () =>
  import('@adonis-agora/authkit-server' as string) as Promise<AuthkitServerModule>;
const importClient = () =>
  import('@adonis-agora/authkit-client' as string) as Promise<AuthkitClientModule>;

/**
 * `access.identity` for apps on authkit — who the current user is, as authkit sees them:
 *
 * ```ts
 * // config/media.ts
 * import { authkitIdentity } from '@adonis-agora/media/authkit'
 * export default defineConfig({ access: { identity: authkitIdentity() } })
 * ```
 *
 * On the server side, `id` is the account the request acts as (an impersonating admin sees the
 * user's files) and `realId` the human behind it (what `@adonis-agora/media/authz` checks
 * permissions for). On the client side both are the token's `sub`, with its global roles and
 * active organization as `roles` / `tenantId`.
 */
export function authkitIdentity(options: AuthkitIdentityOptions = {}): MediaIdentityResolver {
  const side = options.side ?? 'auto';
  const type = options.type;
  const loadServer = options.load?.server ?? importServer;
  const loadClient = options.load?.client ?? importClient;

  const fromServer = async (ctx: unknown): Promise<MediaSubject | null> => {
    const server = await loadServer();
    const id = server.getAccountId(ctx);
    if (!id) return null;
    return { id, realId: server.realAccountId(ctx) ?? id, ...(type ? { type } : {}) };
  };

  const fromClient = async (ctx: unknown): Promise<MediaSubject | null> => {
    const client = await loadClient();
    const identity = await (await client.getAuthkit(ctx)).getIdentity();
    if (!identity) return null;
    return {
      id: identity.userId,
      realId: identity.userId,
      roles: identity.globalRoles ?? [],
      tenantId: identity.orgId ?? null,
      ...(type ? { type } : {}),
    };
  };

  return async (ctx) => {
    if (side === 'server') return fromServer(ctx);
    if (side === 'client') return fromClient(ctx);
    if ((ctx as { authkit?: unknown }).authkit) return fromClient(ctx);
    try {
      return await fromServer(ctx);
    } catch (error) {
      if (!isModuleNotFound(error)) throw error;
    }
    try {
      return await fromClient(ctx);
    } catch (error) {
      if (!isModuleNotFound(error)) throw error;
      throw new Error(
        "authkitIdentity() needs '@adonis-agora/authkit-server' (an identity-provider app) or " +
          "'@adonis-agora/authkit-client' (an app signing in against one), and neither is " +
          'installed. Install the one this app uses, or set `access.identity` to another resolver.',
        { cause: error },
      );
    }
  };
}

function isModuleNotFound(error: unknown): boolean {
  return (error as { code?: string })?.code === 'ERR_MODULE_NOT_FOUND';
}
