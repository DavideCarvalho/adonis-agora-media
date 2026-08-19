/**
 * Type-checks every PUBLISHED stub the way a consumer app does: a scratch AdonisJS-shaped app that
 * depends on `@adonis-agora/media` and `@adonisjs/*` by NAME, with each stub rendered into the file it
 * actually generates, compiled by a real `tsc --noEmit` under NodeNext + strict.
 *
 * WHY THIS EXISTS. A `.stub` is a template that no tsconfig `include` reaches, so it is invisible to
 * every other gate in this repo. The package's own typecheck compiles `src/` against the library's OWN
 * types, which are trivially happy with themselves, and `stubs.spec.ts` only asserts the stubs exist
 * and get copied into `dist/`. Nothing looks at whether the code `node ace configure` hands a user
 * compiles — so a stub can reference a shape the real `@adonisjs/lucid` types reject, or import a
 * symbol the barrel no longer exports, while the whole suite stays green.
 *
 * Two ecosystem failures motivated this, both shipped through full green suites: three Agora libs
 * published 0-byte config stubs (a de-backtick commit emptied the file instead of the backticks), and
 * `@adonis-agora/agent` published a migration whose `up()` did not compile under Lucid 22 — its
 * structural `rawQuery` declared `bindings?: unknown[]`, not assignable in either direction to Lucid's
 * `RawQueryBindings`, so no per-connection client satisfied it. Ported from `@adonis-agora/durable`'s
 * harness, adapted to this package's four stubs.
 *
 * Resolution matters as much as compilation. The scratch app reaches the package through its `exports`
 * map, so what is checked is the PUBLISHED `dist/**\/*.d.ts` a consumer installs — not `src/`, which a
 * check run inside this repo would otherwise pick up. That is the difference that makes this able to
 * catch an export-map regression at all: the library's own imports are relative and never notice.
 *
 * Exits 0 on success; on failure prints tsc's diagnostics and exits non-zero.
 * Driven by `stub-typecheck.spec.ts`.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * Every stub `configure` publishes, with the path it writes to. All four emit typed TypeScript that
 * imports from this package or from `@adonisjs/lucid`, so all four would break a consumer's build if a
 * signature or an export drifted. The migration filenames are the generator's
 * `${Date.now()}_<name>.ts` shape with the timestamp fixed, so the compiled set is deterministic.
 */
const STUBS = [
  { stub: 'config/media.stub', to: 'config/media.ts' },
  { stub: 'config/media_dashboard.stub', to: 'config/media_dashboard.ts' },
  {
    stub: 'database/migrations/create_media_table.stub',
    to: 'database/migrations/1785200000000_create_media_table.ts',
  },
  {
    stub: 'database/migrations/create_media_upload_sessions_table.stub',
    to: 'database/migrations/1785200000001_create_media_upload_sessions_table.ts',
  },
];

/**
 * The commented-out examples inside the config stubs, compiled as extra files.
 *
 * Compiling only what a stub leaves LIVE checks almost nothing here: `config/media_dashboard.stub`
 * ships 21 commented lines around 3 live ones, so its `defineConfig({})` type-checks while every
 * option it documents could have drifted out of the published types unnoticed. `config/media.stub`
 * is nearly as dark — `delivery` and the whole `uploads` block are commented, and they are the ONLY
 * users of its `uploadSessions` import.
 *
 * A commented example is still shipped code: a user uncomments it and expects it to compile. So each
 * block below is uncommented mechanically — one comment level stripped, which turns `// uploads: {`
 * into code while leaving the prose inside it (`//   // Session-backed…`) as a comment — and the
 * result is compiled in place, so every key is checked against the position it actually occupies.
 *
 * Anchors are exact whole lines and must match EXACTLY ONCE. If a stub is reworded the harness fails
 * loudly instead of silently checking less than it claims — the failure mode this whole file exists
 * to prevent.
 */
const COMMENTED_EXAMPLES = [
  {
    stub: 'config/media.stub',
    to: 'config/media.all-options.ts',
    blocks: [
      ["  // disk: 's3', // omit to use Drive's default disk"],
      ["  // delivery: { mode: 'proxy', signedTtlSeconds: 300 },"],
      ['  // uploads: {', '  // },'],
    ],
  },
  {
    stub: 'config/media_dashboard.stub',
    to: 'config/media_dashboard.all-options.ts',
    blocks: [
      [
        '  // enabled: true,',
        '  // middleware: middleware.auth(),      // gate the whole console — SPA + API',
      ],
      ['  // auth: {', '  // },'],
    ],
    /**
     * The two symbols the dashboard examples borrow from the host app, so the check stays on what
     * this package owns — the shape of `auth`, `disks`, `actions` — instead of failing on
     * `#start/kernel`, which a scratch app has no reason to provide.
     *
     * `auth(): never` deliberately leaves that one VALUE unchecked: what a host's middleware returns
     * is the host's business, and typing it as this package's own `DashboardMiddleware` would only
     * assert the check against itself. The `middleware` KEY is still verified — an option that no
     * longer exists on the config type fails excess-property checking regardless of its value.
     */
    preamble: [
      'declare const env: { get(key: string): string }',
      'declare const middleware: { auth(): never }',
      '',
    ].join('\n'),
  },
];

/**
 * Strip exactly one comment level from every line of each anchored block, leaving the rest of the
 * stub untouched. One level is the load-bearing detail: it promotes `// uploads: {` to code while
 * demoting the nested prose `//   // Session-backed…` to an ordinary comment rather than to syntax.
 */
function uncomment({ stub, blocks, preamble }) {
  const rendered = render({ stub });
  const lines = rendered.split('\n');
  const marked = new Set();

  for (const [start, end] of blocks.map((b) => [b[0], b[1] ?? b[0]])) {
    const at = (needle) => {
      const hits = [];
      for (const [i, line] of lines.entries()) if (line.trimEnd() === needle) hits.push(i);
      if (hits.length !== 1) {
        throw new Error(
          `anchor ${JSON.stringify(needle)} matched ${hits.length} lines in ${stub} — expected exactly 1. The stub changed; update the anchors in this harness rather than dropping the block.`,
        );
      }
      return hits[0];
    };
    const from = at(start);
    const to = at(end);
    if (to < from) throw new Error(`anchors are inverted in ${stub}`);
    for (let i = from; i <= to; i += 1) marked.add(i);
  }

  const out = lines
    .map((line, i) => (marked.has(i) ? line.replace(/^(\s*)\/\/ ?/, '$1') : line))
    .join('\n');

  return (preamble ?? '') + out;
}

/**
 * Render a stub the way the generator does. Every stub here carries exactly one template construct —
 * the `{{{ exports({ to: ... }) }}}` destination header — which the generator consumes to decide where
 * the file lands and never emits.
 *
 * Deliberately strict in both directions: a missing header means the render assumption is broken (the
 * file would be checked with a stray header in it), and ANY leftover `{{ … }}` is a hard failure rather
 * than a silent pass. A stub that grows a construct this renderer does not model would otherwise reach
 * `tsc` with literal braces in it — which reads as a compile error nobody can explain, or worse, gets
 * "fixed" by loosening the check until it stops looking at anything.
 */
function render({ stub }) {
  const source = readFileSync(join(pkgRoot, 'stubs', stub), 'utf8');

  if (source.trim() === '') throw new Error(`${stub} is empty — nothing would be generated`);

  const out = source.replace(/\{\{\{[\s\S]*?\}\}\}\n/, '');
  if (out === source)
    throw new Error(`no {{{ exports() }}} header in ${stub} — render assumption broken`);

  const leftover = out.match(/\{\{.*?\}\}/);
  if (leftover) throw new Error(`unrendered template syntax ${leftover[0]} left in ${stub}`);
  if (out.trim() === '') throw new Error(`${stub} renders to nothing but its header`);

  return out;
}

/**
 * Mirror the package's `node_modules` into the scratch app, entry by entry, so the stubs resolve every
 * peer they import (`@adonisjs/lucid`, `@adonisjs/core`) plus anything the published declarations
 * transitively reference. Scoped directories are recreated as real directories so
 * `@adonis-agora/media` can be added alongside without writing into the package's own tree.
 *
 * Mirroring wholesale rather than naming a fixed list keeps the harness from rotting: a new peer is
 * picked up automatically instead of failing here as a confusing missing-types error.
 */
function linkDependencies(appRoot) {
  const from = join(pkgRoot, 'node_modules');
  const to = join(appRoot, 'node_modules');
  mkdirSync(to, { recursive: true });

  for (const entry of readdirSync(from)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      mkdirSync(join(to, entry), { recursive: true });
      for (const scoped of readdirSync(join(from, entry))) {
        symlinkSync(join(from, entry, scoped), join(to, entry, scoped));
      }
      continue;
    }
    symlinkSync(join(from, entry), join(to, entry));
  }

  // The package under test, resolved BY NAME through its `exports` map → `dist/**/*.d.ts`.
  mkdirSync(join(to, '@adonis-agora'), { recursive: true });
  symlinkSync(pkgRoot, join(to, '@adonis-agora/media'));
}

const appRoot = mkdtempSync(join(tmpdir(), 'media-stub-typecheck-'));
try {
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({ name: 'media-stub-typecheck-app', type: 'module', private: true }, null, 2),
  );
  linkDependencies(appRoot);

  for (const spec of STUBS) {
    const target = join(appRoot, spec.to);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, render(spec));
  }

  for (const spec of COMMENTED_EXAMPLES) {
    const target = join(appRoot, spec.to);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, uncomment(spec));
  }

  /**
   * An AdonisJS app's own compiler options: NodeNext + strict, which is what `@adonisjs/tsconfig` sets.
   * Both matter — NodeNext is what makes the package's `exports` map (and therefore its subpath
   * declarations) the thing being resolved, and `strict` is what turns a variance mismatch from a
   * silent widening into a hard error.
   */
  writeFileSync(
    join(appRoot, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022'],
          types: ['node'],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          esModuleInterop: true,
          experimentalDecorators: true,
        },
        include: ['config/**/*.ts', 'database/**/*.ts'],
      },
      null,
      2,
    ),
  );

  try {
    execFileSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', join(appRoot, 'tsconfig.json')], {
      cwd: appRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (error) {
    console.error('stub typecheck: FAILED — a published stub does not compile in a consumer app');
    console.error(error.stdout ?? '');
    console.error(error.stderr ?? '');
    process.exit(1);
  }
} finally {
  // `STUB_TYPECHECK_KEEP=1` leaves the scratch app on disk and prints its path — the only practical
  // way to inspect what was actually compiled, especially the uncommented variants.
  if (process.env.STUB_TYPECHECK_KEEP) console.error(`scratch app kept at ${appRoot}`);
  else rmSync(appRoot, { recursive: true, force: true });
}

console.log(
  `stub typecheck: OK (${STUBS.length} stubs, ${COMMENTED_EXAMPLES.length} with their commented examples uncommented)`,
);
