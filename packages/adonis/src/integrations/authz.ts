import type { MediaAccessRequest, MediaAuthorizer, MediaSubject } from '../access.js';

/** The bits of `@adonis-agora/authz`'s service this integration uses (typed structurally). */
interface AuthzService {
  can(user: unknown, permission: string, options?: { scope?: unknown }): Promise<boolean>;
  hasAnyRole(user: unknown, roles: string[], options?: { scope?: unknown }): Promise<boolean>;
}

export interface AuthzRuleOptions {
  /** Explicit authz tenant scope for the check. Default: authz's own resolvers (`resolveTenant`). */
  scope?: (request: MediaAccessRequest) => unknown;
  /** @internal test seam: how the authz service is loaded. */
  load?: () => Promise<AuthzService>;
}

const importAuthz = async (): Promise<AuthzService> =>
  ((await import('@adonis-agora/authz/services/main' as string)) as { default: AuthzService })
    .default;

/**
 * What authz is asked about: the app's own user object when the identity has one (so a custom
 * `resolveSubjectRef` keeps working), otherwise the `{ type, id }` reference of the human behind
 * the request — `realId`, never the impersonated account: an admin acting as someone must not
 * gain that someone's permissions, nor lose their own.
 */
function authzSubject(subject: MediaSubject): unknown {
  if (subject.user !== undefined) return subject.user;
  return { type: subject.type ?? 'user', id: subject.realId ?? subject.id };
}

/**
 * Media authorizers backed by `@adonis-agora/authz` (an optional peer, loaded on first use).
 * Wildcards, roles → permissions, super-admins and tenancy all apply, as in any authz check.
 *
 * ```ts
 * import { authorizers } from '@adonis-agora/media'
 * import { authz } from '@adonis-agora/media/authz'
 *
 * { name: 'prescription', access: { read: authorizers.any(authorizers.owner(), authz.can('prescriptions.read')) } }
 * { name: 'reports', access: { read: authz.can(({ collection, action }) => `media.${collection}.${action}`) } }
 * ```
 */
export const authz = {
  /** The user holds `permission` (a string, or derived from the request). Anonymous ⇒ no. */
  can(
    permission: string | ((request: MediaAccessRequest) => string),
    options: AuthzRuleOptions = {},
  ): MediaAuthorizer {
    const load = options.load ?? importAuthz;
    return async (request) => {
      if (!request.subject) return false;
      const service = await load();
      const name = typeof permission === 'function' ? permission(request) : permission;
      const scope = options.scope?.(request);
      return service.can(authzSubject(request.subject), name, scope !== undefined ? { scope } : {});
    };
  },

  /** The user has any of these roles in authz (store roles, `resolveRoles`, token roles). */
  roles(roles: readonly string[], options: AuthzRuleOptions = {}): MediaAuthorizer {
    const load = options.load ?? importAuthz;
    return async (request) => {
      if (!request.subject) return false;
      const service = await load();
      const scope = options.scope?.(request);
      return service.hasAnyRole(
        authzSubject(request.subject),
        [...roles],
        scope !== undefined ? { scope } : {},
      );
    };
  },
};
