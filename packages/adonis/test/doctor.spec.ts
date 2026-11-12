import { describe, expect, it, vi } from 'vitest';
import { AGORA_DOCTOR_BINDING } from '../src/doctor/agora_doctor.js';
import {
  checkAccountConsole,
  checkConsoleGate,
  checkDisks,
  checkTenancySchema,
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
    ]);
    expect(agoraDoctorChecks).toBe(mediaDoctorChecks);
    expect(mediaDoctorChecks.find((c) => c.id === 'media.tenancy-schema')?.cost).toBe('deep');
  });

  it('media.disks', () => {
    expect(checkDisks(undefined, undefined).status).toBe('skip');
    expect(checkDisks({}, undefined).status).toBe('error');
    expect(checkDisks({}, { default: 'fs', services: { fs: {} } }).status).toBe('ok');
    const missing = checkDisks(
      {
        disk: 's3',
        disks: { s3: (async () => ({})) as never },
        collections: [{ name: 'videos', disk: 'cold' }],
        uploads: { resumable: { routes: { disk: 'tmp' } } },
      },
      { default: 'fs', services: { fs: {} } },
    );
    expect(missing.status).toBe('error');
    expect(missing.message).toContain('"cold" (collection "videos")');
    expect(missing.message).toContain('"tmp" (uploads.resumable.routes.disk)');
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
