import type { ApplicationService } from '@adonisjs/core/types';

/**
 * Standalone entry point for the media-management console — kept for hosts that prefer registering
 * `@adonis-agora/media-dashboard` explicitly (or already do). As of this package's `7.0.0`, the
 * console ships EMBEDDED in `@adonis-agora/media` itself (`node ace configure @adonis-agora/media`
 * wires it up for free, no separate install), and this provider is now a thin delegate to that
 * embedded one — it carries no logic of its own, so a fix to the console applies to both entry points
 * with nothing to keep in sync by hand.
 *
 * Delegating via a runtime `import()` of the bare specifier — rather than a static
 * `import ... from '@adonis-agora/media/dashboard_provider'` — is deliberate, not a style choice:
 * `@adonis-agora/media` is a required PEER of this package (real consumers always have it installed),
 * and it must NOT become a workspace dependency here, because that would close a build cycle
 * (`@adonis-agora/media` depends on `@adonis-agora/media-dashboard` at build time, to copy this
 * package's built SPA into its own `dist`). The specifier is therefore resolved at runtime, out of
 * the consumer's own `node_modules`.
 *
 * For TYPES this package pins an exact PUBLISHED `@adonis-agora/media` as a devDependency — the floor
 * of the peer range, resolved from the registry rather than from the workspace, so it adds no
 * workspace-graph edge and no build-cycle risk. It is written as an `npm:` alias
 * (`npm:@adonis-agora/media@<floor>`) because a plain version would be rewritten by changesets, on
 * every release, to the version being published — which is not on the registry yet when the version
 * PR runs its install. That pin is what makes this import resolve, and it
 * makes it resolve deterministically: before it existed, whether this file compiled depended on
 * which published version pnpm's `auto-install-peers` happened to materialise, and the build passed
 * only because the lockfile pinned a version OLD enough to predate the `./dashboard_provider`
 * export. Refreshing the lockfile was enough to break it.
 *
 * ```ts
 * providers: [
 *   () => import('@adonis-agora/media/media_provider'),
 *   () => import('@adonis-agora/media-dashboard/media_dashboard_provider'),
 * ]
 * ```
 */
export default class MediaDashboardProvider {
  #inner: { boot?(): unknown | Promise<unknown> } | undefined;

  constructor(protected app: ApplicationService) {}

  async #resolveInner(): Promise<{ boot?(): unknown | Promise<unknown> }> {
    if (!this.#inner) {
      // The specifier stays a literal (rather than going through a variable) so the test config can
      // alias it to a fixture — see media_dashboard_provider.spec.ts. The structural cast keeps this
      // delegate tolerant of every peer version in range, not just the pinned one it typechecks
      // against: all it ever needs is a default-exported class taking the app and exposing `boot`.
      const mod = (await import('@adonis-agora/media/dashboard_provider')) as unknown as {
        default: new (app: ApplicationService) => { boot?(): unknown | Promise<unknown> };
      };
      this.#inner = new mod.default(this.app);
    }
    return this.#inner;
  }

  async boot(): Promise<void> {
    const inner = await this.#resolveInner();
    await inner.boot?.();
  }
}
