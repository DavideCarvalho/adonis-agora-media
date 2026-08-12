import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `@adonis-agora/media` is a required peer of this package but deliberately NOT linked as a
      // workspace/type dependency inside this monorepo (see
      // `src/provider/media_dashboard_provider.ts`'s doc comment: linking it here would close a
      // build-time cycle with `@adonis-agora/media`, which depends on this package for its built SPA).
      // Aliasing its dashboard-provider subpath to a local fixture lets the delegate's own test
      // exercise the real `import()` call without the real package being resolvable here — the same
      // way a real consumer's bundler resolves it once the peer is actually installed.
      '@adonis-agora/media/dashboard_provider': fileURLToPath(
        new URL('./test/fixtures/fake_media_dashboard_provider.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{spec,test}.{ts,tsx}'],
    pool: 'forks',
  },
});
