/**
 * Type-checks every PUBLISHED stub the way a consumer app receives it: each stub rendered by the REAL
 * AdonisJS stubs engine into the destination its own header declares, inside a scratch app that
 * depends on `@adonis-agora/media` and `@adonisjs/*` by NAME, then compiled by a real `tsc --noEmit`
 * under NodeNext + strict.
 *
 * WHY THIS EXISTS. A `.stub` is a template no tsconfig `include` reaches, so nothing else here checks
 * the code `node ace configure` hands a user. The package's own typecheck compiles `src/` against the
 * library's own types, which are trivially happy with themselves, and `stubs.spec.ts` only asserts the
 * files exist and are copied into `dist/` — packaging, not compilation. Three Agora libs published
 * 0-byte config stubs through that gap, and `@adonis-agora/agent` published a migration whose `up()`
 * did not compile under Lucid 22.
 *
 * WHY THE REAL ENGINE. An earlier version of this file stripped the `{{{ exports() }}}` header with a
 * regex and treated the remainder as the output. That is not what the generator does:
 * `codemods.makeUsingStub` compiles the body into a JS **template literal**, so a bare backtick in the
 * body closes that literal and a bare `${` opens an interpolation — either throws before a single byte
 * is written. A regex renderer cannot see that, and sibling packages proved the cost: their harnesses
 * reported every stub healthy for a `configure` that could not write any file at all (authz 3/3,
 * agent 4/4, durable 4/5 throwing). Injecting a type error into each stub only proves the COMPILER is
 * connected; it says nothing about the input being real. So the input is now the real thing.
 *
 * WHAT IS CHECKED, on three axes:
 *  1. `stubs/` renders through the engine — no throw, a declared destination, non-empty contents;
 *  2. `dist/stubs/` — what a consumer actually installs — renders byte-identically to `stubs/`;
 *  3. the rendered output compiles, resolved BY NAME through the package's `exports` map, so the
 *     shipped `dist/**\/*.d.ts` is what the stubs are checked against and an export-map regression is
 *     visible (the library's own imports are relative and never notice one).
 *
 * Exits 0 on success; on failure prints diagnostics and exits non-zero.
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
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';

const pkgRoot = fileURLToPath(new URL('../../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
const srcStubs = join(pkgRoot, 'stubs');
const distStubs = join(pkgRoot, 'dist/stubs');

/** Every stub `configure` publishes. Destinations come from each stub's own header, not from here. */
const STUBS = [
  'config/media.stub',
  'config/media_dashboard.stub',
  'database/migrations/create_media_table.stub',
  'database/migrations/create_media_upload_sessions_table.stub',
];

/**
 * The list above must match what `configure.ts` actually publishes. A stub added there but not here
 * would leave this gate quietly covering less than the package ships — the same "untested became
 * tested-and-green" failure this file exists to prevent, one level up.
 */
function assertStubListMatchesConfigure() {
  const configure = readFileSync(join(pkgRoot, 'configure.ts'), 'utf8');
  const published = [...configure.matchAll(/'([\w/]+\.stub)'/g)].map((m) => m[1]);
  const missing = published.filter((p) => !STUBS.includes(p));
  const extra = STUBS.filter((p) => !published.includes(p));
  if (missing.length || extra.length) {
    throw new Error(
      `STUBS is out of sync with configure.ts — listed but not published: [${extra}]; published but unchecked: [${missing}]`,
    );
  }
}

/**
 * The commented-out examples inside the config stubs, compiled as extra files.
 *
 * Compiling only what a stub leaves LIVE checks almost nothing here: `config/media_dashboard.stub`
 * ships 21 commented lines around 3 live ones, so its `defineConfig({})` type-checks while every
 * option it documents could have drifted out of the published types unnoticed. `config/media.stub`
 * is nearly as dark — `delivery` and the whole `uploads` block are commented, and they are the ONLY
 * users of its `uploadSessions` import.
 *
 * A commented example is still shipped code: a user uncomments it and expects it to compile. Each
 * block is uncommented mechanically — one comment level stripped, which promotes `// uploads: {` to
 * code while leaving the prose nested inside it (`//   // Session-backed…`) an ordinary comment — and
 * compiled in place, so every key is checked against the position it actually occupies.
 *
 * Anchors are exact whole lines matched against the RENDERED output and must match EXACTLY ONCE. If a
 * stub is reworded the harness fails loudly instead of silently checking less than it claims.
 */
const COMMENTED_EXAMPLES = {
  'config/media.stub': {
    suffix: 'all-options',
    blocks: [
      ["  // disk: 's3', // omit to use Drive's default disk"],
      ["  // delivery: { mode: 'proxy', signedTtlSeconds: 300 },"],
      ['  // uploads: {', '  // },'],
    ],
  },
  'config/media_dashboard.stub': {
    suffix: 'all-options',
    blocks: [
      [
        '  // enabled: true,',
        '  // middleware: middleware.auth(),      // gate the whole console — SPA + API',
      ],
      ['  // auth: {', '  // },'],
    ],
    /**
     * The two symbols the dashboard examples borrow from the host app, so the check stays on what this
     * package owns — the shape of `auth`, `disks`, `actions` — instead of failing on `#start/kernel`,
     * which a scratch app has no reason to provide.
     *
     * `auth(): never` deliberately leaves that one VALUE unchecked: what a host's middleware returns is
     * the host's business, and typing it as this package's own `DashboardMiddleware` would only assert
     * the check against itself. The `middleware` KEY is still verified — an option that no longer
     * exists on the config type fails excess-property checking regardless of its value.
     */
    preamble: [
      'declare const env: { get(key: string): string }',
      'declare const middleware: { auth(): never }',
      '',
    ].join('\n'),
  },
};

/**
 * Boot the minimum AdonisJS app the stubs engine needs, rooted AT the scratch consumer app. Rooting it
 * there is what lets each stub's own `exports({ to: app.configPath(...) })` header resolve to a real
 * destination inside that app — so nothing here computes a path; the stub declares it.
 */
async function bootApp(appRoot) {
  const app = new AppFactory().create(pathToFileURL(`${appRoot}/`), () => {});
  await app.init();
  await app.boot();
  return app;
}

/**
 * Render one stub through the SAME engine `node ace configure` uses. `prepare()` is `generate()`
 * without the disk write: real template compilation, real header evaluation, real destination.
 * Throws whatever the engine throws — which is the point.
 */
async function renderStub(app, stubPath, source) {
  const stub = await (await app.stubs.create()).build(stubPath, { source });
  const prepared = await stub.prepare({});
  const to = prepared.attributes?.to;
  if (!to)
    throw new Error(
      `${stubPath} declared no destination — its exports() header is missing or empty`,
    );
  if (prepared.contents.trim() === '') throw new Error(`${stubPath} rendered to nothing`);
  return { contents: prepared.contents, to };
}

/**
 * Strip exactly one comment level from every line of each anchored block, leaving the rest untouched.
 * One level is the load-bearing detail: it promotes `// uploads: {` to code while demoting the nested
 * prose `//   // Session-backed…` to an ordinary comment rather than to syntax.
 */
function uncomment(rendered, stubPath, { blocks, preamble }) {
  const lines = rendered.split('\n');
  const marked = new Set();

  for (const [start, end] of blocks.map((b) => [b[0], b[1] ?? b[0]])) {
    const at = (needle) => {
      const hits = [];
      for (const [i, line] of lines.entries()) if (line.trimEnd() === needle) hits.push(i);
      if (hits.length !== 1) {
        throw new Error(
          `anchor ${JSON.stringify(needle)} matched ${hits.length} lines in ${stubPath} — expected exactly 1. The stub changed; update the anchors in this harness rather than dropping the block.`,
        );
      }
      return hits[0];
    };
    const from = at(start);
    const to = at(end);
    if (to < from) throw new Error(`anchors are inverted in ${stubPath}`);
    for (let i = from; i <= to; i += 1) marked.add(i);
  }

  const body = lines
    .map((line, i) => (marked.has(i) ? line.replace(/^(\s*)\/\/ ?/, '$1') : line))
    .join('\n');
  return (preamble ?? '') + body;
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

assertStubListMatchesConfigure();

const appRoot = mkdtempSync(join(tmpdir(), 'media-stub-typecheck-'));
try {
  writeFileSync(
    join(appRoot, 'package.json'),
    JSON.stringify({ name: 'media-stub-typecheck-app', type: 'module', private: true }, null, 2),
  );
  linkDependencies(appRoot);

  const app = await bootApp(appRoot);

  for (const stubPath of STUBS) {
    // What the consumer installs is `dist/stubs`; `stubs/` is only its source. Rendering both and
    // comparing catches a stale or mangled copy, and what gets compiled below is the dist rendering.
    const fromSrc = await renderStub(app, stubPath, srcStubs);
    const fromDist = await renderStub(app, stubPath, distStubs);
    if (fromSrc.contents !== fromDist.contents) {
      throw new Error(
        `dist/stubs/${stubPath} renders differently from stubs/${stubPath} — the published copy is stale or mangled`,
      );
    }

    // The stub's OWN header decided this path; nothing here computes it.
    mkdirSync(dirname(fromDist.to), { recursive: true });
    writeFileSync(fromDist.to, fromDist.contents);

    const example = COMMENTED_EXAMPLES[stubPath];
    if (example) {
      const variant = fromDist.to.replace(/\.ts$/, `.${example.suffix}.ts`);
      writeFileSync(variant, uncomment(fromDist.contents, stubPath, example));
    }
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
  // way to inspect what was actually rendered and compiled.
  if (process.env.STUB_TYPECHECK_KEEP) console.error(`scratch app kept at ${appRoot}`);
  else rmSync(appRoot, { recursive: true, force: true });
}

console.log(
  `stub typecheck: OK (${STUBS.length} stubs rendered by the real engine from stubs/ and dist/stubs/, ${Object.keys(COMMENTED_EXAMPLES).length} with their commented examples uncommented)`,
);
