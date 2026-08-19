import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The delegate in `media_dashboard_provider.ts` imports `@adonis-agora/media/dashboard_provider`.
 * Whether that import type-checks used to depend on which published `@adonis-agora/media` pnpm's
 * `auto-install-peers` happened to materialise — and the build passed only because the lockfile
 * pinned 0.10.3, which predates that subpath. A `@ts-expect-error` sat on the import to absorb the
 * failure, so the whole thing compiled *because* the peer did not resolve. Refreshing the lockfile
 * to any version >= 0.11.0 turned that directive into `TS2578: Unused '@ts-expect-error' directive`
 * and broke the build; bumping media out of the peer's range broke `--frozen-lockfile` outright.
 *
 * The resolution is explicit now — an exact published copy pinned as a devDependency — and these
 * pin the three properties that keep it that way. `vitest.config.ts` aliases the specifier for the
 * delegate's unit test, so this file asserts against the installed package on disk instead, which
 * no alias can mask.
 */

// Paths off `process.cwd()` (the package root under vitest) rather than `import.meta.url`, which
// the jsdom environment does not hand back as a `file:` URL.
const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const MEDIA = '@adonis-agora/media';

describe('the @adonis-agora/media peer this package delegates to', () => {
  it('declares a peer range wide enough that a minor bump cannot leave it', () => {
    const range = pkg.peerDependencies[MEDIA];
    // `^0.11.0` would be left behind by 0.12.0, which is what made changesets rewrite this field
    // and desynchronise the lockfile — a range the release could no longer install from.
    expect(range).toMatch(/^>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+$/);
  });

  it('pins an exact published copy for types, as an npm: alias at the range floor', () => {
    const pin = pkg.devDependencies[MEDIA];
    const floor = pkg.peerDependencies[MEDIA]?.match(/^>=(\d+\.\d+\.\d+)/)?.[1];

    // The `npm:` alias form is load-bearing, not decoration. Written as a plain `0.11.0`, changesets
    // treats this as an internal dependency out of range and rewrites it to the version being
    // released — one that is not on the registry yet — so `pnpm install` inside the version PR dies
    // with ERR_PNPM_NO_MATCHING_VERSION. Changesets leaves an alias spec alone, so the pin survives
    // every bump. (Verified by running `changeset version` against a scratch changeset both ways.)
    expect(pin).toBe(`npm:${MEDIA}@${floor}`);
  });

  it('resolves to that copy on disk, exposing the subpath the delegate imports', () => {
    const installed = JSON.parse(
      readFileSync(resolve(process.cwd(), 'node_modules', MEDIA, 'package.json'), 'utf8'),
    ) as { version: string; exports: Record<string, unknown> };

    expect(installed.version).toBe(pkg.devDependencies[MEDIA]?.split('@').pop());
    expect(installed.exports['./dashboard_provider']).toBeDefined();
  });
});
