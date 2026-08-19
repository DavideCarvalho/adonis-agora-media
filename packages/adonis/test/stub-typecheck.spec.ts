import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * Compiles every PUBLISHED stub inside a scratch consumer app, against the REAL `@adonisjs/*` types.
 *
 * This closes a coverage gap that is invisible to every other gate here. A `.stub` is a template that
 * no tsconfig `include` reaches, so nothing type-checks the code a user actually receives from
 * `node ace configure`. The package's own typecheck compiles `src/` against the library's own types,
 * which are trivially happy with themselves; `stubs.spec.ts` asserts the stubs exist and are copied
 * into `dist/`, which is a packaging check, not a compilation one. Between them a stub can go empty,
 * lose an import the barrel no longer exports, or reference a shape Lucid rejects, and every gate
 * stays green.
 *
 * Both failure modes are real and both shipped: three Agora libs published 0-byte config stubs, and
 * `@adonis-agora/agent` published a migration whose `up()` did not compile under Lucid 22 (a
 * structural `rawQuery` with `bindings?: unknown[]`, not assignable in either direction to Lucid's
 * `RawQueryBindings`). Ported from `@adonis-agora/durable`'s harness.
 *
 * Covers all four stubs `configure` publishes — both config files and both migrations — each rendered
 * as the generator writes it and compiled under NodeNext + strict with the package resolved BY NAME,
 * so what is checked is the shipped `dist/**\/*.d.ts` a consumer installs, not `src/`.
 */
describe('the published stubs compile in a consumer app (real @adonisjs types)', () => {
  const harness = fileURLToPath(new URL('./fixtures/stub-typecheck/check.mjs', import.meta.url));
  const distTypes = fileURLToPath(new URL('../dist/src/index.d.ts', import.meta.url));

  // Resolving the package by name makes a built package a precondition — that is the point, since
  // resolving through `exports` is what puts the published declarations under test. A hard failure
  // under CI (where `pnpm test` gates the publish), a convenience skip for a developer who has not
  // built yet.
  if (!existsSync(distTypes)) {
    if (process.env.CI) {
      it('type-checks the rendered stubs', () => {
        expect.fail(
          [
            `${distTypes} does not exist, so this spec cannot check anything.`,
            'It is the only check that the generated code COMPILES for a consumer; under CI a missing',
            'build is a failure, not a skip. Run `pnpm build` before `pnpm test`.',
          ].join(' '),
        );
      });
    } else {
      it.skip('dist/ does not exist — run `pnpm --filter @adonis-agora/media build` first', () => {});
    }
  } else {
    // A cold `tsc` over the Lucid + Adonis declaration graph is a few seconds; 90s is a ceiling that
    // will not flake under full-suite load but still fails rather than hangs.
    it('type-checks the rendered stubs against the published declarations', async () => {
      const { stdout } = await execFileAsync(process.execPath, [harness], { timeout: 85_000 });
      expect(stdout).toContain('stub typecheck: OK');
    }, 90_000);
  }
});
