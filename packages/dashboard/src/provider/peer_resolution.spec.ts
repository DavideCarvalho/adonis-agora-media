import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `@adonis-agora/media` is a peer of this package, and an exact published copy is pinned as a
 * devDependency so its types resolve deterministically (a version picked by pnpm's
 * `auto-install-peers` used to decide whether the build passed). These pin the three properties
 * that keep that pin sound, asserting against the installed package on disk.
 */

// Paths off `process.cwd()` (the package root under vitest) rather than `import.meta.url`, which
// the jsdom environment does not hand back as a `file:` URL.
const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

const MEDIA = '@adonis-agora/media';

describe('the @adonis-agora/media peer', () => {
  it('declares a peer range wide enough that a minor bump cannot leave it', () => {
    const range = pkg.peerDependencies[MEDIA];
    // `^0.11.0` would be left behind by 0.12.0, which is what made changesets rewrite this field
    // and desynchronise the lockfile — a range the release could no longer install from.
    // The optional `|| >=1.0.0-rc.0 <2.0.0` clause admits 1.0.0 prereleases (`1.0.0-rc.N`), which
    // semver keeps out of a plain `<2.0.0` range; without it changesets rewrites this field to an
    // empty `>=1.0.0-rc.0 <1.0.0` when media is versioned in `rc` pre mode.
    expect(range).toMatch(
      /^>=\d+\.\d+\.\d+ <\d+\.\d+\.\d+( \|\| >=\d+\.\d+\.\d+-rc\.\d+ <\d+\.\d+\.\d+)?$/,
    );
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

  it('resolves to that copy on disk', () => {
    const installed = JSON.parse(
      readFileSync(resolve(process.cwd(), 'node_modules', MEDIA, 'package.json'), 'utf8'),
    ) as { version: string };

    expect(installed.version).toBe(pkg.devDependencies[MEDIA]?.split('@').pop());
  });
});
