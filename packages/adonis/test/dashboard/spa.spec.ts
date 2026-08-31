import { describe, expect, it } from 'vitest';
import {
  CONFIG_ELEMENT_ID,
  contentTypeFor,
  normalizePath,
  renderIndexHtml,
} from '../../src/dashboard/spa.js';

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
    // A JSON DATA block, never an executable inline script: a host CSP of
    // `script-src 'self' 'nonce-…'` drops an inline script without a word, the SPA falls back to
    // its default mount, and every request 404s from a page that rendered fine.
    const match = new RegExp(
      `<script type="application/json" id="${CONFIG_ELEMENT_ID}">([^]*?)</script>`,
    ).exec(out);
    expect(match).not.toBeNull();
    expect(JSON.parse(match?.[1] ?? '')).toEqual(bootstrap);
    expect(out).not.toContain('window.__MEDIA_DASHBOARD__');
    // injected before the closing head tag
    expect(out.indexOf(CONFIG_ELEMENT_ID)).toBeLessThan(out.indexOf('</head>'));
  });

  it('escapes a bootstrap value that would otherwise close the data block early', () => {
    const out = renderIndexHtml('<head></head><body></body>', '/m', {
      apiBase: '/m</script><b>',
      uploadsBase: '/u',
      tusBase: '/t',
      actions: false,
    });
    expect(out.split('</script>')).toHaveLength(2);
    const match = new RegExp(`id="${CONFIG_ELEMENT_ID}">([^]*?)</script>`).exec(out);
    expect(JSON.parse(match?.[1] ?? '').apiBase).toBe('/m</script><b>');
  });
});
