// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { CONFIG_ELEMENT_ID, readBootstrap } from './dashboard-client.js';

/**
 * Where `readBootstrap()` gets its values from: the provider's JSON data block, else the local-dev
 * defaults. Nothing else: a `window.__MEDIA_DASHBOARD__` global is ignored.
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

  it('ignores a window global and falls back to the defaults without a block', () => {
    (globalThis as { __MEDIA_DASHBOARD__?: unknown }).__MEDIA_DASHBOARD__ = { apiBase: '/g/api' };
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
