import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import MediaProvider from '../../providers/media_provider.js';
import { DashboardService } from '../../src/dashboard/service.js';
import { mediaConsoleCommandHandler } from '../../src/federation/console.js';
import {
  type ConsoleCipher,
  consoleCommandKeys,
  type MediaConsoleCommand,
  RedisConsoleChannel,
  UNAUTHORIZED_CONSOLE,
  UNSIGNED_CHANNEL,
} from '../../src/federation/redis_channel.js';
import { MediaManager } from '../../src/media_manager.js';
import { InMemoryMediaStore } from '../../src/testing/in_memory_media_store.js';
import type { TenantVerifier } from '../../src/topology/auth.js';
import { RedisBus } from '../support/redis_bus.js';

/**
 * The federated media console's Redis channel is authenticated: reads (listing a disk, signing URLs
 * for any key) and actions alike. Three modes — a shared secret, a token sealed to a key derived
 * from the app's APP_KEY (authkit), and a command sealed with an @adonis-agora/crypto key — and an
 * app with none answers nothing.
 */

const PREFIX = 'shop';
const APP_KEY = 'app-key-of-the-shop-0123456789';
const SECRET = 'media-federation-secret-0123456789';
const COMMANDS = `${PREFIX}-media-console`;
const REPLIES = `${PREFIX}-media-console-reply`;

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The owning app's storage: one disk with a private object, signed URLs for any key. */
function ownStorage() {
  const files = new Map<string, Uint8Array>([['private/contract.pdf', new Uint8Array([1])]]);
  const store = new InMemoryMediaStore();
  const disk = {
    capabilities: { presign: true, multipart: false, publicUrls: false, list: true },
    async list(prefix: string) {
      const keys = [...files.keys()].filter((k) => k.startsWith(prefix));
      return { folders: [], files: keys.map((key) => ({ key, name: key, sizeBytes: 1 })) };
    },
    async stat(key: string) {
      if (!files.has(key)) throw new Error(`ENOENT ${key}`);
      return { size: 1, contentType: 'application/pdf' };
    },
    async size() {
      return 1;
    },
    async getSignedUrl(key: string) {
      return `https://bucket.invalid/${key}?sig=1`;
    },
    async delete(key: string) {
      files.delete(key);
    },
    async deleteMany(keys: string[]) {
      for (const key of keys) files.delete(key);
    },
    async copy(from: string, to: string) {
      files.set(to, files.get(from) as Uint8Array);
    },
    async move(from: string, to: string) {
      files.set(to, files.get(from) as Uint8Array);
      files.delete(from);
    },
  };
  const service = async () =>
    new DashboardService(
      {
        storage: { defaultDisk: 'fs', disk: () => disk as never },
        hasResumable: false,
        resumable: { list: async () => [], abort: async () => {}, listParts: async () => [] },
        store,
      },
      { diskNames: ['fs'], actions: true, objectUrls: { strategy: 'auto', apiBasePath: '/m' } },
    );
  return { files, store, service };
}

/** An app answering on `bus` with `auth`, recording what its handler ran. */
async function answeringApp(
  bus: RedisBus,
  auth: Omit<ConstructorParameters<typeof RedisConsoleChannel>[0], 'client' | 'prefix'>,
  options: { actions?: boolean; partition?: string } = {},
) {
  const storage = ownStorage();
  const seen: MediaConsoleCommand[] = [];
  const errors: unknown[] = [];
  const log: string[] = [];
  const handler = mediaConsoleCommandHandler({
    service: storage.service,
    actions: options.actions ?? true,
    partition: options.partition ?? 'shop',
    log: (line) => log.push(line),
  });
  const channel = new RedisConsoleChannel({ client: bus.connection(), prefix: PREFIX, ...auth });
  await channel.answer(
    async (command) => {
      seen.push(command);
      return handler(command);
    },
    { onError: (error) => errors.push(error) },
  );
  return { ...storage, seen, errors, log, channel };
}

/** A command as the console sends it: always with the viewer's capabilities (here: all). */
const command = (verb: string, ...args: unknown[]): MediaConsoleCommand => ({
  id: randomUUID(),
  verb,
  args,
  actor: 'alice@hub',
  capabilities: ['media:objects:read', 'media:objects:write'],
});

describe('federated media console: no authentication', () => {
  it('neither sends nor answers', async () => {
    const bus = new RedisBus();
    const channel = new RedisConsoleChannel({ client: bus.connection(), prefix: PREFIX });
    expect(channel.signed).toBe(false);
    await expect(channel.answer(async () => null)).rejects.toMatchObject({
      code: UNSIGNED_CHANNEL,
    });
    await expect(channel.send(command('disks'), { timeoutMs: 100 })).rejects.toMatchObject({
      code: UNSIGNED_CHANNEL,
    });
    expect(bus.published).toHaveLength(0);
  });

  it('an app with consoleCommands but no mode fails to boot, saying what to add', async () => {
    const bus = new RedisBus();
    const lines: string[] = [];
    const config: Record<string, unknown> = {
      media: { disk: 'fs', consoleCommands: { prefix: PREFIX, actions: true } },
      'app.appKey': APP_KEY,
    };
    const provider = new MediaProvider({
      config: { get: (key: string, def: unknown) => config[key] ?? def },
      getEnvironment: () => 'web',
      container: {
        make: async (token: unknown) => {
          if (token === 'redis') return { connection: () => bus.connection() };
          if (token === 'logger') {
            const push = (l: string) => lines.push(l);
            return { info: push, warn: push, error: push };
          }
          throw new Error(`unexpected ${String(token)}`);
        },
      },
    } as never);
    await expect(provider.ready()).rejects.toThrow(
      /consoleCommands needs authentication: install and boot @adonis-agora\/crypto in this app \(automatic, key console-media\), or configure authkit-client's `service` \(automatic: the console uses an authkit app-call token; grant it media:console:\* on this app\), or set consoleCommands\.secret \(shared with the console\), or consoleCommands\.verifyTenant \(your own verifier; needs an APP_KEY\)/,
    );
    // Nobody subscribed: a plain command published by anyone on Redis reaches no handler.
    expect(await bus.connection().publish(COMMANDS, JSON.stringify(command('disks')))).toBe(0);
  });
});

describe('federated media console: shared secret', () => {
  it('refuses unsigned, forged, tampered, stale and replayed commands, reads included', async () => {
    const bus = new RedisBus();
    const app = await answeringApp(bus, { secret: SECRET });
    const raw = bus.connection();
    // Someone on Redis asks for signed URLs of a private key, and to list the disk.
    await raw.publish(
      COMMANDS,
      JSON.stringify(command('objectUrls', [{ disk: 'fs', key: 'private/contract.pdf' }])),
    );
    await raw.publish(
      COMMANDS,
      JSON.stringify({ ...command('objects', 'fs'), ts: Date.now(), mac: 'AAAA' }),
    );
    await settle();
    expect(app.seen).toHaveLength(0);
    expect(bus.published.filter((p) => p.channel === REPLIES)).toHaveLength(0);
    for (const error of app.errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });

    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    const reply = await console.send(command('remove', { disk: 'fs', keys: ['x'] }));
    expect(reply).toMatchObject({ ok: true });
    expect(app.seen).toHaveLength(1);
    expect(app.seen[0]).not.toHaveProperty('mac');

    // A replay of the signed message does not run twice; a tampered copy fails the MAC.
    const signed = bus.published.find(
      (p) => p.channel === COMMANDS && p.message.includes('"mac"'),
    )!;
    await raw.publish(COMMANDS, signed.message);
    const tampered = { ...JSON.parse(signed.message), id: randomUUID(), verb: 'deleteFolder' };
    await raw.publish(COMMANDS, JSON.stringify(tampered));
    const escalated = { ...JSON.parse(signed.message), id: randomUUID(), actor: 'mallory' };
    await raw.publish(COMMANDS, JSON.stringify(escalated));
    // A stale command (signed over a minute ago) is refused even with a valid MAC.
    const stale = new RedisConsoleChannel({ client: raw, prefix: PREFIX, secret: SECRET });
    const realNow = Date.now;
    Date.now = () => realNow() - 120_000;
    let staleWire = '';
    const publish = raw.publish;
    raw.publish = async (channel, message) => {
      if (channel === COMMANDS) staleWire = message;
      return 0;
    };
    await stale.send(command('disks'), { timeoutMs: 50 }).catch(() => undefined);
    Date.now = realNow;
    raw.publish = publish;
    await raw.publish(COMMANDS, staleWire);
    await settle();
    expect(app.seen).toHaveLength(1);
  });

  it('ignores a forged answer and waits for the signed one', async () => {
    const bus = new RedisBus();
    const raw = bus.connection();
    // A rogue subscriber answers first, sending viewers to its own URLs.
    await raw.subscribe(COMMANDS, (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(REPLIES, JSON.stringify({ id, ok: true, data: ['https://evil.example/'] }));
    });
    await answeringApp(bus, { secret: SECRET });
    const console = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    const reply = await console.send(
      command('objectUrls', [{ disk: 'fs', key: 'private/contract.pdf' }]),
    );
    expect(reply).toEqual({
      id: expect.any(String),
      ok: true,
      data: ['https://bucket.invalid/private/contract.pdf?sig=1'],
    });
  });

  it('a secret shorter than 16 characters is refused', () => {
    expect(
      () =>
        new RedisConsoleChannel({
          client: new RedisBus().connection(),
          prefix: 'x',
          secret: 'short',
        }),
    ).toThrow(/at least 16 characters/);
  });
});

/** A stand-in for authkitTenantVerifier: one token per console client. */
const verifyTenant: TenantVerifier = ({ token }) => {
  if (token === 'hub-admin') {
    return {
      partition: 'shop',
      capabilities: ['media:objects:read', 'media:objects:write'],
      clientId: 'hub',
    };
  }
  if (token === 'hub-reader') {
    return { partition: 'shop', capabilities: ['media:objects:read'], clientId: 'hub-ro' };
  }
  if (token === 'hub-nothing') return { partition: 'shop', capabilities: [], clientId: 'hub-0' };
  if (token === 'hub-other-app') {
    return { partition: 'billing', capabilities: ['media:*'], clientId: 'hub-billing' };
  }
  return null;
};

describe('federated media console: token mode (authkit)', () => {
  const keys = consoleCommandKeys(APP_KEY, PREFIX);
  const setup = async (options: { actions?: boolean } = {}) => {
    const bus = new RedisBus();
    const app = await answeringApp(bus, { keys, verifyTenant, partition: 'shop' }, options);
    const consoleWith = (token: string, onReset?: () => void) =>
      new RedisConsoleChannel({
        client: bus.connection(),
        prefix: PREFIX,
        token: Object.assign(async () => token, { reset: () => onReset?.() }),
        // From the console's own config (`node ace media:console-key` on the app), never Redis.
        recipient: keys.publicKey,
      });
    return { bus, app, consoleWith };
  };

  it('derives the same key from the same APP_KEY, and another for another prefix or key', () => {
    expect(consoleCommandKeys(APP_KEY, PREFIX).publicKey).toBe(keys.publicKey);
    expect(consoleCommandKeys(APP_KEY, 'other').publicKey).not.toBe(keys.publicKey);
    expect(consoleCommandKeys(`${APP_KEY}x`, PREFIX).publicKey).not.toBe(keys.publicKey);
    expect(keys.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('runs a read whose token the app verifies, with nothing readable on Redis', async () => {
    const { bus, app, consoleWith } = await setup();
    const reply = await consoleWith('hub-reader').send(
      command('objectUrls', [{ disk: 'fs', key: 'private/contract.pdf' }]),
    );
    expect(reply).toMatchObject({ ok: true, data: [expect.stringContaining('contract.pdf')] });
    expect(app.seen[0]?.verified).toEqual({
      partition: 'shop',
      capabilities: ['media:objects:read'],
      clientId: 'hub-ro',
    });
    // The command (its disk and key, its actor) and the token cross Redis sealed.
    const commands = bus.published.filter((p) => p.channel === COMMANDS).map((p) => p.message);
    expect(commands.join('\n')).not.toContain('hub-reader');
    expect(commands.join('\n')).not.toContain('contract.pdf');
    expect(commands.join('\n')).not.toContain('alice@hub');
  });

  it('refuses an unknown token with 401 (and the console drops its cached token)', async () => {
    const { app, consoleWith } = await setup();
    let resets = 0;
    const reply = await consoleWith('stolen-or-made-up', () => {
      resets += 1;
    }).send(command('disks'));
    expect(reply).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE, status: 401 } });
    expect(resets).toBe(1);
    expect(app.seen).toHaveLength(0);
  });

  it('lets the token decide the app and the capabilities, whatever the message claims', async () => {
    const { app, consoleWith } = await setup();
    // A token for another app cannot read or act on this one.
    const other = await consoleWith('hub-other-app').send(command('objects', 'fs'));
    expect(other).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!other.ok && other.error.message).toMatch(/token is for "billing"/);
    // A read-only token cannot act, even when the message claims every capability.
    const reader = await consoleWith('hub-reader').send({
      ...command('remove', { disk: 'fs', keys: ['private/contract.pdf'] }),
      capabilities: ['*'],
    });
    expect(reader).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!reader.ok && reader.error.message).toMatch(
      /the console's token lacks media:objects:write/,
    );
    expect(app.files.has('private/contract.pdf')).toBe(true);
    // A token without media:objects:read cannot list or sign, and no `capabilities` in the
    // message never means "everything".
    const nothing = await consoleWith('hub-nothing').send(
      command('objectUrls', [{ disk: 'fs', key: 'private/contract.pdf' }]),
    );
    expect(nothing).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!nothing.ok && nothing.error.message).toMatch(
      /the console's token lacks media:objects:read/,
    );
    // The viewer's capabilities only narrow the token's.
    const narrowed = await consoleWith('hub-admin').send({
      ...command('remove', { disk: 'fs', keys: ['private/contract.pdf'] }),
      capabilities: ['media:objects:read'],
    });
    expect(narrowed).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!narrowed.ok && narrowed.error.message).toBe('the viewer lacks media:objects:write');
    expect(app.files.has('private/contract.pdf')).toBe(true);
    // A token with both runs an action, and the log names the token's client.
    const acted = await consoleWith('hub-admin').send(
      command('remove', { disk: 'fs', keys: ['private/contract.pdf'] }),
    );
    expect(acted).toMatchObject({ ok: true });
    expect(app.files.has('private/contract.pdf')).toBe(false);
    expect(app.log.at(-1)).toMatch(/by alice@hub \(console token hub\)/);
  });

  it("keeps the app's own actions switch: a full token cannot act with actions off", async () => {
    const { consoleWith } = await setup({ actions: false });
    const reply = await consoleWith('hub-admin').send(
      command('remove', { disk: 'fs', keys: ['private/contract.pdf'] }),
    );
    expect(reply).toMatchObject({ ok: false, error: { status: 403 } });
    expect(!reply.ok && reply.error.message).toMatch(/consoleCommands.actions is off/);
  });

  it('refuses unsealed, tampered, replayed and wrongly sealed commands', async () => {
    const { bus, app, consoleWith } = await setup();
    const raw = bus.connection();
    // A plain command claiming a verified token and every capability.
    await raw.publish(
      COMMANDS,
      JSON.stringify({
        ...command('objects', 'fs'),
        capabilities: ['*'],
        verified: { partition: 'shop', capabilities: ['*'] },
      }),
    );
    await settle();
    expect(app.seen).toHaveLength(0);
    expect(app.errors[0]).toMatchObject({ code: UNSIGNED_CHANNEL });

    await consoleWith('hub-admin').send(command('disks'));
    const sent = bus.published.find((p) => p.channel === COMMANDS && p.message.includes('sealed'))!;
    const wire = JSON.parse(sent.message) as { id: string; sealed: string };
    const flipped = wire.sealed.slice(0, -2) + (wire.sealed.endsWith('A') ? 'BB' : 'AA');
    // Its ciphertext under another id (the AAD binds the id), a bit-flipped copy, a replay.
    await raw.publish(COMMANDS, JSON.stringify({ id: randomUUID(), sealed: wire.sealed }));
    await raw.publish(COMMANDS, JSON.stringify({ ...wire, sealed: flipped }));
    await raw.publish(COMMANDS, sent.message);
    await settle();
    expect(app.seen).toHaveLength(1);

    // Sealed to someone else's key (a console given the wrong publicKey): not this app's.
    const wrongKey = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      token: 'hub-admin',
      recipient: consoleCommandKeys('another-app-key-0123456789', PREFIX).publicKey,
    });
    await expect(wrongKey.send(command('disks'), { timeoutMs: 100 })).rejects.toThrow(
      /no instance of "shop" answered within 0\.1s/,
    );
    expect(app.seen).toHaveLength(1);
  });

  it('ignores a forged answer and waits for the app', async () => {
    const { bus, consoleWith } = await setup();
    const raw = bus.connection();
    await raw.subscribe(COMMANDS, (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(REPLIES, JSON.stringify({ id, ok: true, data: ['https://evil.example/'] }));
    });
    const reply = await consoleWith('hub-reader').send(
      command('objectUrls', [{ disk: 'fs', key: 'private/contract.pdf' }]),
    );
    expect(reply.ok && reply.data).toEqual(['https://bucket.invalid/private/contract.pdf?sig=1']);
  });

  it('the console refuses a token without the app key, and a key that is not one', async () => {
    const bus = new RedisBus();
    expect(
      () =>
        new RedisConsoleChannel({ client: bus.connection(), prefix: PREFIX, token: 'hub-admin' }),
    ).toThrow(/needs `crypto` or the app's `publicKey`/);
    const bad = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      token: 'hub-admin',
      recipient: 'not-a-key',
    });
    await expect(bad.send(command('disks'), { timeoutMs: 100 })).rejects.toThrow(
      /media:console-key/,
    );
    expect(bus.published).toHaveLength(0);
  });

  it('through the provider: derives the key from APP_KEY, logs it, and checks tokens', async () => {
    const bus = new RedisBus();
    const lines: string[] = [];
    const store = new InMemoryMediaStore();
    const config: Record<string, unknown> = {
      media: {
        disk: 'fs',
        consoleCommands: { prefix: PREFIX, verifyTenant, partition: 'shop' },
      },
      app: { appKey: APP_KEY },
    };
    const get = (key: string, def: unknown) =>
      key === 'app.appKey' ? APP_KEY : (config[key] ?? def);
    const provider = new MediaProvider({
      config: { get },
      getEnvironment: () => 'web',
      container: {
        make: async (token: unknown) => {
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
      },
    } as never);
    await provider.ready();
    // A short id only, in token mode: `node ace media:console-key` prints the key.
    expect(lines.join('\n')).toContain(`sealed to key ${keys.kid.slice(0, 8)})`);
    expect(lines.join('\n')).not.toContain(keys.publicKey);
    const console = (token: string) =>
      new RedisConsoleChannel({
        client: bus.connection(),
        prefix: PREFIX,
        token,
        recipient: keys.publicKey,
      });
    expect(await console('hub-reader').send(command('disks'))).toMatchObject({ ok: true });
    expect(await console('hub-other-app').send(command('disks'))).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    await provider.shutdown();
  });
});

/**
 * A stand-in for an @adonis-agora/crypto server (in the Hub or its own app): keys live here, and
 * each caller gets a cipher limited to what its token may do on them.
 */
class FakeCryptoServer {
  readonly keys = new Map<string, Buffer>([['console-media', randomBytes(32)]]);
  readonly audit: Array<{ op: string; key: string; context?: string | undefined }> = [];

  cipherFor(allowed: { encrypt?: string[]; decrypt?: string[] }): ConsoleCipher {
    return {
      encrypt: async ({ key, plaintext, aad, context }) => {
        if (!allowed.encrypt?.includes(key)) throw new Error(`no crypto:encrypt:${key}`);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.keys.get(key)!, iv);
        cipher.setAAD(Buffer.from(aad ?? ''));
        const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        this.audit.push({ op: 'encrypt', key, context });
        return {
          ciphertext: `agora:ct1:${key}:1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`,
        };
      },
      decrypt: async ({ key, ciphertext, aad, context }) => {
        if (!allowed.decrypt?.includes(key)) throw new Error(`no crypto:decrypt:${key}`);
        const raw = Buffer.from(ciphertext.split(':').pop()!, 'base64url');
        const decipher = createDecipheriv('aes-256-gcm', this.keys.get(key)!, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(aad ?? ''));
        decipher.setAuthTag(raw.subarray(12, 28));
        const plaintext = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
        this.audit.push({ op: 'decrypt', key, context });
        return { plaintext: plaintext.toString('utf8') };
      },
    };
  }
}

describe('federated media console: sealed with @adonis-agora/crypto', () => {
  const setup = async (options: { verify?: boolean } = {}) => {
    const bus = new RedisBus();
    const server = new FakeCryptoServer();
    // The app may only decrypt with the key (its crypto token: crypto:decrypt:console-media).
    const app = await answeringApp(bus, {
      crypto: { cipher: server.cipherFor({ decrypt: ['console-media'] }) },
      ...(options.verify ? { verifyTenant, partition: 'shop' } : {}),
    });
    let resolved = 0;
    // The console may only encrypt with it (in the Hub: serviceCipher(crypto.service, 'shop')).
    const console = (token?: string) =>
      new RedisConsoleChannel({
        client: bus.connection(),
        prefix: PREFIX,
        crypto: {
          // Lazy, like `() => crypto.client!` in config/media_dashboard.ts.
          cipher: () => {
            resolved += 1;
            return server.cipherFor({ encrypt: ['console-media'] });
          },
        },
        ...(token !== undefined ? { token } : {}),
      });
    return { bus, server, app, console, resolvedCount: () => resolved };
  };

  it('runs a command the console encrypted and the app decrypted, nothing readable on Redis', async () => {
    const { bus, server, app, console, resolvedCount } = await setup();
    const channel = console();
    expect(resolvedCount()).toBe(0);
    const reply = await channel.send(
      command('objectUrls', [{ disk: 'fs', key: 'private/contract.pdf' }]),
    );
    expect(reply).toMatchObject({ ok: true, data: [expect.stringContaining('contract.pdf')] });
    expect(resolvedCount()).toBe(1);
    expect(app.seen[0]).toMatchObject({ verb: 'objectUrls', actor: 'alice@hub' });
    expect(app.seen[0]?.verified).toBeUndefined();
    const commands = bus.published.filter((p) => p.channel === COMMANDS).map((p) => p.message);
    expect(commands.join('\n')).not.toContain('contract.pdf');
    expect(commands.join('\n')).not.toContain('alice@hub');
    // Crypto audits both sides, with the command's channel and id as context.
    expect(server.audit.map((row) => row.op)).toEqual(['encrypt', 'decrypt']);
    expect(server.audit[0]?.context).toContain('agora:console-command');
  });

  it('refuses commands from someone who cannot encrypt with the key', async () => {
    const { bus, server, app } = await setup();
    const raw = bus.connection();
    server.keys.set('mine', randomBytes(32));
    const theirs = server.cipherFor({ encrypt: ['mine'] });
    const { ciphertext } = await theirs.encrypt({ key: 'mine', plaintext: '{}', aad: 'x' });
    await raw.publish(COMMANDS, JSON.stringify({ id: randomUUID(), sealed: ciphertext }));
    await raw.publish(
      COMMANDS,
      JSON.stringify({
        id: randomUUID(),
        sealed: `agora:ct1:console-media:1:${randomBytes(64).toString('base64url')}`,
      }),
    );
    await raw.publish(
      COMMANDS,
      JSON.stringify({ ...command('objects', 'fs'), capabilities: ['*'] }),
    );
    await settle();
    expect(app.seen).toHaveLength(0);
    expect(app.errors).toHaveLength(3);
    for (const error of app.errors) expect(error).toMatchObject({ code: UNSIGNED_CHANNEL });
  });

  it('with verifyTenant on the app, the command must also carry a valid token', async () => {
    const { app, console } = await setup({ verify: true });
    const without = await console().send(command('disks'));
    expect(without).toMatchObject({ ok: false, error: { code: UNAUTHORIZED_CONSOLE } });
    const withToken = await console('hub-reader').send(command('disks'));
    expect(withToken).toMatchObject({ ok: true });
    expect(app.seen.at(-1)?.verified).toMatchObject({ partition: 'shop', clientId: 'hub-ro' });
    const reader = await console('hub-reader').send(command('remove', { disk: 'fs', keys: ['x'] }));
    expect(reader).toMatchObject({ ok: false, error: { status: 403 } });
  });

  it('ignores a forged answer', async () => {
    const { bus, console } = await setup();
    const raw = bus.connection();
    await raw.subscribe(COMMANDS, (message) => {
      const { id } = JSON.parse(message) as { id: string };
      void raw.publish(REPLIES, JSON.stringify({ id, ok: true, data: 'forged' }));
    });
    const reply = await console().send(command('disks'));
    expect(reply.ok && reply.data).not.toBe('forged');
  });

  it('says so when crypto is not ready yet', async () => {
    const bus = new RedisBus();
    const channel = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      crypto: { cipher: () => undefined as never },
    });
    await expect(channel.send(command('disks'), { timeoutMs: 100 })).rejects.toThrow(
      /crypto\.cipher.*not ready/,
    );
  });

  it('an app accepts every configured mode at once (while consoles move over)', async () => {
    const bus = new RedisBus();
    const server = new FakeCryptoServer();
    const app = await answeringApp(bus, {
      secret: SECRET,
      crypto: { cipher: server.cipherFor({ decrypt: ['console-media'] }) },
    });
    const old = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
    });
    const next = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      crypto: { cipher: server.cipherFor({ encrypt: ['console-media'] }) },
    });
    expect(await old.send(command('disks'))).toMatchObject({ ok: true });
    expect(await next.send(command('disks'))).toMatchObject({ ok: true });
    expect(app.seen).toHaveLength(2);
  });
});

describe('mediaConsoleCommandHandler', () => {
  const handler = (partition?: string) =>
    mediaConsoleCommandHandler({
      service: ownStorage().service,
      actions: true,
      ...(partition !== undefined ? { partition } : {}),
    });

  it('refuses a verified token when the app names no partition (never "any app")', async () => {
    await expect(
      handler()({
        ...command('disks'),
        verified: { partition: 'shop', capabilities: ['media:*'] },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("narrows to the viewer's capabilities in the other modes too", async () => {
    const run = handler('shop');
    await expect(
      run({
        ...command('remove', { disk: 'fs', keys: ['x'] }),
        capabilities: ['media:objects:read'],
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(run({ ...command('disks'), capabilities: [] })).rejects.toMatchObject({
      status: 403,
    });
    // Wildcards count, as everywhere in Agora.
    await expect(run({ ...command('disks'), capabilities: ['media:*'] })).resolves.toBeDefined();
    // The shared console names: media:console:read / write, and media:console:*.
    await expect(
      run({ ...command('disks'), capabilities: ['media:console:read'] }),
    ).resolves.toBeDefined();
    await expect(
      run({ ...command('remove', { disk: 'fs', keys: ['x'] }), capabilities: ['media:console:*'] }),
    ).resolves.toBeUndefined();
  });

  it('checks in order: capabilities, token, viewer, partition, then actions', async () => {
    const off = mediaConsoleCommandHandler({
      service: ownStorage().service,
      actions: false,
      partition: 'shop',
    });
    const remove = command('remove', { disk: 'fs', keys: ['x'] });
    const otherApp = { partition: 'billing', capabilities: ['media:objects:read'] };
    // The token lacks write: that comes before the partition and the actions switch.
    await expect(off({ ...remove, verified: otherApp })).rejects.toThrow(
      "the console's token lacks media:objects:write",
    );
    // The viewer lacks write: before the partition and the actions switch too.
    await expect(
      off({
        ...remove,
        capabilities: ['media:objects:read'],
        verified: { ...otherApp, capabilities: ['media:*'] },
      }),
    ).rejects.toThrow('the viewer lacks media:objects:write');
    // Token and viewer fine, another partition: the partition, before the actions switch.
    await expect(
      off({ ...remove, verified: { ...otherApp, capabilities: ['media:*'] } }),
    ).rejects.toThrow(/token is for "billing"/);
    // Everything else fine: the actions switch is last.
    await expect(
      off({ ...remove, verified: { partition: 'shop', capabilities: ['media:*'] } }),
    ).rejects.toThrow(/consoleCommands.actions is off/);
    // And a look-alike grant never widens.
    await expect(
      off({ ...command('disks'), verified: { partition: 'shop', capabilities: ['media:*:read'] } }),
    ).rejects.toThrow("the console's token lacks media:objects:read");
  });

  it('refuses a command without capabilities (never "missing = everything"), reads included', async () => {
    const run = handler('shop');
    const { capabilities: _all, ...bare } = command('disks');
    await expect(run(bare)).rejects.toMatchObject({
      status: 403,
      code: 'capabilities-required',
      message: expect.stringMatching(/without the viewer capabilities/),
    });
    // Even with a token that grants everything.
    await expect(
      run({ ...bare, verified: { partition: 'shop', capabilities: ['*'] } }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('an authkit app-call token is bound by its audience: its partition is the console app', async () => {
    const run = handler('shop');
    await expect(
      run({
        ...command('disks'),
        verified: { partition: 'hub', capabilities: ['media:console:*'], appCall: true },
      }),
    ).resolves.toBeDefined();
    // Still capped by what authkit granted the console app here.
    await expect(
      run({
        ...command('remove', { disk: 'fs', keys: ['x'] }),
        verified: { partition: 'hub', capabilities: ['media:console:read'], appCall: true },
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('§11b: refusal reasons', () => {
  it('stale, bad signature, replayed, token refused and capabilities-required, each named', async () => {
    const reasons: string[] = [];
    const bus = new RedisBus();
    const keys = consoleCommandKeys(APP_KEY, PREFIX);
    const channel = new RedisConsoleChannel({
      client: bus.connection(),
      prefix: PREFIX,
      secret: SECRET,
      keys,
      verifyTenant,
      partition: 'shop',
    });
    await channel.answer(
      mediaConsoleCommandHandler({
        service: ownStorage().service,
        actions: true,
        partition: 'shop',
      }),
      { onError: (error) => reasons.push((error as { reason?: string }).reason ?? String(error)) },
    );
    const raw = bus.connection();
    const signed = new RedisConsoleChannel({ client: raw, prefix: PREFIX, secret: SECRET });
    // A genuine command, then its replay.
    await signed.send(command('disks'));
    const wire = bus.published.find((p) => p.channel === COMMANDS && p.message.includes('"mac"'))!;
    await raw.publish(COMMANDS, wire.message);
    // Tampered, and stale (a valid MAC from over a minute ago).
    await raw.publish(
      COMMANDS,
      JSON.stringify({ ...JSON.parse(wire.message), id: randomUUID(), verb: 'remove' }),
    );
    await raw.publish(
      COMMANDS,
      JSON.stringify({ ...JSON.parse(wire.message), id: randomUUID(), ts: Date.now() - 120_000 }),
    );
    // A refused token, and a command without capabilities.
    await new RedisConsoleChannel({
      client: raw,
      prefix: PREFIX,
      token: 'nope',
      recipient: keys.publicKey,
    })
      .send(command('disks'))
      .catch(() => undefined);
    const { capabilities: _c, ...bare } = command('disks');
    await signed.send(bare);
    await settle();
    expect(reasons).toEqual(
      expect.arrayContaining([
        'replayed',
        'bad signature',
        'stale',
        'token refused',
        'capabilities-required',
      ]),
    );
  });
});
