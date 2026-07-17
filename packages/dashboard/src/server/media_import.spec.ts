import { describe, expect, it } from 'vitest';

// Regression guard for the lazy-`stubsRoot` fix. `@adonis-agora/media`'s built `dist/src/index.js`
// re-exports `configure`, which imports `stubs/main`. When `stubsRoot` eagerly ran
// `fileURLToPath(new URL('./', import.meta.url))` at module load, importing the package under
// vitest's jsdom environment threw `TypeError: The URL must be of scheme file` — making EVERY spec
// that imports `@adonis-agora/media` (e.g. `service.spec.ts`) uncollectable. Deferring the
// computation to first use keeps the import side-effect-free.
describe('@adonis-agora/media import under jsdom', () => {
  it('imports cleanly without evaluating stubsRoot at load time', async () => {
    await expect(import('@adonis-agora/media')).resolves.toBeDefined();
  });
});
