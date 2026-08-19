import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `engines.node` must stay a RANGE, never an exact version.
 *
 * The repo's `renovate.json` sets `rangeStrategy: "pin"` globally, and Renovate happily applies that
 * to `engines` too — rewriting `">=20.6.0"` into `"v22.23.2"`. A published package that pins an exact
 * Node makes every consumer on any other version emit an engine warning on install (and fail outright
 * under `engine-strict`), for a constraint the package never actually had. A `matchDepTypes:
 * ["engines"], enabled: false` rule in `renovate.json` prevents it; this test is the backstop that
 * notices if that rule is ever dropped.
 */

// `new URL` rather than `import.meta.dirname`, which only exists from Node 20.11 — this package
// declares `engines.node: ">=20.6.0"`, and a test asserting that field must not itself need more.
const PACKAGES_DIR = fileURLToPath(new URL('../..', import.meta.url));

/** A range is anything carrying a comparator/wildcard — `>=`, `^`, `~`, `||`, `-`, `x`, `*`. */
const RANGE = /(>=|<=|>|<|\^|~|\|\||\s-\s|x|\*)/;

function publishableManifests(): { name: string; manifest: Record<string, unknown> }[] {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIR, entry.name, 'package.json'))
    .map((path) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)
    .filter((manifest) => manifest.private !== true)
    .map((manifest) => ({ name: String(manifest.name), manifest }));
}

/**
 * A `^` or `~` range over a 0.x peer is a latent install failure, not a style nit.
 *
 * Under semver, caret does not cross a minor below 1.0 — `^0.4.0` means `>=0.4.0 <0.5.0`. Every
 * minor release of that peer therefore falls out of range. pnpm downgrades an unsatisfied peer to a
 * warning, so a monorepo never notices; **npm treats it as `ERESOLVE` and refuses to install**, even
 * when the peer is marked optional. Verified against the published artifact:
 *
 * ```
 * While resolving: @adonis-agora/media@0.12.0
 * Found: @adonis-agora/telescope@0.8.1
 * Conflicting peer dependency: @adonis-agora/telescope@0.4.0
 * ```
 *
 * The rule is not "no pinning" — it is "say what you mean". An explicit `>=0.33.0 <0.34.0` is
 * accepted here; a caret that silently means the same thing is not, because it was almost never
 * intended and rots on the peer's next release.
 */
const ZERO_X_CARET_OR_TILDE = /(^|\|\|\s*)[\^~]\s*0\./;

describe('peer ranges', () => {
  const peers = publishableManifests().flatMap(({ name, manifest }) =>
    Object.entries((manifest.peerDependencies as Record<string, string>) ?? {}).map(
      ([peer, range]) => ({ pkg: name, peer, range }),
    ),
  );

  it('has peers to check', () => {
    expect(peers.length).toBeGreaterThan(0);
  });

  it.each(peers)('$pkg: $peer $range does not caret/tilde a 0.x peer', ({ peer, range }) => {
    expect(
      ZERO_X_CARET_OR_TILDE.test(range),
      `"${peer}": "${range}" pins a 0.x peer with ^ or ~, which excludes every later minor and makes npm fail with ERESOLVE. Write the range you actually mean, e.g. ">=0.4.0 <1.0.0".`,
    ).toBe(false);
  });
});

describe('published package manifests', () => {
  const manifests = publishableManifests();

  it('finds every workspace package', () => {
    expect(manifests.map((entry) => entry.name).sort()).toEqual([
      '@adonis-agora/media',
      '@adonis-agora/media-dashboard',
      '@adonis-agora/media-react',
    ]);
  });

  it.each(manifests)(
    '$name declares engines.node as a range, not an exact version',
    ({ manifest }) => {
      const node = (manifest.engines as { node?: string } | undefined)?.node;
      expect(node, 'engines.node must be declared').toBeTypeOf('string');
      expect(
        RANGE.test(node as string),
        `engines.node is "${node}" — an exact version. Use a range such as ">=20.6.0"; Renovate's global rangeStrategy:pin must not reach engines.`,
      ).toBe(true);
    },
  );
});
