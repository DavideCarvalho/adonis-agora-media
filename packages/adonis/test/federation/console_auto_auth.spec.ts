import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MediaDashboardProvider from '../../providers/dashboard_provider.js';
import MediaProvider from '../../providers/media_provider.js';
import {
  buildFederatedMediaApp,
  FederatedApp,
  FederatedConsoleService,
} from '../../src/federation/console.js';
import {
  type AuthkitClientLike,
  type CryptoRuntimeLike,
  checkTenantConsoleKey,
  classifyConsoleKeyError,
  consoleKeyReport,
  resolveAppConsoleAuth,
  resolveConsoleSideAuth,
  watchTenantConsoleKey,
} from '../../src/federation/console_auth.js';
import { CONSOLE_CRYPTO_KEY, consoleCommandKeys } from '../../src/federation/redis_channel.js';
import { MediaManager } from '../../src/media_manager.js';
import { InMemoryMediaStore } from '../../src/testing/in_memory_media_store.js';
import { RedisBus } from '../support/redis_bus.js';

/**
 * Zero configuration when the libs are together: `@adonis-agora/crypto` (`agora.crypto`) and
 * authkit's calls between apps (`authkit.client`) are picked up on both sides through the real
 * provider paths, with fake bindings standing in for the real libs.
 */

const APP_KEY = 'app-key-of-the-shop-0123456789';
const ALL = ['media:objects:read', 'media:objects:write'];

type Principal = { partition: string; capabilities: string[]; actor: string };

/** A stand-in for an @adonis-agora/crypto server: keys per partition, grants checked per call. */
class FakeCrypto {
  readonly keys = new Map<string, Buffer>();
  readonly calls: string[] = [];

  #key(partition: string, name: string): Buffer {
    const key = this.keys.get(`${partition}/${name}`);
    if (!key)
      throw Object.assign(new Error(`no key ${name} in ${partition}`), { code: 'not_found' });
    return key;
  }

  seal(partition: string, name: string, plaintext: string, aad = ''): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key(partition, name), iv);
    cipher.setAAD(Buffer.from(aad));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const raw = Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
    return `agora:ct1:${name}:1:${raw}`;
  }

  open(partition: string, name: string, ciphertext: string, aad = ''): string {
    const raw = Buffer.from(ciphertext.split(':').pop()!, 'base64url');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.#key(partition, name),
      raw.subarray(0, 12),
    );
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  create(partition: string, name: string): void {
    if (this.keys.has(`${partition}/${name}`)) {
      throw Object.assign(new Error('exists'), { code: 'conflict' });
    }
    this.keys.set(`${partition}/${name}`, randomBytes(32));
  }

  /** Crypto embedded in an app (standalone / control plane): the runtime with `service`. */
  embedded(partition: string): CryptoRuntimeLike {
    const need = (p: Principal, scope: string) => {
      if (!p.capabilities.includes(scope)) throw new Error(`${p.actor} lacks ${scope}`);
    };
    const service: NonNullable<CryptoRuntimeLike['service']> = {
      encrypt: async (p, input) => {
        need(p, `crypto:encrypt:${input.key}`);
        this.calls.push(`encrypt ${p.partition}/${input.key} as ${p.actor}`);
        return { ciphertext: this.seal(p.partition, input.key, input.plaintext, input.aad) };
      },
      decrypt: async (p, input) => {
        need(p, `crypto:decrypt:${input.key}`);
        return { plaintext: this.open(p.partition, input.key, input.ciphertext, input.aad) };
      },
      createKey: async (p, input) => {
        need(p, `crypto:keys:manage:${input.name}`);
        this.calls.push(`create ${p.partition}/${input.name}`);
        this.create(p.partition, input.name);
        return {};
      },
      store: {
        getKey: async (part, name) => (this.keys.has(`${part}/${name}`) ? { name } : null),
      },
    };
    return {
      topology: 'standalone',
      partition,
      service,
      operations: {
        encrypt: async (input) => ({
          ciphertext: this.seal(partition, input.key, input.plaintext, input.aad),
        }),
        decrypt: async (input) => ({
          plaintext: this.open(partition, input.key, input.ciphertext, input.aad),
        }),
      },
    };
  }

  /** An app that is a crypto tenant of a server elsewhere: only its own partition, its grants. */
  tenant(partition: string, grants: { seal?: boolean; manage?: boolean } = {}): CryptoRuntimeLike {
    return {
      topology: 'tenant',
      partition,
      operations: {
        encrypt: async (input) => {
          const target = input.partition ?? partition;
          if (target !== partition && !grants.seal) {
            throw new Error(`crypto: lacks crypto:seal:${input.key}`);
          }
          this.calls.push(`seal ${target}/${input.key} by ${partition}`);
          return { ciphertext: this.seal(target, input.key, input.plaintext, input.aad) };
        },
        decrypt: async (input) => ({
          plaintext: this.open(partition, input.key, input.ciphertext, input.aad),
        }),
        getKey: async (name) => {
          this.#key(partition, name);
          return { name };
        },
        createKey: async (input) => {
          if (!grants.manage) throw new Error(`lacks crypto:keys:manage:${input.name}`);
          this.calls.push(`create ${partition}/${input.name} (remote)`);
          this.create(partition, input.name);
          return {};
        },
      },
    };
  }
}

/** A stand-in for authkit-client's manager: app-call tokens out, their verification in. */
function fakeAuthkit(options: {
  self: string;
  grants?: Record<string, string[]>;
}): AuthkitClientLike & {
  resets: number;
} {
  const fake = {
    resets: 0,
    appCallTokens: () => ({
      token: async (app: string) => `appcall:${options.self}->${app}`,
      reset: () => {
        fake.resets += 1;
      },
    }),
    appCallerVerifier: () => ({
      verifyToken: async (token: string) => {
        const match = /^appcall:(.+)->(.+)$/.exec(token);
        // Audience-bound: only tokens addressed to this app verify.
        if (!match || match[2] !== options.self) return null;
        const caller = match[1]!;
        return {
          app: caller,
          capabilities: options.grants?.[caller] ?? [],
          clientId: `${caller}-client`,
        };
      },
    }),
  };
  return fake;
}

/** A container with the given bindings, a logger and `redis` on `bus`. */
function container(bus: RedisBus, bindings: Record<string, unknown>, lines: string[] = []) {
  const store = new InMemoryMediaStore();
  return {
    lines,
    store,
    hasBinding: (name: string) => Object.hasOwn(bindings, name),
    make: async (token: unknown) => {
      if (typeof token === 'string' && Object.hasOwn(bindings, token)) return bindings[token];
      if (token === 'redis') return { connection: () => bus.connection() };
      if (token === 'logger') {
        const push = (l: string) => lines.push(l);
        return { info: push, warn: push, error: push };
      }
      if (token === MediaManager) {
        return { storage: { defaultDisk: 'fs', disk: () => ({}) }, hasResumable: false, store };
      }
      throw new Error(`unexpected ${String(token)}`);
    },
  };
}

/** The owning app (`shop`), booted through `MediaProvider.ready()`. */
async function owningApp(
  bus: RedisBus,
  bindings: Record<string, unknown>,
  consoleCommands: Record<string, unknown> = {},
  media: Record<string, unknown> = {},
) {
  const c = container(bus, bindings);
  const config: Record<string, unknown> = {
    media: { disk: 'fs', ...media, consoleCommands: { prefix: 'shop', ...consoleCommands } },
  };
  const provider = new MediaProvider({
    config: {
      get: (key: string, def: unknown) => (key === 'app.appKey' ? APP_KEY : (config[key] ?? def)),
    },
    getEnvironment: () => 'web',
    container: c,
  } as never);
  await provider.ready();
  return { provider, lines: c.lines, store: c.store };
}

/** The Hub's console side for `shop`, built the way the dashboard provider builds it. */
async function hubConsole(
  bus: RedisBus,
  bindings: Record<string, unknown>,
  controlPlane: Record<string, unknown> = {},
): Promise<FederatedApp> {
  return buildFederatedMediaApp(
    'shop',
    {
      store: new InMemoryMediaStore(),
      controlPlane: { prefix: 'shop', ...controlPlane } as never,
      timeoutMs: 500,
    },
    { container: container(bus, bindings) },
  );
}

const providers: Array<{ shutdown(): Promise<void> }> = [];
afterEach(async () => {
  for (const p of providers.splice(0)) await p.shutdown();
  vi.restoreAllMocks();
});

describe('automatic crypto mode (agora.crypto in both apps)', () => {
  it('Hub with crypto embedded, app a crypto tenant: no auth lines anywhere', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    const app = await owningApp(bus, { 'agora.crypto': crypto.tenant('shop') });
    providers.push(app.provider);
    // The app booted (a tenant: the key is the server's), and said how it answers.
    expect(app.lines.join('\n')).toContain(
      '[@adonis-agora/media] console commands: crypto (auto, key console-media); actions off (set consoleCommands.actions to let the console act)',
    );
    const hub = await hubConsole(bus, { 'agora.crypto': crypto.embedded('hub') });
    expect(await hub.send('disks', [], 'ana@hub')).toMatchObject({
      data: [{ name: 'fs', default: true }],
    });
    // The Hub created the key in the app's partition and encrypted as media:console, with
    // nothing but crypto:encrypt:console-media there.
    expect(crypto.keys.has(`shop/${CONSOLE_CRYPTO_KEY}`)).toBe(true);
    expect(crypto.calls).toContain('create shop/console-media');
    expect(crypto.calls).toContain('encrypt shop/console-media as media:console');
    // Nothing readable on Redis.
    expect(bus.wire).not.toContain('ana@hub');
  });

  it('crypto embedded in the owning app: the key is created at boot in its own partition', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    const app = await owningApp(bus, { 'agora.crypto': crypto.embedded('shop') });
    providers.push(app.provider);
    expect(crypto.calls).toEqual(['create shop/console-media']);
    const hub = await hubConsole(bus, { 'agora.crypto': crypto.embedded('hub') });
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
    // Idempotent: the key existed, nobody created it twice.
    expect(crypto.calls.filter((c) => c.startsWith('create'))).toHaveLength(1);
  });

  it('crypto in a separate app: the Hub seals through its own crypto channel (crypto:seal)', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    // The app may create the key through its own channel (crypto:keys:manage:console-*).
    const app = await owningApp(bus, { 'agora.crypto': crypto.tenant('shop', { manage: true }) });
    providers.push(app.provider);
    expect(crypto.calls).toEqual(['create shop/console-media (remote)']);
    const hub = await hubConsole(bus, { 'agora.crypto': crypto.tenant('hub', { seal: true }) });
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
    expect(crypto.calls).toContain('seal shop/console-media by hub');

    // Without crypto:seal on the Hub's client, the error says what to grant.
    const ungranted = await hubConsole(bus, { 'agora.crypto': crypto.tenant('hub') });
    await expect(ungranted.send('disks', [], 'ana')).rejects.toThrow(
      /crypto:seal:console-\*.*upgrade @adonis-agora\/crypto/,
    );
  });

  it('app as a crypto tenant whose key is not there yet: boots, and one info line says so', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    const app = await owningApp(bus, { 'agora.crypto': crypto.tenant('shop') });
    providers.push(app.provider);
    const lines = app.lines.filter((l) => l.includes('"console-media"'));
    expect(lines).toEqual([
      expect.stringContaining(
        "does not exist in partition shop yet; the crypto server creates it on the console's first command",
      ),
    ]);
  });

  it('the federated app partition defaults to its key, and `partition` names another', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    const app = await owningApp(bus, { 'agora.crypto': crypto.embedded('shop-prod') });
    providers.push(app.provider);
    const wrong = await hubConsole(bus, { 'agora.crypto': crypto.embedded('hub') });
    await expect(wrong.send('disks', [], 'ana')).rejects.toThrow(
      /no instance of "shop" answered within 0\.5s — the app may have refused the command/,
    );
    const right = await buildFederatedMediaApp(
      'shop',
      {
        store: new InMemoryMediaStore(),
        controlPlane: { prefix: 'shop' },
        partition: 'shop-prod',
        timeoutMs: 500,
      },
      { container: container(bus, { 'agora.crypto': crypto.embedded('hub') }) },
    );
    expect(await right.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
  });

  it('`crypto: false` turns automatic mode off, and the boot says so', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    await expect(
      owningApp(bus, { 'agora.crypto': crypto.embedded('shop') }, { crypto: false }),
    ).rejects.toThrow(
      /^\[@adonis-agora\/media\] consoleCommands needs authentication: install and boot @adonis-agora\/crypto in this app \(automatic, key console-media\), or configure authkit-client's `service` \(automatic: the console uses an authkit app-call token; grant it media:console:\* on this app\), or set consoleCommands\.secret .*node ace agora:doctor.*Docs: https:/,
    );
    await expect(
      owningApp(new RedisBus(), { 'agora.crypto': crypto.embedded('shop') }, { crypto: false }),
    ).rejects.toThrow(/ Note: `crypto: false` turned the automatic crypto mode off\.$/);
    const side = resolveConsoleSideAuth({
      plane: { crypto: false },
      partition: 'shop',
      siblings: { crypto: crypto.embedded('hub') },
    });
    expect(side.mode).toBeUndefined();
  });

  it('explicit options win: a secret is used as given, no automatic crypto on top', async () => {
    const crypto = new FakeCrypto();
    const resolved = resolveAppConsoleAuth({
      options: { prefix: 'shop', secret: 'a-shared-secret-of-16+chars' },
      appKey: APP_KEY,
      siblings: { crypto: crypto.embedded('shop') },
    });
    expect(resolved.modes).toEqual(['secret']);
    expect(resolved.channel.crypto).toBeUndefined();
    const side = resolveConsoleSideAuth({
      plane: { secret: 'a-shared-secret-of-16+chars' },
      partition: 'shop',
      siblings: { crypto: crypto.embedded('hub') },
    });
    expect(side.mode).toBe('secret');
    expect(side.channel.crypto).toBeUndefined();
  });

  it('bring your own KMS: `crypto.owns` recognizes its ciphertext format', async () => {
    const bus = new RedisBus();
    const kms = {
      encrypt: async ({ plaintext }: { plaintext: string }) => ({
        ciphertext: `kms:v1:${Buffer.from(plaintext).toString('base64url')}`,
      }),
      decrypt: async ({ ciphertext }: { ciphertext: string }) => ({
        plaintext: Buffer.from(ciphertext.slice('kms:v1:'.length), 'base64url').toString(),
      }),
    };
    const owns = (ciphertext: string) => ciphertext.startsWith('kms:v1:');
    const app = await owningApp(bus, {}, { crypto: { cipher: kms, owns } });
    providers.push(app.provider);
    const hub = await hubConsole(bus, {}, { crypto: { cipher: kms, owns } });
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
  });
});

describe('automatic token (authkit calls between apps)', () => {
  it('auto crypto + auto token: sealed AND carrying the Hub app-call token, capped by its grant', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    const shopAuthkit = fakeAuthkit({ self: 'shop', grants: { hub: ['media:console:read'] } });
    const app = await owningApp(bus, {
      'agora.crypto': crypto.embedded('shop'),
      'authkit.client': shopAuthkit,
    });
    providers.push(app.provider);
    expect(app.lines.join('\n')).toMatch(
      /crypto \(auto, key console-media\) \+ token checked when sent \(authkit app-call, auto\)/,
    );
    const hub = await hubConsole(bus, {
      'agora.crypto': crypto.embedded('hub'),
      'authkit.client': fakeAuthkit({ self: 'hub' }),
    });
    // Reads pass (the app-call token's partition is "hub", not "shop": audience-bound, fine).
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
    // Actions: the app has them on, the viewer may, but authkit granted the Hub read only.
    await expect(hub.send('deleteMediaRecord', ['r1'], 'ana', ALL)).rejects.toMatchObject({
      status: 403,
    });
    expect(bus.wire).not.toContain('appcall:');
  });

  it('a token for another app is refused (401) and the console drops its cached token', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    const app = await owningApp(bus, {
      'agora.crypto': crypto.embedded('shop'),
      'authkit.client': fakeAuthkit({ self: 'shop', grants: { hub: ['media:console:*'] } }),
    });
    providers.push(app.provider);
    const authkit = fakeAuthkit({ self: 'hub' });
    // The Hub names the app "billing" (wrong partition): its token is for billing.
    const hub = await buildFederatedMediaApp(
      'shop',
      { store: new InMemoryMediaStore(), controlPlane: { prefix: 'shop' }, timeoutMs: 500 },
      {
        container: container(bus, {
          'agora.crypto': crypto.embedded('hub'),
          'authkit.client': {
            ...authkit,
            appCallTokens: () => ({ token: async () => 'appcall:hub->billing', reset: () => {} }),
          },
        }),
      },
    );
    await expect(hub.send('disks', [], 'ana')).rejects.toMatchObject({ status: 401 });
  });

  it('explicit crypto keeps the fallback verifiers: a token sent with it is still checked', async () => {
    const crypto = new FakeCrypto();
    const resolved = resolveAppConsoleAuth({
      options: { prefix: 'shop', crypto: { cipher: crypto.embedded('shop').operations } },
      appKey: APP_KEY,
      siblings: { authkit: fakeAuthkit({ self: 'shop' }) },
    });
    expect(resolved.channel.verifyAppCall).toBeDefined();
    expect(resolved.channel.cryptoRequiresToken).toBe(false);
    // And the APP_KEY-sealed token mode stays alongside (a migration path).
    expect(resolved.modes).toEqual([
      'crypto (key console-media) + token checked when sent (authkit app-call, auto)',
      expect.stringMatching(/^token \(authkit app-call, auto; sealed to key [A-Za-z0-9_-]{8}\)$/),
    ]);
    // Only an explicit verifyTenant (or false) turns the fallbacks off.
    const explicit = resolveAppConsoleAuth({
      options: { prefix: 'shop', verifyTenant: () => null, secret: 'a-shared-secret-of-16+chars' },
      appKey: APP_KEY,
      siblings: { authkit: fakeAuthkit({ self: 'shop' }) },
    });
    expect(explicit.channel.verifyAppCall).toBeUndefined();
  });

  it('`verifyTenant: false` and `token: false` switch the detection off', async () => {
    const crypto = new FakeCrypto();
    const app = resolveAppConsoleAuth({
      options: { prefix: 'shop', verifyTenant: false },
      appKey: APP_KEY,
      siblings: {
        crypto: crypto.embedded('shop'),
        authkit: fakeAuthkit({ self: 'shop' }),
      },
    });
    expect(app.channel.verifyAppCall).toBeUndefined();
    expect(app.keys).toBeUndefined();
    const side = resolveConsoleSideAuth({
      plane: { token: false },
      partition: 'shop',
      siblings: { crypto: crypto.embedded('hub'), authkit: fakeAuthkit({ self: 'hub' }) },
    });
    expect(side.channel.token).toBeUndefined();
    expect(side.channel.crypto).toBeDefined();
  });

  it('authkit without crypto: token mode sealed to the APP_KEY key (the console needs publicKey)', async () => {
    const bus = new RedisBus();
    const app = await owningApp(bus, {
      'authkit.client': fakeAuthkit({ self: 'shop', grants: { hub: ['media:*'] } }),
    });
    providers.push(app.provider);
    const { publicKey, kid } = consoleCommandKeys(APP_KEY, 'shop');
    // Only a short id in the boot log (`node ace media:console-key` prints the key).
    expect(app.lines.join('\n')).toContain(`sealed to key ${kid.slice(0, 8)})`);
    expect(app.lines.join('\n')).not.toContain(publicKey);
    const hub = await hubConsole(
      bus,
      { 'authkit.client': fakeAuthkit({ self: 'hub' }) },
      { publicKey },
    );
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
    // Without publicKey the console has no way to seal the token: nothing resolves.
    expect(
      resolveConsoleSideAuth({
        plane: { prefix: 'shop' } as never,
        partition: 'shop',
        siblings: { authkit: fakeAuthkit({ self: 'hub' }) },
      }).mode,
    ).toBeUndefined();
  });
});

describe('fallback verifyTenant (control plane)', () => {
  it('a control plane checks console tokens with its own verifyTenant, partition rule kept', async () => {
    const bus = new RedisBus();
    const verifyTenant = ({ token }: { token?: string }) =>
      token === 'hub-token'
        ? { partition: 'shop', capabilities: ['media:objects:read'], clientId: 'hub' }
        : token === 'billing-token'
          ? { partition: 'billing', capabilities: ['media:*'] }
          : null;
    const app = await owningApp(bus, {}, {}, { topology: 'control-plane', verifyTenant });
    providers.push(app.provider);
    const { publicKey } = consoleCommandKeys(APP_KEY, 'shop');
    const hub = await hubConsole(bus, {}, { token: 'hub-token', publicKey });
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
    const other = await hubConsole(bus, {}, { token: 'billing-token', publicKey });
    await expect(other.send('disks', [], 'ana')).rejects.toThrow(/token is for "billing"/);
  });
});

describe('the console side at boot (media_dashboard.apps)', () => {
  const bootDashboard = async (
    entry: Record<string, unknown>,
    bindings: Record<string, unknown>,
  ) => {
    const booted: Array<() => Promise<void>> = [];
    const infos: string[] = [];
    const warns: string[] = [];
    const config = {
      apps: {
        shop: { store: new InMemoryMediaStore(), controlPlane: { prefix: 'shop' }, ...entry },
      },
      actions: true,
    };
    const provider = new MediaDashboardProvider({
      config: {
        get: (key: string, def: unknown) =>
          key === 'media_dashboard'
            ? config
            : key === 'redis'
              ? { connection: 'main', connections: { main: {} } }
              : def,
      },
      getEnvironment: () => 'web',
      inProduction: false,
      container: {
        hasBinding: (name: string) => Object.hasOwn(bindings, name),
        make: async (token: unknown) => {
          if (typeof token === 'string' && Object.hasOwn(bindings, token)) return bindings[token];
          if (token === 'logger') {
            return { info: (l: string) => infos.push(l), warn: (l: string) => warns.push(l) };
          }
          if (token === 'router') throw new Error('stop before the routes');
          throw new Error(`unexpected ${String(token)}`);
        },
      },
      booted: async (hook: () => Promise<void>) => void booted.push(hook),
    } as never);
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void warns.push(String(m)));
    await provider.boot();
    const run = async () => {
      for (const hook of booted) await hook();
    };
    return { run, infos, warns };
  };

  it('an app it cannot authenticate to fails the boot, saying what to add', async () => {
    const { run } = await bootDashboard({}, {});
    await expect(run()).rejects.toThrow(
      /media_dashboard\.apps\["shop"\]: commands to this app need authentication: boot @adonis-agora\/crypto in this app \(automatic\), or set media_dashboard\.apps\["shop"\]\.controlPlane\.secret, or media_dashboard\.apps\["shop"\]\.controlPlane\.token — or actions: false to only browse it\. Run `node ace agora:doctor`/,
    );
  });

  it('a browse-only entry (actions: false) only warns', async () => {
    const { run, warns } = await bootDashboard({ actions: false }, {});
    await expect(run()).rejects.toThrow(/stop before the routes/);
    expect(warns.join('\n')).toMatch(/commands to this app need authentication/);
  });

  it('with crypto embedded, it resolves automatically and logs the mode', async () => {
    const crypto = new FakeCrypto();
    const { run, infos } = await bootDashboard({}, { 'agora.crypto': crypto.embedded('hub') });
    await expect(run()).rejects.toThrow(/stop before the routes/);
    await new Promise((r) => setTimeout(r, 10));
    expect(infos.join('\n')).toContain(
      '[@adonis-agora/media] console commands to "shop": crypto (auto, key console-media, partition shop)',
    );
    // The app's key is created at boot, not on the first command.
    expect(crypto.keys.has('shop/console-media')).toBe(true);
    expect(infos.join('\n')).toContain('created the crypto key "console-media" in partition shop');
  });
});

describe("the viewer's capabilities (the console's authorize)", () => {
  const sent = async (capabilities?: string[]) => {
    const commands: Array<{ capabilities?: string[] }> = [];
    const app = new FederatedApp({
      id: 'shop',
      store: new InMemoryMediaStore(),
      channel: {
        send: async (command: { id: string; capabilities?: string[] }) => {
          commands.push(command);
          return { id: command.id, ok: true, data: { data: [] } };
        },
      } as never,
    });
    const service = new FederatedConsoleService(app, {
      actions: true,
      ...(capabilities !== undefined ? { capabilities } : {}),
    });
    await service.disks();
    return commands[0]?.capabilities;
  };

  it('are always sent: all of them when authorize does not say, else narrowed to media', async () => {
    expect(await sent()).toEqual(ALL);
    expect(await sent(['media:console:read', 'flags:*'])).toEqual(['media:objects:read']);
    expect(await sent(['media:console:*'])).toEqual(ALL);
    expect(await sent(['flags:*'])).toEqual([]);
  });
});

describe('review round 2', () => {
  it('permitTokenCapabilities takes the shared console names (media:console:*) on the HTTP path', async () => {
    const { permitTokenCapabilities } = await import('../../src/dashboard/console_apps.js');
    const permit = permitTokenCapabilities();
    const caller = (capabilities: string[]) => ({ app: 'hub', claims: { capabilities } });
    expect(await permit(caller(['media:console:*']), 'media:objects:write', {} as never)).toBe(
      true,
    );
    expect(await permit(caller(['media:console:read']), 'media:objects:read', {} as never)).toBe(
      true,
    );
    expect(await permit(caller(['media:console:read']), 'media:objects:write', {} as never)).toBe(
      false,
    );
    expect(await permit(caller(['flags:console:*']), 'media:objects:read', {} as never)).toBe(
      false,
    );
    // Alias expansion is literal: a wildcard over the console names is no alias.
    const { capabilitiesAllow } = await import('../../src/dashboard/console_apps.js');
    expect(capabilitiesAllow(['*:console:*'], 'media:objects:write')).toBe(false);
    expect(capabilitiesAllow(['media:console:*'], 'media:objects:write')).toBe(true);
    expect(capabilitiesAllow(['media:*'], 'media:objects:write')).toBe(true);
    expect(capabilitiesAllow(['*'], 'media:objects:read')).toBe(true);
  });

  it("checks a tenant's key with a dummy decrypt, never getKey; refusals warn too", async () => {
    const crypto = new FakeCrypto();
    const getKey = vi.fn();
    const tenant = {
      ...crypto.tenant('shop'),
      operations: { ...crypto.tenant('shop').operations, getKey },
    };
    // Missing, and this app may not create it: ONE info line (the server provisions it on the
    // console's first seal), with the command for a server that does not.
    expect(await checkTenantConsoleKey(tenant as never)).toEqual({
      level: 'info',
      line: expect.stringContaining(
        'node ace crypto:keys:create console-media --type aes256-gcm --application shop',
      ),
    });
    // There: the dummy ciphertext does not open, which is the expected answer.
    crypto.create('shop', 'console-media');
    expect(await checkTenantConsoleKey(tenant as never)).toBeUndefined();
    // Forbidden or unreachable: one warning line naming the grant.
    const refused = {
      ...tenant,
      operations: {
        ...tenant.operations,
        decrypt: async () => {
          throw Object.assign(new Error('crypto: lacks crypto:decrypt:console-media'), {
            status: 403,
          });
        },
      },
    };
    expect(await checkTenantConsoleKey(refused as never)).toMatchObject({
      level: 'warn',
      line: expect.stringContaining("no grant is needed for an app's own console keys"),
    });
    expect(getKey).not.toHaveBeenCalled();
  });

  it('classifies a decrypt failure: missing, usable, refused, unreachable', () => {
    expect(classifyConsoleKeyError(Object.assign(new Error('x'), { code: 'not_found' }))).toBe(
      'missing',
    );
    expect(
      classifyConsoleKeyError(new Error('Unsupported state or unable to authenticate data')),
    ).toBe('usable');
    expect(classifyConsoleKeyError(new Error('crypto: lacks crypto:decrypt:console-media'))).toBe(
      'refused',
    );
    expect(classifyConsoleKeyError(new Error('connect ECONNREFUSED 127.0.0.1:3333'))).toBe(
      'unreachable',
    );
  });

  it("watches a tenant's key: one line per outcome change, the next command's decrypt is the retry", async () => {
    const crypto = new FakeCrypto();
    const tenant = crypto.tenant('shop');
    let down = true;
    const decrypt = tenant.operations.decrypt;
    tenant.operations.decrypt = async (input) => {
      if (down) throw new Error('fetch failed: ECONNREFUSED');
      return decrypt(input);
    };
    const lines: string[] = [];
    const watch = watchTenantConsoleKey(tenant, (note) => lines.push(note.line));
    await watch.atBoot();
    expect(lines).toEqual([expect.stringMatching(/could not check .*Retried on the next command/)]);
    // The same failure on a command: no second line.
    await expect(watch.decrypt({ key: 'console-media', ciphertext: 'x' })).rejects.toThrow();
    expect(lines).toHaveLength(1);
    // Back up, but the key is missing: one new line, with the exact command.
    down = false;
    await expect(watch.decrypt({ key: 'console-media', ciphertext: 'x' })).rejects.toThrow();
    expect(lines.at(-1)).toContain(
      'node ace crypto:keys:create console-media --type aes256-gcm --application shop',
    );
    expect(lines).toHaveLength(2);
  });

  it('an embedded crypto that cannot create the key logs the exact command', async () => {
    const crypto = new FakeCrypto();
    const runtime = crypto.embedded('shop');
    runtime.service!.createKey = async () => {
      throw new Error('database down');
    };
    expect(await consoleKeyReport(runtime)).toEqual({
      level: 'warn',
      line: expect.stringMatching(
        /database down.*node ace crypto:keys:create console-media --type aes256-gcm --application shop/,
      ),
    });
  });

  it('the authkit token is added with an explicit crypto too, never with a secret or token: false', () => {
    const cipher = {
      encrypt: async () => ({ ciphertext: '' }),
      decrypt: async () => ({ plaintext: '' }),
    };
    const siblings = { authkit: fakeAuthkit({ self: 'hub' }) };
    const withCrypto = resolveConsoleSideAuth({
      plane: { crypto: { cipher } },
      partition: 'shop',
      siblings,
    });
    expect(withCrypto.channel.token).toBeDefined();
    expect(withCrypto.mode).toBe('crypto (key console-media) + token (authkit app-call, auto)');
    for (const plane of [
      { crypto: { cipher }, secret: 'a-shared-secret-of-16+chars' },
      { crypto: { cipher }, token: false as const },
    ]) {
      expect(
        resolveConsoleSideAuth({ plane, partition: 'shop', siblings }).channel.token,
      ).toBeUndefined();
    }
  });

  it('the app-side auth error is thrown in boot() (web only), not in ready()', async () => {
    const make = (environment: string) =>
      new MediaProvider({
        config: {
          get: (key: string, def: unknown) =>
            key === 'media' ? { disk: 'fs', consoleCommands: { prefix: 'shop' } } : def,
        },
        getEnvironment: () => environment,
        container: {
          hasBinding: () => false,
          make: async () => {
            throw new Error('nothing');
          },
          singleton: vi.fn(),
        },
        booted: async () => {},
      } as never);
    await expect(make('web').boot()).rejects.toThrow(/consoleCommands needs authentication/);
    await expect(make('console').boot()).resolves.toBeUndefined();
    await expect(make('test').boot()).resolves.toBeUndefined();
  });
});

describe('§11: the doctor on the console side, and garbage on the channel', () => {
  it('13e: the doctor says the boot sentence, then that crypto is enough', async () => {
    const { checkConsoleCommands } = await import('../../src/doctor/checks.js');
    const crypto = new FakeCrypto();
    const app = {
      config: {
        get: (key: string, def: unknown) =>
          key === 'media'
            ? { consoleCommands: { prefix: 'shop' } }
            : key === 'app.appKey'
              ? APP_KEY
              : def,
      },
      container: {},
    } as never;
    const results = await checkConsoleCommands(app, {
      siblings: { crypto: crypto.embedded('shop'), authkit: fakeAuthkit({ self: 'shop' }) },
    });
    expect(results.map((r) => r.message)).toEqual([
      expect.stringMatching(
        /^console commands: crypto \(auto, key console-media\) \+ .*; sealed to key \w+\); actions off \(set consoleCommands\.actions to let the console act\)$/,
      ),
      "console commands: this app's token key is not published: crypto is enough to reach it.",
    ]);
  });

  it("media.console-commands-key checks each federated app's key from the console", async () => {
    const { checkConsoleCommandsKey } = await import('../../src/doctor/checks.js');
    const crypto = new FakeCrypto();
    const app = {
      config: {
        get: (key: string, def: unknown) =>
          key === 'media_dashboard'
            ? { apps: { shop: { store: {}, controlPlane: { prefix: 'shop' } } } }
            : def,
      },
      container: {},
    } as never;
    const { checkConsoleCommands } = await import('../../src/doctor/checks.js');
    expect(
      (await checkConsoleCommands(app, { siblings: { crypto: crypto.embedded('hub') } }))[0]
        ?.message,
    ).toBe('console commands to "shop": crypto (auto, key console-media, partition shop)');
    // Crypto embedded in the Hub: the key is created, a probe encrypts and decrypts.
    const embedded = await checkConsoleCommandsKey(app, {
      siblings: { crypto: crypto.embedded('hub') },
    });
    expect(embedded).toEqual([
      expect.objectContaining({
        status: 'ok',
        message:
          'The console, for "shop": "console-media" encrypts and decrypts in partition shop.',
      }),
    ]);
    // A console that is a crypto tenant: it seals (crypto:seal) — or says what to grant.
    const sealing = await checkConsoleCommandsKey(app, {
      siblings: { crypto: crypto.tenant('hub', { seal: true }) },
    });
    expect(sealing[0]).toMatchObject({
      status: 'ok',
      message: expect.stringContaining('encrypts in'),
    });
    const refused = await checkConsoleCommandsKey(app, {
      siblings: { crypto: crypto.tenant('hub') },
    });
    expect(refused[0]).toMatchObject({
      status: 'error',
      fix: expect.stringContaining('crypto:seal:console-*'),
    });
  });

  it('never crashes on a bad message: garbage is logged once per reason and dropped', async () => {
    const bus = new RedisBus();
    const crypto = new FakeCrypto();
    const app = await owningApp(
      bus,
      { 'agora.crypto': crypto.embedded('shop') },
      { actions: true },
    );
    providers.push(app.provider);
    expect(app.lines.join('\n')).toMatch(/; actions on$/m);
    const raw = bus.connection();
    for (const garbage of [
      'not json',
      '{"id":',
      'null',
      '[]',
      '42',
      JSON.stringify({ id: 7 }),
      JSON.stringify({ id: 'x', sealed: 'agora:ct1:console-media:1:garbage' }),
      JSON.stringify({ id: 'y', sealed: 'agora:ct1:console-media:1:garbage' }),
      JSON.stringify({ id: 'z', verb: 'disks', args: [], capabilities: ['*'] }),
      JSON.stringify({ id: 'w', mac: 'x', verb: 'disks' }),
    ]) {
      await raw.publish('shop-media-console', garbage);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Still serving.
    const hub = await hubConsole(bus, { 'agora.crypto': crypto.embedded('hub') });
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
    // Each refusal reason once.
    const refused = app.lines.filter((l) => l.includes('console commands: refused a command ('));
    expect(new Set(refused).size).toBe(refused.length);
    // The uniform reasons (§11b), never "(unsigned?)".
    expect(refused).toEqual(
      expect.arrayContaining([
        '[@adonis-agora/media] console commands: refused a command (not JSON)',
        '[@adonis-agora/media] console commands: refused a command (no command id)',
        "[@adonis-agora/media] console commands: refused a command (did not open with this app's key)",
        '[@adonis-agora/media] console commands: refused a command (mode not accepted here (this app accepts: crypto; the command came as unsigned))',
        '[@adonis-agora/media] console commands: refused a command (mode not accepted here (this app accepts: crypto; the command came as secret))',
      ]),
    );
    expect(app.lines.join('\n')).not.toContain('unsigned?');
  });
});

describe('§11 notes: why the automatic modes did not apply', () => {
  it('app side: a verifier without an APP_KEY', () => {
    expect(() =>
      resolveAppConsoleAuth({
        options: { prefix: 'shop' },
        appKey: undefined,
        siblings: { authkit: fakeAuthkit({ self: 'shop' }) },
      }),
    ).toThrow(
      / Note: a token verifier is available \(authkit app-call, auto\), but token mode needs an APP_KEY/,
    );
  });

  it('console side: the real entry path, and crypto: false / token: false / authkit without publicKey', async () => {
    const { consoleSideAuthMessage } = await import('../../src/federation/console_auth.js');
    const off = consoleSideAuthMessage('shop', {}, { crypto: false, token: false });
    expect(off).toContain(
      'media_dashboard.apps["shop"]: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set media_dashboard.apps["shop"].controlPlane.secret, or media_dashboard.apps["shop"].controlPlane.token — or actions: false to only browse it.',
    );
    expect(off).toMatch(
      / Note: `crypto: false` turned the automatic crypto mode off; `token: false` turned the automatic authkit token off\.$/,
    );
    expect(consoleSideAuthMessage('shop', { authkit: fakeAuthkit({ self: 'hub' }) }, {})).toMatch(
      /Note: authkit's app-call token is available, but .*media_dashboard\.apps\["shop"\]\.controlPlane\.publicKey/,
    );
    expect(consoleSideAuthMessage('shop', {}, {})).not.toContain('Note:');
  });
});

describe("§2e.B: authkit's key directory (token mode without crypto)", () => {
  /** authkit's directory, shared by the fakes: what each app published, by app and purpose. */
  function directory() {
    const keys = new Map<string, unknown>();
    const published: Array<{ app: string; purpose: string; jwk: Record<string, unknown> }> = [];
    const manager = (self: string, grants: Record<string, string[]> = {}) => ({
      ...fakeAuthkit({ self, grants }),
      publishAppKey: async ({
        purpose,
        jwk,
      }: {
        purpose: string;
        jwk: Record<string, unknown>;
      }) => {
        published.push({ app: self, purpose, jwk });
        keys.set(`${self}/${purpose}`, jwk);
      },
      appKey: async ({ app, purpose }: { app: string; purpose: string }) =>
        (keys.get(`${app}/${purpose}`) as never) ?? null,
    });
    return { manager, published };
  }

  it('the app publishes its public key; the console fetches it: no publicKey to copy', async () => {
    const bus = new RedisBus();
    const dir = directory();
    const app = await owningApp(bus, {
      'authkit.client': dir.manager('shop', { hub: ['media:*'] }),
    });
    providers.push(app.provider);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { publicKey, kid } = consoleCommandKeys(APP_KEY, 'shop');
    expect(dir.published).toEqual([
      {
        app: 'shop',
        purpose: 'console:media',
        jwk: { kty: 'OKP', crv: 'X25519', x: publicKey, kid },
      },
    ]);
    expect(dir.published[0]?.jwk).not.toHaveProperty('d');
    const hub = await hubConsole(bus, { 'authkit.client': dir.manager('hub') });
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
  });

  it('an explicit publicKey wins; a missing one is an actionable error', async () => {
    const bus = new RedisBus();
    const dir = directory();
    const app = await owningApp(bus, {
      'authkit.client': dir.manager('shop', { hub: ['media:*'] }),
    });
    providers.push(app.provider);
    const { publicKey } = consoleCommandKeys(APP_KEY, 'shop');
    // The directory holds a wrong key for "shop": the explicit one is used anyway.
    const wrong = directory();
    await wrong.manager('shop').publishAppKey({
      purpose: 'console:media',
      jwk: {
        kty: 'OKP',
        crv: 'X25519',
        x: consoleCommandKeys('another-key-0123456789', 'shop').publicKey,
      },
    });
    const explicit = await hubConsole(
      bus,
      { 'authkit.client': wrong.manager('hub') },
      { publicKey },
    );
    expect(await explicit.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
    // Nothing published for "billing": the error says how it gets there.
    const empty = directory();
    const nobody = await buildFederatedMediaApp(
      'billing',
      { store: new InMemoryMediaStore(), controlPlane: { prefix: 'shop' }, timeoutMs: 300 },
      { container: container(bus, { 'authkit.client': empty.manager('hub') }) },
    );
    await expect(nobody.send('disks', [], 'ana')).rejects.toThrow(
      /"billing" has published no console:media key in authkit's key directory: it publishes it automatically at boot when it has authkit's `service` configured.*controlPlane\.publicKey/,
    );
  });

  it('boot validation accepts a token without publicKey when the directory is there', async () => {
    const { validateFederatedConsoleApp } = await import('../../src/federation/console.js');
    const entry = {
      store: new InMemoryMediaStore(),
      controlPlane: { prefix: 'shop', token: 'hub-token' },
    } as never;
    const redis = { names: ['main'], default: 'main' };
    expect(() => validateFederatedConsoleApp('shop', entry, redis)).toThrow(/publicKey/);
    expect(() =>
      validateFederatedConsoleApp('shop', entry, redis, { keyDirectory: true }),
    ).not.toThrow();
  });
});

describe('§13: a mixed Hub (one crypto app, one authkit-only app), no lib config lines', () => {
  /** authkit's key directory and app-call tokens, shared by every fake manager. */
  function authkitServer() {
    const keys = new Map<string, unknown>();
    let minted = 0;
    let failing: string | undefined;
    const manager = (
      self: string,
      grants: Record<string, string[]> = {},
      extra: { publish?: boolean } = {},
    ) => ({
      ...fakeAuthkit({ self, grants }),
      appCallTokens: () => ({
        token: async (app: string) => {
          minted += 1;
          if (failing) throw Object.assign(new Error(failing), { code: failing });
          return `appcall:${self}->${app}`;
        },
        reset: () => {},
      }),
      ...(extra.publish === false
        ? {}
        : {
            publishAppKey: async ({ purpose, jwk }: { purpose: string; jwk: unknown }) => {
              keys.set(`${self}/${purpose}`, jwk);
            },
          }),
      appKey: async ({ app, purpose }: { app: string; purpose: string }) =>
        (keys.get(`${app}/${purpose}`) as never) ?? null,
    });
    return {
      manager,
      keys,
      minted: () => minted,
      fail: (reason: string | undefined) => {
        failing = reason;
      },
    };
  }

  const hubWith = async (bus: RedisBus, bindings: Record<string, unknown>) => {
    const c = container(bus, bindings);
    const hub = await buildFederatedMediaApp(
      'shop',
      { store: new InMemoryMediaStore(), controlPlane: { prefix: 'shop' }, timeoutMs: 300 },
      { container: c },
    );
    return { hub, lines: c.lines };
  };

  it('13a: the crypto app is reached with crypto, the authkit-only app with its published key', async () => {
    const crypto = new FakeCrypto();
    const authkit = authkitServer();
    const hubBindings = {
      'agora.crypto': crypto.embedded('hub'),
      'authkit.client': authkit.manager('hub'),
    };
    // ET: a crypto tenant (it publishes nothing: crypto is its way in, §13e).
    const etBus = new RedisBus();
    const et = await owningApp(etBus, {
      'agora.crypto': crypto.tenant('shop'),
      'authkit.client': authkit.manager('shop', { hub: ['media:*'] }),
    });
    providers.push(et.provider);
    expect(authkit.keys.size).toBe(0);
    crypto.create('shop', 'console-media');
    const toEt = await hubWith(etBus, hubBindings);
    expect(await toEt.hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });

    // EduLiberta: authkit only, token mode, its key published at boot.
    const elBus = new RedisBus();
    const el = await owningApp(elBus, {
      'authkit.client': authkit.manager('shop', { hub: ['media:*'] }),
    });
    providers.push(el.provider);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(authkit.keys.has('shop/console:media')).toBe(true);
    const toEl = await hubWith(elBus, hubBindings);
    expect(await toEl.hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
  });

  it('13a: the boot label when both ways are possible', () => {
    const crypto = new FakeCrypto();
    const side = resolveConsoleSideAuth({
      plane: {},
      partition: 'shop',
      siblings: { crypto: crypto.embedded('hub'), authkit: authkitServer().manager('hub') },
    });
    expect(side.mode).toBe(
      'auto (authkit key directory if the app publishes one, else crypto (auto, key console-media, partition shop))',
    );
    // Explicit fields still win.
    expect(
      resolveConsoleSideAuth({
        plane: { crypto: false },
        partition: 'shop',
        siblings: { crypto: crypto.embedded('hub'), authkit: authkitServer().manager('hub') },
      }).mode,
    ).toBe(
      'token (authkit app-call, auto, authkit key directory; sealed to the key the app publishes)',
    );
  });

  it('13a: the choice is cached, decided again after 5 minutes or when the app did not take it', async () => {
    const { directoryChooser } = await import('../../src/federation/console_auth.js');
    const authkit = authkitServer();
    let now = 0;
    const chooser = directoryChooser(authkit.manager('hub'), 'shop', () => now);
    expect(await chooser.choose()).toBe('crypto');
    authkit.keys.set('shop/console:media', { kty: 'OKP', crv: 'X25519', x: 'x'.repeat(43) });
    expect(await chooser.choose()).toBe('crypto');
    now += 5 * 60_000;
    expect(await chooser.choose()).toBe('token');
    authkit.keys.clear();
    chooser.reset();
    expect(await chooser.choose()).toBe('crypto');
  });

  it('13a: an app that refuses the crypto way (no answer) makes the console decide again', async () => {
    const crypto = new FakeCrypto();
    const authkit = authkitServer();
    const bus = new RedisBus();
    // The authkit-only app is up, but its key is not in the directory yet.
    const el = await owningApp(bus, {
      'authkit.client': authkit.manager('shop', { hub: ['media:*'] }, { publish: false }),
    });
    providers.push(el.provider);
    const { hub } = await hubWith(bus, {
      'agora.crypto': crypto.embedded('hub'),
      'authkit.client': authkit.manager('hub'),
    });
    await expect(hub.send('disks', [], 'ana')).rejects.toThrow(/answered within/);
    // The key appears: the next command decides again, with the token.
    const { publicKey, kid } = consoleCommandKeys(APP_KEY, 'shop');
    authkit.keys.set('shop/console:media', { kty: 'OKP', crv: 'X25519', x: publicKey, kid });
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
  });

  it('13b: in crypto mode a failing token never blocks the command (one warn, retried in 5 min)', async () => {
    const crypto = new FakeCrypto();
    const authkit = authkitServer();
    const bus = new RedisBus();
    const et = await owningApp(bus, {
      'agora.crypto': crypto.embedded('shop'),
      'authkit.client': authkit.manager('shop', { hub: ['media:*'] }),
    });
    providers.push(et.provider);
    authkit.fail('invalid_target');
    const { hub, lines } = await hubWith(bus, {
      'agora.crypto': crypto.embedded('hub'),
      'authkit.client': { ...authkit.manager('hub'), appKey: undefined },
    });
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lines.filter((l) => l.includes('sending without'))).toEqual([
      '[@adonis-agora/media] console commands to "shop": sending without an authkit app-call token (crypto only): invalid_target. To attach it: grant the console\'s service client media:console:* on "shop" in authkit.',
    ]);
    // Not minted again before 5 minutes.
    expect(authkit.minted()).toBe(1);
  });

  it('13a: auto-chose token (a stale published key) but no token can be minted: crypto, with the warning', async () => {
    const crypto = new FakeCrypto();
    const authkit = authkitServer();
    const bus = new RedisBus();
    // A crypto app now; an older version of it published a token key.
    const et = await owningApp(bus, { 'agora.crypto': crypto.embedded('shop') });
    providers.push(et.provider);
    authkit.keys.set('shop/console:media', {
      kty: 'OKP',
      crv: 'X25519',
      x: consoleCommandKeys('an-old-app-key-0123456789', 'shop').publicKey,
    });
    authkit.fail('invalid_target');
    const { hub, lines } = await hubWith(bus, {
      'agora.crypto': crypto.embedded('hub'),
      'authkit.client': authkit.manager('hub'),
    });
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
    // The decision switched to crypto for 5 minutes: no failing mint per command.
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
    expect(await hub.send('disks', [], 'ana')).toMatchObject({ data: [{ name: 'fs' }] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lines.filter((l) => l.includes('sending without'))).toEqual([
      '[@adonis-agora/media] console commands to "shop": sending without an authkit app-call token (crypto only): invalid_target. To attach it: grant the console\'s service client media:console:* on "shop" in authkit.',
    ]);
    expect(authkit.minted()).toBe(1);
  });

  it('13a: settle() keeps the chosen way for 5 minutes', async () => {
    const { directoryChooser } = await import('../../src/federation/console_auth.js');
    const authkit = authkitServer();
    authkit.keys.set('shop/console:media', { kty: 'OKP', crv: 'X25519', x: 'x'.repeat(43) });
    let now = 0;
    const chooser = directoryChooser(authkit.manager('hub'), 'shop', () => now);
    expect(await chooser.choose()).toBe('token');
    chooser.settle('crypto');
    now += 5 * 60_000 - 1;
    expect(await chooser.choose()).toBe('crypto');
    now += 1;
    expect(await chooser.choose()).toBe('token');
  });

  it('13b: the crypto-only line is info for a missing grant, warn for anything else', async () => {
    const crypto = new FakeCrypto();
    for (const [reason, code, level] of [
      // The canonical "missing grant": code invalid_target, or "not granted" / "no grant".
      ['the target is not allowed for this client', 'invalid_target', 'info'],
      ['the app "shop" is not granted to this client', undefined, 'info'],
      ['No grant for "shop"', undefined, 'info'],
      // Anything else warns: a client misconfiguration, authkit unreachable.
      ['unauthorized_client', 'unauthorized_client', 'warn'],
      // authkit-client's mint errors carry the code in the message.
      ['invalid_target', undefined, 'info'],
      ['token request failed (400 invalid_target): Grant it: …', undefined, 'info'],
      ['connect ECONNREFUSED 127.0.0.1:3333', undefined, 'warn'],
    ] as const) {
      const said: Array<[string, string]> = [];
      const side = resolveConsoleSideAuth({
        plane: {},
        partition: 'shop',
        siblings: {
          crypto: crypto.embedded('hub'),
          authkit: {
            appCallTokens: () => ({
              token: async () => {
                throw new Error(reason);
              },
            }),
          },
        },
        log: (lvl, line) => said.push([lvl, line]),
      });
      side.channel.tokenOptional?.(reason, code);
      expect(said).toEqual([
        [
          level,
          `[@adonis-agora/media] console commands to "shop": sending without an authkit app-call token (crypto only): ${reason}. To attach it: grant the console's service client media:console:* on "shop" in authkit.`,
        ],
      ]);
    }
  });

  it('13b: in token mode the token is required: the error carries the grant hint', async () => {
    const authkit = authkitServer();
    const bus = new RedisBus();
    const el = await owningApp(bus, {
      'authkit.client': authkit.manager('shop', { hub: ['media:*'] }),
    });
    providers.push(el.provider);
    await new Promise((resolve) => setTimeout(resolve, 5));
    authkit.fail('invalid_target');
    const { hub } = await hubWith(bus, { 'authkit.client': authkit.manager('hub') });
    await expect(hub.send('disks', [], 'ana')).rejects.toThrow(
      /invalid_target\. To attach it: grant the console's service client media:console:\* on "shop" in authkit\./,
    );
  });

  it('13e: a crypto app publishes nothing and says nothing; a token-only app without service warns', async () => {
    const crypto = new FakeCrypto();
    const published = vi.fn(async () => {});
    const bus = new RedisBus();
    const et = await owningApp(bus, {
      'agora.crypto': crypto.embedded('shop'),
      'authkit.client': { ...fakeAuthkit({ self: 'shop' }), publishAppKey: published },
    });
    providers.push(et.provider);
    expect(published).not.toHaveBeenCalled();
    expect(et.lines.join('\n')).not.toMatch(/publish|service/);
    const el = await owningApp(new RedisBus(), { 'authkit.client': fakeAuthkit({ self: 'shop' }) });
    providers.push(el.provider);
    expect(el.lines.join('\n')).toContain(
      "token mode is this app's only way to be reached, but authkit-client's `service` is not configured, so its key is not in authkit's key directory",
    );
  });

  it("13f: crypto's hasKey answers the key check: no decrypt (no audit error row)", async () => {
    const crypto = new FakeCrypto();
    const decrypt = vi.fn(async () => {
      throw new Error('should not decrypt');
    });
    const tenant = (exists: boolean) => ({
      ...crypto.tenant('shop'),
      operations: { ...crypto.tenant('shop').operations, decrypt, hasKey: async () => exists },
    });
    expect(await checkTenantConsoleKey(tenant(true) as never)).toBeUndefined();
    expect(await checkTenantConsoleKey(tenant(false) as never)).toMatchObject({
      level: 'info',
      line: expect.stringContaining('does not exist in partition shop yet'),
    });
    expect(decrypt).not.toHaveBeenCalled();
    // Without hasKey (an older crypto): the decrypt probe, as before.
    expect(await checkTenantConsoleKey(crypto.tenant('shop'))).toMatchObject({ level: 'info' });
    // A forbidden hasKey is the "no permission" outcome; any other throw (an older server without
    // the route) falls back to the decrypt probe.
    const throwing = (error: Error) => ({
      ...crypto.tenant('shop'),
      operations: {
        ...crypto.tenant('shop').operations,
        hasKey: async () => {
          throw error;
        },
      },
    });
    expect(
      await checkTenantConsoleKey(
        throwing(Object.assign(new Error('forbidden'), { code: 'forbidden' })) as never,
      ),
    ).toMatchObject({ level: 'warn', line: expect.stringContaining('refused this app') });
    crypto.create('shop', 'console-media');
    expect(
      await checkTenantConsoleKey(throwing(new Error('Cannot POST /v1/keys/has')) as never),
    ).toBeUndefined();
  });
});

describe('§13a: any send failure drops the cached choice', () => {
  it('nobody listening, a timeout, or a command that cannot be prepared: decided again', async () => {
    const { RedisConsoleChannel } = await import('../../src/federation/redis_channel.js');
    const crypto = new FakeCrypto();
    crypto.create('shop', 'console-media');
    let resets = 0;
    let way: 'token' | 'crypto' = 'crypto';
    const chooser = {
      choose: async () => way,
      reset: () => {
        resets += 1;
      },
      settle: () => {},
    };
    const channel = new RedisConsoleChannel({
      client: new RedisBus().connection(),
      prefix: 'shop',
      crypto: {
        cipher: {
          encrypt: crypto.embedded('shop').operations.encrypt,
          decrypt: async () => ({ plaintext: '' }),
        },
      },
      token: 'appcall:hub->shop',
      tokenOptional: () => {},
      recipient: async () => {
        throw new Error('no key published');
      },
      chooser,
    });
    const send = () =>
      channel.send(
        { id: crypto_id(), verb: 'disks', args: [], capabilities: ALL },
        { timeoutMs: 50 },
      );
    // Nobody listens on this bus.
    await expect(send()).rejects.toThrow(/listens/);
    expect(resets).toBe(1);
    // The token way cannot be prepared (no published key).
    way = 'token';
    await expect(send()).rejects.toThrow(/no key published/);
    expect(resets).toBe(2);
  });
});

function crypto_id(): string {
  return `cmd-${Math.random().toString(36).slice(2)}`;
}
