import { describe, expect, it, vi } from 'vitest';
import { AGORA_DOCTOR_BINDING } from '../src/doctor/agora_doctor.js';
import {
  checkAccountConsole,
  checkConsoleCommands,
  checkConsoleCommandsKey,
  checkConsoleGate,
  checkDisks,
  checkTenancySchema,
  checkTimestampsSchema,
  mediaDoctorChecks,
} from '../src/doctor/checks.js';
import { agoraDoctorChecks } from '../src/doctor/index.js';

describe('media doctor checks', () => {
  it('ids are frozen and exported for --no-boot', () => {
    expect(mediaDoctorChecks.map((c) => c.id)).toEqual([
      'media.disks',
      'media.console-gate',
      'media.account-console',
      'media.tenancy-schema',
      'media.timestamps-schema',
      'media.topology',
      'media.control-plane',
      'media.console-commands',
      'media.console-commands-key',
    ]);
    expect(agoraDoctorChecks).toBe(mediaDoctorChecks);
    expect(mediaDoctorChecks.find((c) => c.id === 'media.tenancy-schema')?.cost).toBe('deep');
  });

  it('media.console-commands: each side, the crypto probe, an error when unauthenticated', async () => {
    const app = (media: unknown, dashboard?: unknown) =>
      ({
        config: {
          get: (key: string, def: unknown) =>
            key === 'media' ? media : key === 'media_dashboard' ? dashboard : def,
        },
        container: { make: async () => undefined },
      }) as never;
    expect((await checkConsoleCommands(app({})))[0]?.status).toBe('skip');
    const none = await checkConsoleCommands(app({ consoleCommands: { prefix: 'shop' } }));
    expect(none[0]).toMatchObject({ status: 'error', message: expect.stringMatching(/boot/) });
    const secret = await checkConsoleCommands(
      app({ consoleCommands: { prefix: 'shop', secret: 'a-secret-of-16-chars+' } }),
    );
    expect(secret[0]).toMatchObject({ status: 'ok', message: expect.stringContaining('secret') });
    // Crypto embedded here: the key is created and a probe round-trips.
    const keys = new Map<string, string>();
    const runtime = {
      topology: 'standalone' as const,
      partition: 'shop',
      service: {
        encrypt: async () => ({ ciphertext: '' }),
        decrypt: async () => ({ plaintext: '' }),
        createKey: async (p: { partition: string }, i: { name: string }) =>
          void keys.set(`${p.partition}/${i.name}`, 'k'),
        store: { getKey: async (p: string, n: string) => keys.get(`${p}/${n}`) ?? null },
      },
      operations: {
        encrypt: async ({ plaintext }: { plaintext: string }) => ({ ciphertext: `x:${plaintext}` }),
        decrypt: async ({ ciphertext }: { ciphertext: string }) => ({
          plaintext: ciphertext.slice(2),
        }),
      },
    };
    const crypto = await checkConsoleCommands(app({ consoleCommands: { prefix: 'shop' } }), {
      siblings: { crypto: runtime },
    });
    expect(crypto[0]).toMatchObject({
      status: 'ok',
      message: expect.stringMatching(/crypto \(auto, key console-media/),
    });
    // The deep key check creates the key and round-trips a probe.
    const key = await checkConsoleCommandsKey(app({ consoleCommands: { prefix: 'shop' } }), {
      siblings: { crypto: runtime },
    });
    expect(key[0]).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('encrypts and decrypts'),
    });
    expect(keys.has('shop/console-media')).toBe(true);
    const secretOnly = app({
      consoleCommands: { prefix: 'shop', secret: 'a-secret-of-16-chars+' },
    });
    expect((await checkConsoleCommandsKey(secretOnly, { siblings: {} }))[0]?.status).toBe('skip');
    // The console side, as boot: an entry that may act (the default) is an error, browse-only warns.
    const side = await checkConsoleCommands(
      app({}, { apps: { shop: { store: {}, controlPlane: { prefix: 'shop' } } } }),
      { siblings: {} },
    );
    expect(side[0]).toMatchObject({ status: 'error', fix: expect.stringContaining('secret') });
    const browse = await checkConsoleCommands(
      app({}, { apps: { shop: { store: {}, controlPlane: { prefix: 'shop' }, actions: false } } }),
      { siblings: {} },
    );
    expect(browse[0]?.status).toBe('warn');
  });

  it('media.disks', () => {
    expect(checkDisks(undefined, null).status).toBe('skip');
    expect(checkDisks({}, null).status).toBe('error');
    expect(checkDisks({}, { default: 'fs', services: ['fs'] }).status).toBe('ok');
    const missing = checkDisks(
      {
        disk: 's3',
        disks: { s3: (async () => ({})) as never },
        collections: [{ name: 'videos', disk: 'cold' }],
        uploads: { resumable: { routes: { disk: 'tmp' } } },
      },
      { default: 'fs', services: ['fs'] },
    );
    expect(missing.status).toBe('error');
    expect(missing.message).toContain('"cold" (collection "videos")');
    expect(missing.message).toContain('"tmp" (uploads.resumable.routes.disk)');
    expect(checkDisks({}, 'unknown').status).toBe('skip');
  });

  it("resolves Drive's config provider like boot does", async () => {
    const { resolveDriveDisks } = await import('../src/doctor/checks.js');
    const app = (drive: unknown) =>
      ({
        config: { get: (key: string, def: unknown) => (key === 'drive' ? drive : def) },
      }) as never;
    const provider = {
      type: 'provider',
      resolver: async () => ({ config: { default: 's3', services: { s3: {}, fs: {} } } }),
    };
    expect(await resolveDriveDisks(app(provider))).toEqual({
      default: 's3',
      services: ['s3', 'fs'],
    });
    expect(await resolveDriveDisks(app({ default: 'fs', services: { fs: {} } }))).toEqual({
      default: 'fs',
      services: ['fs'],
    });
    expect(await resolveDriveDisks(app(undefined))).toBeNull();
    const broken = {
      type: 'provider',
      resolver: async () => {
        throw new Error('x');
      },
    };
    expect(await resolveDriveDisks(app(broken))).toBe('unknown');
  });

  it('media.console-gate', () => {
    expect(checkConsoleGate(undefined, true).status).toBe('skip');
    expect(checkConsoleGate({ enabled: false }, true).status).toBe('skip');
    expect(checkConsoleGate({ authorize: () => true }, true).status).toBe('ok');
    expect(checkConsoleGate({}, false).status).toBe('warn');
    expect(checkConsoleGate({}, true).status).toBe('error');
  });

  it('media.account-console', () => {
    expect(checkAccountConsole({}).status).toBe('skip');
    expect(checkAccountConsole({ accountConsole: { collections: [] } }).status).toBe('skip');
    expect(
      checkAccountConsole({
        collections: [{ name: 'docs', access: { read: 'public' } }],
        accountConsole: { collections: ['docs'] },
      }).status,
    ).toBe('ok');
    const warn = checkAccountConsole({
      collections: [{ name: 'docs' }],
      accountConsole: { collections: ['docs', 'ghost'] },
    });
    expect(warn.status).toBe('warn');
    expect(warn.message).toContain('ghost');
    expect(warn.message).toContain('docs');
  });

  it('media.tenancy-schema', async () => {
    const app = (media: unknown, store: unknown) =>
      ({
        config: { get: (key: string, def: unknown) => (key === 'media' ? media : def) },
        container: { make: async () => ({ store }) },
      }) as never;
    expect((await checkTenancySchema(app(undefined, {}))).status).toBe('skip');
    expect((await checkTenancySchema(app({ tenancy: false }, {}))).status).toBe('skip');
    const SLOT = Symbol.for('@agora/context:tenancy');
    (globalThis as Record<symbol, unknown>)[SLOT] = {
      version: 1,
      tenancy: () => ({ enabled: true }),
      tenantFilter: () => ({ mode: 'system' }),
    };
    try {
      expect((await checkTenancySchema(app({}, {}))).status).toBe('skip');
      expect(
        (await checkTenancySchema(app({}, { hasTenantColumn: async () => true }))).status,
      ).toBe('ok');
      expect(
        (await checkTenancySchema(app({}, { hasTenantColumn: async () => false }))).status,
      ).toBe('error');
    } finally {
      delete (globalThis as Record<symbol, unknown>)[SLOT];
    }
  });

  it('media.timestamps-schema', async () => {
    const app = (media: unknown) =>
      ({
        config: { get: (key: string, def: unknown) => (key === 'media' ? media : def) },
      }) as never;
    const uploads = (store: unknown) => ({
      uploads: { resumable: { store: 'sql', stores: { sql: async () => store } } },
    });
    expect((await checkTimestampsSchema(app(undefined))).status).toBe('skip');
    expect((await checkTimestampsSchema(app({}))).status).toBe('skip');
    expect((await checkTimestampsSchema(app(uploads({})))).status).toBe('skip');
    expect(
      (await checkTimestampsSchema(app(uploads({ hasUpdatedAtColumn: async () => true })))).status,
    ).toBe('ok');
    const warn = await checkTimestampsSchema(
      app(uploads({ hasUpdatedAtColumn: async () => false })),
    );
    expect(warn.status).toBe('warn');
    expect(warn.fix).toContain('media:publish-migration timestamps');
    expect(warn.message).toContain('resumable upload sessions table has no updated_at');
    const both = await checkTimestampsSchema(
      app({
        uploads: {
          resumable: {
            store: 'sql',
            stores: { sql: async () => ({ hasUpdatedAtColumn: async () => false }) },
          },
          direct: {
            store: 'sql',
            stores: { sql: async () => ({ hasUpdatedAtColumn: async () => false }) },
          },
        },
      }),
    );
    expect(both.message).toContain(
      'resumable upload sessions and direct upload sessions tables have no updated_at',
    );
  });

  it('MediaProvider registers its checks from boot()', async () => {
    const { default: MediaProvider } = await import('../providers/media_provider.js');
    const values = new Map<string, unknown>();
    const app = {
      config: { get: (_key: string, def: unknown) => def },
      container: {
        hasBinding: (key: string) => values.has(key),
        bindValue: (key: string, value: unknown) => void values.set(key, value),
        make: vi.fn(async (key: string) => values.get(key)),
        singleton: vi.fn(),
      },
      booted: vi.fn(async () => {}),
    };
    await new MediaProvider(app as never).boot();
    const registry = values.get(AGORA_DOCTOR_BINDING) as { checks: Array<{ id: string }> };
    expect(registry.checks.map((c) => c.id)).toContain('media.disks');
  });
});
