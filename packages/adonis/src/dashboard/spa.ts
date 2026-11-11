/**
 * Pure helpers for mounting/serving the `@adonis-agora/media-dashboard` React SPA — split out so
 * they're unit-testable without booting AdonisJS. `dashboard_provider.ts` is a thin HTTP shell around
 * these. Ported byte-for-byte (same placeholder, same content-type table, same `renderIndexHtml`
 * contract) from `@adonis-agora/media-dashboard`'s own `provider/serve.ts`, which is now this
 * package's copy of record — mirrors `@adonis-agora/durable`'s `src/dashboard/spa.ts`, so the two
 * packages' "serve a Vite SPA from an AdonisJS provider" story stays one pattern across the Agora
 * ecosystem.
 */

/** Placeholder base Vite bakes into asset URLs (`packages/dashboard/vite.config.ts`); rewritten to
 *  the configured `basePath` at serve time — the SAME built bundle mounts at any path with no rebuild. */
export const BASE_PLACEHOLDER = '/__MEDIA_DASHBOARD__/';

export const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export interface DashboardBootstrap {
  apiBase: string;
  uploadsBase: string;
  tusBase: string;
  actions: boolean;
}

/** Normalise a mount path: leading slash, collapsed slashes, no trailing slash (root stays `/`). */
export function normalizePath(path: string): string {
  const trimmed = `/${path}`.replace(/\/+/g, '/').replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/** Content type for a served asset filename, defaulting to octet-stream. */
export function contentTypeFor(file: string): string {
  const ext = file.slice(file.lastIndexOf('.'));
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** `id` of the JSON data block `renderIndexHtml` injects; the SPA's `readBootstrap()` reads it. */
export const CONFIG_ELEMENT_ID = 'media-dashboard-config';

/**
 * Rewrite the built `index.html` for serving: point Vite's placeholder base at `basePath` and hand
 * the SPA its runtime bootstrap.
 *
 * The bootstrap goes in as a JSON DATA BLOCK (`<script type="application/json">`), the only place
 * the SPA reads it from. A data block is never executed, so no Content-Security-Policy can refuse it;
 * an inline script is, and a host with `script-src 'self' 'nonce-…'` (`@adonisjs/shield`'s `@nonce`)
 * drops it silently.
 */
export function renderIndexHtml(
  html: string,
  basePath: string,
  bootstrap: DashboardBootstrap,
): string {
  const based = html.split(BASE_PLACEHOLDER).join(`${basePath === '/' ? '' : basePath}/`);
  // `<` escaped as `\u003c` inside the JSON: a data block ends at the first `</script`, and a
  // config value must not be able to close it early. Valid JSON either way.
  const json = JSON.stringify(bootstrap).replace(/</g, '\\u003c');
  const inject = `<script type="application/json" id="${CONFIG_ELEMENT_ID}">${json}</script>`;
  return based.includes('</head>') ? based.replace('</head>', `${inject}</head>`) : inject + based;
}
