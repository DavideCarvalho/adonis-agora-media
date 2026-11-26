import { defineConfig, drivers } from '@adonisjs/core/encryption';
import { Secret } from '@adonisjs/core/helpers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appKeyOf } from '../../src/federation/redis_channel.js';

/**
 * APP_KEY resolution (SECURITY-UNIFORM-SPEC §13c), identical in every Agora lib: `config/app.ts`'s
 * `appKey` → the default entry of `config/encryption.ts` (AdonisJS 7, lazy providers) →
 * `process.env.APP_KEY`, as a `Secret` or a string. Built on the real `defineConfig`/`drivers`.
 */

const KEY = 'app-key-from-config-0123456789';
const ENCRYPTION_KEY = 'app-key-from-encryption-012345';
const ENV_KEY = 'app-key-from-the-environment-0';

const appWith = (config: Record<string, unknown>) => ({
  config: { get: (key: string, fallback?: unknown) => (key in config ? config[key] : fallback) },
});

const savedEnv = process.env.APP_KEY;
beforeEach(() => {
  delete process.env.APP_KEY;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.APP_KEY;
  else process.env.APP_KEY = savedEnv;
});

describe('appKeyOf', () => {
  it('reads config/app.ts appKey, as a string or a Secret', async () => {
    expect(await appKeyOf(appWith({ 'app.appKey': KEY }))).toBe(KEY);
    expect(await appKeyOf(appWith({ 'app.appKey': new Secret(KEY) }))).toBe(KEY);
  });

  it('reads the default entry of config/encryption.ts (AdonisJS 7 defineConfig + drivers)', async () => {
    // EduLiberta's file: the key only lives here.
    const legacy = defineConfig({
      default: 'legacy',
      list: { legacy: drivers.legacy({ keys: [new Secret(ENCRYPTION_KEY)] }) },
    });
    expect(await appKeyOf(appWith({ encryption: legacy }))).toBe(ENCRYPTION_KEY);

    // The default entry wins over the others, and its first key over older ones.
    const several = defineConfig({
      default: 'app',
      list: {
        backup: drivers.aes256gcm({ id: 'backup', keys: ['backup-key-0123456789abcdef'] }),
        app: drivers.aes256gcm({ id: 'app', keys: [ENCRYPTION_KEY, 'old-key-0123456789abcdef'] }),
      },
    });
    expect(await appKeyOf(appWith({ encryption: several }))).toBe(ENCRYPTION_KEY);

    // No default: the first entry.
    const noDefault = defineConfig({
      list: { only: drivers.aes256gcm({ id: 'only', keys: [ENCRYPTION_KEY] }) },
    } as never);
    expect(await appKeyOf(appWith({ encryption: noDefault }))).toBe(ENCRYPTION_KEY);
  });

  it('reads already-resolved and flat encryption configs (keys[0] or key)', async () => {
    const resolvedList = { default: 'a', list: { a: { keys: [ENCRYPTION_KEY] } } };
    expect(await appKeyOf(appWith({ encryption: resolvedList }))).toBe(ENCRYPTION_KEY);
    const singleKey = { default: 'a', list: { a: { key: new Secret(ENCRYPTION_KEY) } } };
    expect(await appKeyOf(appWith({ encryption: singleKey }))).toBe(ENCRYPTION_KEY);
    expect(await appKeyOf(appWith({ encryption: { keys: [ENCRYPTION_KEY] } }))).toBe(
      ENCRYPTION_KEY,
    );
  });

  it('app.appKey wins; then the environment; a source that throws is "no key here"', async () => {
    expect(
      await appKeyOf(
        appWith({
          'app.appKey': KEY,
          encryption: { default: 'a', list: { a: { key: 'x'.repeat(20) } } },
        }),
      ),
    ).toBe(KEY);
    expect(await appKeyOf(appWith({}))).toBeUndefined();
    process.env.APP_KEY = ENV_KEY;
    expect(await appKeyOf(appWith({}))).toBe(ENV_KEY);
    // A provider that throws, or an unusable key, falls through to the environment.
    const throwing = {
      resolver: async () => {
        throw new Error('no app');
      },
    };
    expect(await appKeyOf(appWith({ encryption: throwing }))).toBe(ENV_KEY);
    const empty = { default: 'a', list: { a: { keys: [''] } } };
    expect(await appKeyOf(appWith({ encryption: empty }))).toBe(ENV_KEY);
    const getThrows = {
      config: {
        get: () => {
          throw new Error('boom');
        },
      },
    };
    expect(await appKeyOf(getThrows)).toBe(ENV_KEY);
  });

  it('a token-mode app whose key lives only in config/encryption.ts boots (EduLiberta)', async () => {
    const { resolveAppConsoleAuth } = await import('../../src/federation/console_auth.js');
    const encryption = defineConfig({
      default: 'legacy',
      list: { legacy: drivers.legacy({ keys: [new Secret(ENCRYPTION_KEY)] }) },
    });
    const appKey = await appKeyOf(appWith({ encryption }));
    const auth = resolveAppConsoleAuth({
      options: { prefix: 'el' },
      appKey,
      siblings: {
        authkit: {
          appCallerVerifier: () => ({ verifyToken: async () => null }),
        },
      },
    });
    expect(auth.modes).toEqual([
      expect.stringMatching(/^token \(authkit app-call, auto; sealed to key /),
    ]);
  });
});
