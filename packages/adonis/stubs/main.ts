import { fileURLToPath } from 'node:url';

let cached: string | undefined;

/**
 * Absolute path to the published stubs directory (`dist/stubs/`).
 *
 * Computed lazily on first call — NOT at module import — and memoized. Importing this package
 * (or anything that transitively re-exports `configure`, which `src/index.ts` does) must not
 * evaluate `fileURLToPath(new URL('./', import.meta.url))` at load time: under a non-`file:`
 * `import.meta.url` (e.g. vitest's jsdom environment loading the built dist) that eager call
 * throws `TypeError: The URL must be of scheme file`, breaking every consumer that merely
 * imports `@adonis-agora/media`. Deferring it to first use — only reached during an actual
 * `node ace configure`, where `import.meta.url` is a real `file:` URL — removes the hazard.
 */
export function stubsRoot(): string {
  if (cached === undefined) {
    cached = fileURLToPath(new URL('./', import.meta.url));
  }
  return cached;
}
