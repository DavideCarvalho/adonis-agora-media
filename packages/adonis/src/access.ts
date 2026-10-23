import type { MediaRecord } from './media_record.js';

/**
 * Who is asking — the library's view of the current user, produced by a
 * {@link MediaIdentityResolver} (`@adonis-agora/media/authkit` ships one; `ctx.auth.user` is the
 * default). Deliberately small: authorization rules compare ids, and anything richer is carried in
 * `user` for the integrations that need it (authz resolves its own subject from it).
 */
export interface MediaSubject {
  /**
   * The account the request acts as — what ownership is compared against. Under an admin's
   * impersonation this is the impersonated account (an admin looking as someone sees their
   * avatar).
   */
  id: string;
  /** Subject type for polymorphic setups (authz's `{ type, id }`). Default `'user'`. */
  type?: string | undefined;
  /**
   * The human really behind the request — what permission and role checks must use. Differs from
   * {@link id} only under impersonation. Default: {@link id}.
   */
  realId?: string | undefined;
  /** Global roles the identity carries (an authkit token's roles), when known. */
  roles?: readonly string[] | undefined;
  /** Active tenant/organization, when the identity carries one. */
  tenantId?: string | null | undefined;
  /** The app's own user object, if the resolver has it — passed through to integrations. */
  user?: unknown;
}

/** Reading a stored file, or putting one into a collection. */
export type MediaAction = 'read' | 'write';

/** What an authorizer is asked to decide. */
export interface MediaAccessRequest<Ctx = unknown> {
  /** The framework context of the request (an AdonisJS `HttpContext`). */
  ctx: Ctx;
  action: MediaAction;
  /** The collection the file is in (read) or is going to (write). */
  collection: string;
  /** The record being read. Absent for a write — there is no record yet. */
  record?: MediaRecord | undefined;
  /** The current user, or `null` when the request is anonymous. */
  subject: MediaSubject | null;
}

/**
 * One authorization rule: may `subject` perform `action` on this file? Compose them with
 * {@link authorizers}' `any`/`all`, or write your own — any function of this shape works.
 */
export type MediaAuthorizer<Ctx = unknown> = (
  request: MediaAccessRequest<Ctx>,
) => boolean | Promise<boolean>;

/** Turn a request into the current {@link MediaSubject}, or `null` when anonymous. */
export type MediaIdentityResolver<Ctx = unknown> = (
  ctx: Ctx,
) => MediaSubject | null | Promise<MediaSubject | null>;

/**
 * Per-collection access policy (`collections[].access`): who may read files of this collection,
 * and who may put files into it. `'public'` allows everyone. Absent ⇒ denied — the library never
 * defaults to allowing.
 */
export interface MediaCollectionAccess {
  read?: MediaAuthorizer | 'public';
  write?: MediaAuthorizer | 'public';
}

/**
 * The building blocks of media authorization. None of them knows about a specific auth library:
 * the identity comes from the configured resolver, and the authkit/authz-specific rules live in
 * `@adonis-agora/media/authkit` and `@adonis-agora/media/authz`.
 *
 * ```ts
 * import { authorizers } from '@adonis-agora/media'
 * import { authz } from '@adonis-agora/media/authz'
 *
 * authorizers.any(authorizers.owner(), authz.can('media.read.any'))
 * ```
 */
export const authorizers = {
  /** Everyone, signed in or not. */
  public(): MediaAuthorizer {
    return () => true;
  },

  /** Any signed-in user. */
  authenticated(): MediaAuthorizer {
    return ({ subject }) => subject !== null;
  },

  /**
   * The signed-in user owns the record: `record.ownerId` is their {@link MediaSubject.id} (the
   * account they act as). `ownerTypes` restricts which owner types count as "the user" — e.g.
   * `['User']`, so a `Team` that happens to share the id does not. For ownership that goes through
   * the app's own model (a family member's profile, a course's teacher), write the rule yourself.
   *
   * A write has no record yet, so `owner()` cannot allow one; pair it with `authenticated()` for
   * uploads into the user's own namespace.
   */
  owner(options: { ownerTypes?: readonly string[] } = {}): MediaAuthorizer {
    return ({ subject, record }) => {
      if (!subject || !record) return false;
      if (options.ownerTypes && !options.ownerTypes.includes(record.ownerType)) return false;
      return String(record.ownerId) === String(subject.id);
    };
  },

  /** The identity carries one of these global roles (e.g. an authkit token's roles). */
  roles(roles: readonly string[]): MediaAuthorizer {
    return ({ subject }) => Boolean(subject?.roles?.some((role) => roles.includes(role)));
  },

  /** Allowed when ANY rule allows — evaluated in order, stopping at the first yes. */
  any(...rules: MediaAuthorizer[]): MediaAuthorizer {
    return async (request) => {
      for (const rule of rules) if (await rule(request)) return true;
      return false;
    };
  },

  /** Allowed only when EVERY rule allows — evaluated in order, stopping at the first no. */
  all(...rules: MediaAuthorizer[]): MediaAuthorizer {
    return async (request) => {
      for (const rule of rules) if (!(await rule(request))) return false;
      return rules.length > 0;
    };
  },
};

/**
 * Default identity: AdonisJS auth's `ctx.auth.user` (its `id`), so an app on `@adonisjs/auth`
 * needs no configuration. Apps on authkit use `authkitIdentity()` from
 * `@adonis-agora/media/authkit`.
 */
export const adonisAuthIdentity: MediaIdentityResolver = (ctx) => {
  const user = (ctx as { auth?: { user?: { id?: unknown } | null } }).auth?.user;
  if (!user || user.id === undefined || user.id === null) return null;
  return { id: String(user.id), user };
};

/** Normalize `'public'` / an authorizer / nothing into an authorizer (nothing ⇒ deny). */
export function toAuthorizer(rule: MediaAuthorizer | 'public' | undefined): MediaAuthorizer {
  if (rule === 'public') return authorizers.public();
  return rule ?? (() => false);
}
