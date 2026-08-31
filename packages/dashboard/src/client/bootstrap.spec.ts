// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_ELEMENT_ID, readBootstrap } from './dashboard-client.js';

/**
 * Where `readBootstrap()` gets its values from: the provider's JSON data block first, the
 * `window.__MEDIA_DASHBOARD__` global second, the standalone-dev defaults last. The block exists
 * because a host CSP with `script-src 'self' 'nonce-…'` refuses the inline script the global used
 * to arrive in, and the console then 404s on every request while rendering perfectly.
 */

function injectConfig(config: Record<string, unknown>): void {
  const el = document.createElement('script');
  el.type = 'application/json';
  el.id = CONFIG_ELEMENT_ID;
  el.textContent = JSON.stringify(config);
  document.head.appendChild(el);
}

afterEach(() => {
  document.getElementById(CONFIG_ELEMENT_ID)?.remove();
  Reflect.deleteProperty(globalThis, '__MEDIA_DASHBOARD__');
});

describe('readBootstrap', () => {
  it('reads the injected data block', () => {
    injectConfig({ apiBase: '/ops/media/api', uploadsBase: '/u', tusBase: '/t', actions: true });
    expect(readBootstrap()).toEqual({
      apiBase: '/ops/media/api',
      uploadsBase: '/u',
      tusBase: '/t',
      actions: true,
    });
  });

  it('lets the block win over the window global', () => {
    (globalThis as { __MEDIA_DASHBOARD__?: unknown }).__MEDIA_DASHBOARD__ = { apiBase: '/stale' };
    injectConfig({ apiBase: '/fresh/api' });
    expect(readBootstrap().apiBase).toBe('/fresh/api');
  });

  it('falls through to the global, then the defaults', () => {
    (globalThis as { __MEDIA_DASHBOARD__?: unknown }).__MEDIA_DASHBOARD__ = { apiBase: '/g/api' };
    expect(readBootstrap().apiBase).toBe('/g/api');
    Reflect.deleteProperty(globalThis, '__MEDIA_DASHBOARD__');
    expect(readBootstrap().apiBase).toBe('/media/dashboard/api');
  });

  it('ignores a block that is not JSON rather than crashing the console', () => {
    const el = document.createElement('script');
    el.type = 'application/json';
    el.id = CONFIG_ELEMENT_ID;
    el.textContent = '{not json';
    document.head.appendChild(el);
    expect(readBootstrap().apiBase).toBe('/media/dashboard/api');
  });
});
