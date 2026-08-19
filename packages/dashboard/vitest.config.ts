import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // `@adonis-agora/media` IS resolvable here (an exact published copy is pinned as a
      // devDependency for types — see `src/provider/media_dashboard_provider.ts`'s doc comment), but
      // this unit test is about the delegation itself, not about booting a real console. Aliasing the
      // subpath to a local fixture keeps the delegate's own test exercising the real `import()` call
      // while recording what it constructed and booted. `peer_resolution.spec.ts` covers the other
      // half — that the real specifier resolves, unaliased.
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
