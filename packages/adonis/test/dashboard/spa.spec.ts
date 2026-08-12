import { describe, expect, it } from 'vitest';
import { contentTypeFor, normalizePath, renderIndexHtml } from '../../src/dashboard/spa.js';

describe('dashboard spa helpers', () => {
  it('normalises mount paths', () => {
    expect(normalizePath('/media/dashboard')).toBe('/media/dashboard');
    expect(normalizePath('media/dashboard/')).toBe('/media/dashboard');
    expect(normalizePath('//media//dashboard//')).toBe('/media/dashboard');
    expect(normalizePath('/')).toBe('/');
  });

  it('maps asset content types', () => {
    expect(contentTypeFor('index-abc.js')).toContain('text/javascript');
    expect(contentTypeFor('index-abc.css')).toContain('text/css');
    expect(contentTypeFor('logo.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('mystery.xyz')).toBe('application/octet-stream');
  });

  it('rewrites the SPA base and injects the bootstrap', () => {
    const html =
      '<head><script type="module" src="/__MEDIA_DASHBOARD__/assets/index.js"></script></head><body></body>';
    const bootstrap = {
      apiBase: '/admin/media/api',
      uploadsBase: '/media/uploads',
      tusBase: '/media/uploads/tus',
      actions: true,
    };
    const out = renderIndexHtml(html, '/admin/media', bootstrap);
    expect(out).toContain('src="/admin/media/assets/index.js"');
    expect(out).not.toContain('__MEDIA_DASHBOARD__/assets');
    expect(out).toContain('window.__MEDIA_DASHBOARD__={');
    expect(out).toContain('"apiBase":"/admin/media/api"');
    // injected before the closing head tag
    expect(out.indexOf('window.__MEDIA_DASHBOARD__')).toBeLessThan(out.indexOf('</head>'));
  });
});
