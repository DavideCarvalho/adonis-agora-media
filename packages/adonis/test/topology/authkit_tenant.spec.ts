import { describe, expect, it, vi } from 'vitest';
import { defineConfig, type MediaConfig } from '../../src/define_config.js';
import { checkControlPlane, checkTopology } from '../../src/doctor/checks.js';
import { resolveMediaTenant } from '../../src/topology/authkit_tenant.js';
import { tenantClientOf } from '../../src/topology/tenant_client.js';

/** A fake `authkit.client` binding: authkit-client 1.1's `tenantOf`, by shape. */
function fakeAuthkit(partition = 'shop') {
  const resources: string[] = [];
  const reset = vi.fn();
  const client = {
    tenantOf(resource: string) {
      resources.push(resource);
      return {
        url: Object.assign(async () => 'https://hub.test/_media', {
          refresh: async () => 'https://hub.test/_media',
        }),
        token: Object.assign(async () => `auto-token-for-${resource}`, { reset }),
        partition,
      };
    },
  };
  return { client, resources, reset };
}

function containerWith(binding: unknown) {
  return {
    hasBinding: (key: string) => key === 'authkit.client' && binding !== undefined,
    make: async () => binding,
  };
}

const NO_BINDING = containerWith(undefined);

describe('a media tenant with @adonis-agora/authkit-client', () => {
  it('defineConfig accepts `topology: tenant` alone', () => {
    expect(() => defineConfig({ topology: 'tenant' })).not.toThrow();
    // What is set is still checked.
    expect(() => defineConfig({ topology: 'tenant', tenant: { url: 'hub/_media' } })).toThrow(
      /absolute http\(s\) URL/,
    );
  });

  it('fills url, token and partition from tenantOf("urn:agora:media")', async () => {
    const authkit = fakeAuthkit();
    const { config, sources } = await resolveMediaTenant(
      { topology: 'tenant' } as MediaConfig,
      containerWith(authkit.client),
    );
    expect(authkit.resources).toEqual(['urn:agora:media']);
    expect(sources).toEqual({
      url: 'authkit-client (auto)',
      token: 'authkit-client (auto)',
      partition: 'authkit-client (auto)',
    });
    const client = tenantClientOf(config, {
      fetch: (async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        return new Response(
          JSON.stringify({
            url,
            auth: headers.get('authorization'),
            app: headers.get('x-media-app'),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }) as never,
    });
    expect(await client.json('/whoami')).toEqual({
      url: 'https://hub.test/_media/v1/whoami',
      auth: 'Bearer auto-token-for-urn:agora:media',
      app: 'shop',
    });
  });

  it('an explicit field wins, field by field', async () => {
    const authkit = fakeAuthkit();
    const { config, sources } = await resolveMediaTenant(
      {
        topology: 'tenant',
        tenant: { url: 'https://mine.test/_media', partition: 'acme', urls: 'control-plane' },
      } as MediaConfig,
      containerWith(authkit.client),
    );
    expect(config.tenant?.url).toBe('https://mine.test/_media');
    expect(config.tenant?.partition).toBe('acme');
    expect(config.tenant?.urls).toBe('control-plane');
    expect(typeof config.tenant?.token).toBe('function');
    expect(sources).toEqual({
      url: 'explicit',
      token: 'authkit-client (auto)',
      partition: 'explicit',
    });
  });

  it('never calls tenantOf when every field is explicit', async () => {
    const authkit = fakeAuthkit();
    await resolveMediaTenant(
      { topology: 'tenant', tenant: { url: 'https://x.test', partition: 'a', token: 't' } },
      containerWith(authkit.client),
    );
    expect(authkit.resources).toEqual([]);
  });

  it('`tenant.auto: false` turns the detection off', async () => {
    await expect(
      resolveMediaTenant(
        { topology: 'tenant', tenant: { auto: false } },
        containerWith(fakeAuthkit().client),
      ),
    ).rejects.toThrow(/`tenant.auto` is false/);
  });

  it('without the binding and without the fields: the boot error names them and both fixes', async () => {
    await expect(resolveMediaTenant({ topology: 'tenant' }, NO_BINDING)).rejects.toThrow(
      "[@adonis-agora/media] topology 'tenant' needs tenant.url, tenant.token, tenant.partition. Fix: configure @adonis-agora/authkit-client's `service: { name, clientId, clientSecret }` (config/authkit_client.ts), which supplies them for urn:agora:media, or set `tenant: { url, token, partition }` in config/media.ts.",
    );
  });

  it('a binding without tenantOf (an older authkit-client) counts as absent', async () => {
    await expect(
      resolveMediaTenant(
        { topology: 'tenant', tenant: { partition: 'acme' } },
        containerWith({ appCallTokens: () => undefined }),
      ),
    ).rejects.toThrow(/needs tenant\.url, tenant\.token\. Fix:/);
  });

  it('leaves a standalone or control-plane config alone', async () => {
    const config: MediaConfig = { disk: 'local' };
    expect((await resolveMediaTenant(config, containerWith(fakeAuthkit().client))).config).toBe(
      config,
    );
  });
});

describe('agora:doctor on a media tenant', () => {
  it('media.topology says where each field came from', async () => {
    const auto = await checkTopology({ topology: 'tenant' }, containerWith(fakeAuthkit().client));
    expect(auto).toEqual({
      status: 'ok',
      message:
        'Tenant "shop": media lives on the control plane at its discovered URL (tenant url/token/partition: authkit-client (auto)).',
    });
    const mixed = await checkTopology(
      { topology: 'tenant', tenant: { url: 'https://hub.example/_media' } },
      containerWith(fakeAuthkit().client),
    );
    expect(mixed.message).toBe(
      'Tenant "shop": media lives on the control plane at https://hub.example/_media (tenant url: explicit; token/partition: authkit-client (auto)).',
    );
    const none = await checkTopology({ topology: 'tenant' }, NO_BINDING);
    expect(none).toMatchObject({
      status: 'error',
      message:
        "[@adonis-agora/media] topology 'tenant' needs tenant.url, tenant.token, tenant.partition.",
    });
    expect(none.fix).toContain("configure @adonis-agora/authkit-client's `service:");
  });

  it('media.control-plane uses what authkit-client supplies', async () => {
    const seen: string[] = [];
    const result = await checkControlPlane(
      { topology: 'tenant', tenant: { retries: 0 } },
      {
        container: containerWith(fakeAuthkit().client),
        fetch: (async (url: string, init: RequestInit) => {
          seen.push(`${url} ${new Headers(init.headers).get('authorization')}`);
          return new Response(
            JSON.stringify({ partition: 'shop', capabilities: ['media:read', 'media:write'] }),
            { headers: { 'content-type': 'application/json' } },
          );
        }) as never,
      },
    );
    expect(result.status).toBe('ok');
    expect(seen).toEqual([
      'https://hub.test/_media/v1/whoami Bearer auto-token-for-urn:agora:media',
    ]);
  });
});
