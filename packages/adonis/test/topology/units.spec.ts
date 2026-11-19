import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertMediaTopology, defineConfig, type MediaConfig } from '../../src/define_config.js';
import { checkControlPlane, checkDisks, checkTopology } from '../../src/doctor/checks.js';
import type { MediaRecord } from '../../src/media_record.js';
import { mediaStackUses } from '../../src/stack.js';
import { InMemoryMediaStore } from '../../src/testing/in_memory_media_store.js';
import {
  checkVerifiedTenant,
  resolveTenantToken,
  resolveTenantVerifier,
  sharedSecretVerifier,
} from '../../src/topology/auth.js';
import { MediaControlPlane } from '../../src/topology/control_plane.js';
import { partitionStore } from '../../src/topology/partition_store.js';
import { fromWireRecord, mediaEtag, toWireRecord } from '../../src/topology/protocol.js';
import { seconds } from '../../src/topology/tenant_library.js';
import { addressOf, close, serveControlPlane } from './http_harness.js';

const verify = () => () => ({ partition: 'a', capabilities: [] });

function record(id: string, ownerType: string, path: string): MediaRecord {
  return {
    id,
    ownerType,
    ownerId: '1',
    collection: 'c',
    name: id,
    fileName: `${id}.txt`,
    mimeType: 'text/plain',
    size: 1,
    disk: 'd',
    path,
    order: 0,
    customProperties: {},
    conversions: {},
    createdAt: new Date(1_000),
    updatedAt: new Date(2_000),
  };
}

describe('topology config', () => {
  it('accepts the three shapes', () => {
    expect(() => defineConfig({})).not.toThrow();
    expect(() => defineConfig({ topology: 'control-plane', verifyTenant: verify() })).not.toThrow();
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: 'https://hub.example/_media', partition: 'et', token: 's' },
      }),
    ).not.toThrow();
    expect(() =>
      defineConfig({
        topology: 'tenant',
        tenant: { url: async () => 'https://hub.example/_media', partition: 'et', token: 's' },
      }),
    ).not.toThrow();
  });

  it('refuses what cannot work, saying what to change', () => {
    const bad: Array<[MediaConfig, RegExp]> = [
      [{ topology: 'control-plane' }, /needs `verifyTenant`/],
      [{ verifyTenant: verify() }, /only apply to topology "control-plane"/],
      [
        { tenant: { url: 'https://x', partition: 'a', token: 's' } },
        /only applies to topology "tenant"/,
      ],
      [
        { topology: 'tenant', tenant: { url: 'hub/_media', partition: 'a', token: 's' } },
        /absolute http\(s\) URL/,
      ],
      [
        { topology: 'tenant', tenant: { url: 'https://x', partition: 'a b', token: 's' } },
        /partition/,
      ],
      [{ topology: 'tenant', tenant: { url: 'https://x', partition: 'a', token: '' } }, /token/],
      [
        {
          topology: 'tenant',
          tenant: { url: 'https://x', partition: 'a', token: 's' },
          disk: 's3',
        },
        /`disk` does not apply to a tenant/,
      ],
      [
        {
          topology: 'control-plane',
          verifyTenant: verify(),
          controlPlane: { accounts: { collections: [], verifyUser: () => null } },
        },
        /at least one collection/,
      ],
    ];
    for (const [config, message] of bad) expect(() => assertMediaTopology(config)).toThrow(message);
  });
});

describe('partitionStore', () => {
  it("lets only the partition's records through", async () => {
    const raw = new InMemoryMediaStore();
    await raw.save(record('mine', 'et/User', 'et/User/1/c/mine/mine.txt'));
    await raw.save(record('theirs', 'el/User', 'el/User/1/c/theirs/theirs.txt'));
    await raw.save(record('hub', 'HubAccount', 'HubAccount/1/c/hub/hub.txt'));
    const et = partitionStore(raw, 'et');
    expect(await et.find('mine')).not.toBeNull();
    expect(await et.find('theirs')).toBeNull();
    expect(await et.find('hub')).toBeNull();
    expect((await et.list()).items.map((r) => r.id)).toEqual(['mine']);
    expect((await et.list({ ownerType: 'el/User' })).items).toEqual([]);
    expect(await et.listByOwner('el/User', '1')).toEqual([]);
    await et.delete('theirs');
    expect(await raw.find('theirs')).not.toBeNull();
    await expect(et.save(record('x', 'el/User', 'el/x'))).rejects.toThrow(/outside partition/);
  });
});

describe('auth building blocks', () => {
  it('a verifier in any form; a malformed answer never accepts a tenant', async () => {
    const answer = { partition: 'et', capabilities: ['media:read'] };
    for (const input of [
      () => answer,
      { verify: () => answer },
      class {
        verify() {
          return answer;
        }
      },
      async () => ({ default: () => answer }),
    ]) {
      expect(await resolveTenantVerifier(input as never)({ token: 't' })).toEqual(answer);
    }
    expect(() => checkVerifiedTenant({ tenant: 'et' })).toThrow(/partition/);
    expect(checkVerifiedTenant(null)).toBeNull();
  });

  it('a shared secret proves the app it names', async () => {
    const verifier = sharedSecretVerifier({ partitions: { et: 'secret' } });
    expect(await verifier({ token: 'secret', app: 'et' })).toEqual({
      partition: 'et',
      capabilities: ['media:read', 'media:write'],
    });
    expect(await verifier({ token: 'secret', app: 'el' })).toBeNull();
    expect(await verifier({ token: 'nope', app: 'et' })).toBeNull();
    expect(await verifier({ token: 'secret', app: 'constructor' })).toBeNull();
  });

  it('a token source in any form, with reset', async () => {
    let resets = 0;
    const fn = Object.assign(async () => 'jwt', { reset: () => resets++ });
    const token = resolveTenantToken(fn);
    expect(await token.get()).toBe('jwt');
    token.reset?.();
    expect(resets).toBe(1);
    expect(await resolveTenantToken('s').get()).toBe('s');
    expect(() => resolveTenantToken('')).toThrow(/empty/);
  });
});

describe('protocol', () => {
  it('round-trips a record and tags each rendition', () => {
    const r = record('r', 'et/User', 'et/r');
    expect(fromWireRecord(JSON.parse(JSON.stringify(toWireRecord(r))))).toEqual(r);
    expect(mediaEtag(r)).not.toBe(mediaEtag(r, { conversion: 'thumb' }));
    expect(() => fromWireRecord({ id: 1 })).toThrow(/not a media record/);
    expect(seconds('5m')).toBe(300);
    expect(seconds(30)).toBe(30);
    expect(() => seconds('soon')).toThrow(/duration/);
  });
});

describe('stack descriptor', () => {
  it('a tenant uses the control plane, not a disk', () => {
    expect(
      mediaStackUses({
        topology: 'tenant',
        tenant: { url: 'https://hub.example/_media', partition: 'et', token: 's' },
      }),
    ).toEqual([
      { tech: 'control-plane', label: 'hub.example', host: 'hub.example', purpose: 'media files' },
    ]);
    expect(
      mediaStackUses({
        topology: 'tenant',
        tenant: { url: async () => 'x', partition: 'et', token: 's' },
      }),
    ).toEqual([{ tech: 'control-plane', label: 'urn:agora:media', purpose: 'media files' }]);
  });
});

describe('doctor', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const plane = new MediaControlPlane({
      library: () => {
        throw new Error('unused');
      },
      store: () => new InMemoryMediaStore(),
      verifyTenant: resolveTenantVerifier(
        sharedSecretVerifier({
          partitions: {
            et: 'et',
            reader: { secret: 'reader', capabilities: ['media:read'] },
            nothing: { secret: 'nothing', capabilities: [] },
          },
        }),
      ),
    });
    server = await serveControlPlane((router) => plane.register(router));
    base = addressOf(server);
  });
  afterAll(() => close(server));

  const tenant = (partition: string, token: string, url = `${base}/_media`): MediaConfig => ({
    topology: 'tenant',
    tenant: { url, partition, token, retries: 0, timeoutMs: 2000 },
  });

  it('media.control-plane: reachable, the right partition, both capabilities', async () => {
    expect(await checkControlPlane({})).toMatchObject({ status: 'skip' });
    expect(await checkControlPlane(tenant('et', 'et'))).toMatchObject({ status: 'ok' });
    expect(await checkControlPlane(tenant('reader', 'reader'))).toMatchObject({ status: 'warn' });
    expect(await checkControlPlane(tenant('nothing', 'nothing'))).toMatchObject({
      status: 'error',
      message: expect.stringContaining('lacks media:read'),
    });
    expect(await checkControlPlane(tenant('et', 'wrong'))).toMatchObject({
      status: 'error',
      message: expect.stringContaining('401'),
    });
    expect(await checkControlPlane(tenant('et', 'et', `${base}/nope`))).toMatchObject({
      status: 'error',
      message: expect.stringContaining('404'),
    });
    expect(await checkControlPlane(tenant('et', 'et', 'http://127.0.0.1:9/_media'))).toMatchObject({
      status: 'error',
      message: expect.stringContaining('did not answer'),
    });
  });

  it('media.topology and media.disks on a tenant', () => {
    expect(checkTopology(tenant('et', 'et'))).toMatchObject({ status: 'ok' });
    expect(checkTopology({ topology: 'control-plane' })).toMatchObject({ status: 'error' });
    expect(checkDisks(tenant('et', 'et'), null)).toMatchObject({ status: 'skip' });
  });
});
