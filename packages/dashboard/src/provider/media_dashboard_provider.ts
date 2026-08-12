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
 * but a static import would make this package statically depend on it, which inside THIS monorepo
 * would close a cycle (`@adonis-agora/media` already depends on `@adonis-agora/media-dashboard` at
 * build time, to copy this package's built SPA into its own `dist`). A dynamic import needs no
 * workspace-graph edge, so both packages build in either order.
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
      // @ts-expect-error — `@adonis-agora/media` is a required PEER (real consumers always have it
      // installed) but deliberately NOT a workspace/type dependency of this package inside this
      // monorepo (see the class doc comment: linking it here would close a build-time cycle). The
      // specifier stays a literal (rather than going through a variable) so `vi.mock` can intercept
      // it in tests — see media_dashboard_provider.spec.ts.
      const mod = (await import('@adonis-agora/media/dashboard_provider')) as {
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
