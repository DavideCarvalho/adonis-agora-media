/**
 * Pure helpers for mounting/serving the SPA — split out so they're unit-testable without booting
 * AdonisJS. The provider is a thin HTTP shell around these.
 */

/** Placeholder base Vite bakes into asset URLs; rewritten to the configured `basePath` at serve time. */
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

/**
 * Rewrite the built `index.html` for serving: point Vite's placeholder base at `basePath` and inject
 * the runtime bootstrap the SPA reads from `window.__MEDIA_DASHBOARD__`.
 */
export function renderIndexHtml(
  html: string,
  basePath: string,
  bootstrap: DashboardBootstrap,
): string {
  const based = html.split(BASE_PLACEHOLDER).join(`${basePath === '/' ? '' : basePath}/`);
  const inject = `<script>window.__MEDIA_DASHBOARD__=${JSON.stringify(bootstrap)}</script>`;
  return based.replace('</head>', `${inject}</head>`);
}
