import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the dashboard SPA into `dist/spa`. The `base` is a placeholder (`/__MEDIA_DASHBOARD__/`)
 * that the AdonisJS provider rewrites at serve time to the configured `basePath`, so the same built
 * bundle can be mounted under any path (`/media/dashboard`, `/admin/media`, ...) without a rebuild.
 */
export default defineConfig({
  base: '/__MEDIA_DASHBOARD__/',
  plugins: [react()],
  build: {
    outDir: 'dist/spa',
    emptyOutDir: true,
    sourcemap: true,
  },
});
