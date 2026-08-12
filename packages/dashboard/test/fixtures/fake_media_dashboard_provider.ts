/**
 * Test double for `@adonis-agora/media/dashboard_provider`, aliased in by `vitest.config.ts`'s
 * `resolve.alias`. `@adonis-agora/media` is a required peer of this package but deliberately not a
 * resolvable workspace/type dependency inside this monorepo (see
 * `../../src/provider/media_dashboard_provider.ts`'s doc comment: linking it here would close a
 * build-time cycle), so its subpath can't be resolved for real in these tests — the alias stands in
 * for it, letting `media_dashboard_provider.spec.ts` exercise the delegate's real `import()` call.
 */
export const bootCalls: unknown[] = [];

export default class FakeInnerProvider {
  constructor(public app: unknown) {}

  boot(): void {
    bootCalls.push(this.app);
  }
}
