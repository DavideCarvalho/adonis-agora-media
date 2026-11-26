import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  resolveTenantToken,
  resolveTenantVerifier,
  type TenantTokenSource,
  type TenantVerifierInput,
  type VerifiedTenant,
} from '../topology/auth.js';

/**
 * The Redis channel the federated console talks to another app over: the console publishes a
 * command on `<prefix>-media-console`, every instance of the owning app hears it, the one that wins
 * `SET <prefix>-media-console-claim:<id> NX PX` runs it, and the answer comes back on
 * `<prefix>-media-console-reply`. Same design as `@adonis-agora/config`'s and
 * `@adonis-agora/durable`'s console commands, on channels of its own (`-media-`), so all of them
 * can share an app's prefix.
 *
 * Redis is not a trust boundary: every command (reads included: listing a disk and signing URLs
 * expose the app's storage) is authenticated, and so is every answer. See {@link RedisConsoleChannel}.
 */

/** This package's part of the channel names. */
export const CONSOLE_TOPIC = 'media';
const PACKAGE = `@adonis-agora/${CONSOLE_TOPIC}`;

/** One command sent to the owning app. Arguments and answer are plain JSON. */
export interface MediaConsoleCommand {
  id: string;
  verb: string;
  args: unknown[];
  /** Who acted in the console, for the owning app's log. Said by the console, not verified. */
  actor?: string;
  /**
   * The capabilities the console's viewer holds, when the console says. They can only narrow what
   * the command may do (never widen what the console's token or the app's switches allow).
   */
  capabilities?: string[];
  /** When it was sent (ms since the epoch): a command older than a minute is refused. */
  ts?: number;
  /** HMAC of every field above under the pair's shared secret (set by {@link RedisConsoleChannel}). */
  mac?: string;
  /**
   * Token mode: who the owning app verified the console as (its token's partition and
   * capabilities). Set by the channel after verification, never taken from the wire.
   */
  verified?: Pick<VerifiedTenant, 'partition' | 'capabilities' | 'clientId'> & {
    /**
     * An authkit app-call token (audience `urn:agora:app:<this app>`): `partition` is the CALLING
     * app (the console's), not this one, so the partition rule does not apply.
     */
    appCall?: boolean;
  };
}

/**
 * Verifies an authkit app-call token (audience `urn:agora:app:<this app>`): the calling app and
 * what it was granted here, or `null`. `@adonis-agora/authkit-client`'s
 * `appCallerVerifier().verifyToken` is one.
 */
export type AppCallVerifier = (
  token: string,
) => Promise<{ app: string; capabilities: string[]; clientId?: string } | null>;

/** The owning app's answer to a {@link MediaConsoleCommand}. */
export type MediaConsoleReply = (
  | { id: string; ok: true; data: unknown }
  | { id: string; ok: false; error: { message: string; code?: string; status?: number } }
) & { mac?: string };

/** How far a command's `ts` may be from this clock (and so how long a replay could live). */
const MAX_COMMAND_SKEW_MS = 60_000;

/** A shared secret: a string, or a Secret-like object (`env.get('X')` in AdonisJS). */
export type ChannelSecret = string | { release(): string };

/** JSON with object keys sorted, so both sides MAC the same bytes for the same fields. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

function sameMac(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fresh(ts: unknown): boolean {
  return typeof ts === 'number' && Math.abs(Date.now() - ts) <= MAX_COMMAND_SKEW_MS;
}

function replyFields(reply: MediaConsoleReply): unknown[] {
  return [reply.id, reply.ok, reply.ok ? (reply.data ?? null) : reply.error];
}

/**
 * Signs and checks the messages of one channel. Anyone who can publish on the Redis channel can
 * otherwise send a command (with any actor) or answer one (a forged `objectUrls` answer would send
 * the console's viewers to the attacker's URLs): both sides share `secret`, and every command and
 * reply carries an HMAC over its fields, bound to this channel's prefix.
 */
class ChannelSigner {
  readonly #key: Buffer;
  constructor(secret: ChannelSecret, prefix: string) {
    const raw = typeof secret === 'string' ? secret : secret?.release?.();
    if (typeof raw !== 'string' || raw.length < 16) {
      throw new Error(
        `[${PACKAGE}] console channel: the shared secret must be at least 16 characters`,
      );
    }
    this.#key = createHmac('sha256', raw)
      .update(`agora:console-commands:${CONSOLE_TOPIC}:${prefix}`)
      .digest();
  }

  #mac(kind: 'command' | 'reply', fields: unknown): string {
    return createHmac('sha256', this.#key)
      .update(`${kind}\n${canonicalJson(fields)}`)
      .digest('base64url');
  }

  #commandFields(command: MediaConsoleCommand): unknown[] {
    return [
      command.id,
      command.verb,
      command.args ?? [],
      command.actor ?? null,
      command.capabilities ?? null,
      command.ts ?? null,
    ];
  }

  signCommand(command: MediaConsoleCommand): MediaConsoleCommand {
    const { mac: _mac, verified: _verified, ...rest } = command;
    const stamped = { ...rest, ts: Date.now() };
    return { ...stamped, mac: this.#mac('command', this.#commandFields(stamped)) };
  }

  verifyCommand(command: MediaConsoleCommand): boolean {
    if (!fresh(command.ts)) return false;
    return sameMac(this.#mac('command', this.#commandFields(command)), command.mac);
  }

  signReply(reply: MediaConsoleReply): MediaConsoleReply {
    const { mac: _mac, ...rest } = reply;
    return {
      ...rest,
      mac: this.#mac('reply', replyFields(rest as MediaConsoleReply)),
    } as MediaConsoleReply;
  }

  verifyReply(reply: MediaConsoleReply): boolean {
    return sameMac(this.#mac('reply', replyFields(reply)), reply.mac);
  }
}

/** The owning app refused the console's token (the console drops its cached token). */
export const UNAUTHORIZED_CONSOLE = 'federated-console-unauthorized';

/** What one sent command needs from the channel's authentication. */
interface OutgoingMessage {
  wire: unknown;
  verifyReply(reply: MediaConsoleReply): boolean;
}

/** A command that arrived, once its authentication is checked. */
interface IncomingMessage {
  /** The command to run, or `undefined` when it must be refused with `error`. */
  command?: MediaConsoleCommand;
  error?: { message: string; code: string; status: number };
  id: string;
  signReply(reply: MediaConsoleReply): MediaConsoleReply;
}

interface ChannelAuth {
  wrap?(command: MediaConsoleCommand): Promise<OutgoingMessage>;
  unwrap?(wire: Record<string, unknown>): Promise<IncomingMessage | null>;
  unauthorized?(): void;
  /** The app did not take a command (no answer in time, or `mode not accepted here`). */
  failed?(): void;
}

/** How long a failed app-call token, or an automatic per-app choice, is kept before trying again. */
export const CONSOLE_RETRY_MS = 5 * 60_000;

/** Console side, automatic: which way to reach one app (§13a), decided lazily and cached. */
export interface ConsoleModeChooser {
  choose(): Promise<'token' | 'crypto'>;
  /** Forget the decision: the next command decides again. */
  reset(): void;
  /**
   * Keep `way` as the decision for the next 5 minutes (the token way could not mint its token:
   * crypto, without a failing mint per command, §13a/§13b).
   */
  settle(way: 'token' | 'crypto'): void;
}

/** Shared-secret mode: both sides hold the same secret and HMAC every command and reply. */
class SecretAuth implements ChannelAuth {
  readonly #signer: ChannelSigner;
  constructor(secret: ChannelSecret, prefix: string) {
    this.#signer = new ChannelSigner(secret, prefix);
  }

  async wrap(command: MediaConsoleCommand): Promise<OutgoingMessage> {
    return {
      wire: this.#signer.signCommand(command),
      verifyReply: (reply) => this.#signer.verifyReply(reply),
    };
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingMessage | null> {
    if (typeof wire.mac !== 'string') return null;
    const command = wire as unknown as MediaConsoleCommand;
    if (typeof command.id !== 'string' || typeof command.verb !== 'string') return null;
    // Stale (over a minute) or tampered: not from the console that holds the secret. A replay
    // inside the window reuses the id, and the claim (kept 2 minutes) refuses it.
    if (!fresh(command.ts)) throw new ConsoleCommandRefused('stale');
    if (!this.#signer.verifyCommand(command)) throw new ConsoleCommandRefused('bad signature');
    const { mac: _mac, ts: _ts, verified: _verified, ...fields } = command;
    return {
      id: command.id,
      command: fields,
      signReply: (reply) => this.#signer.signReply(reply),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// The app's command key (token mode without crypto): an X25519 key pair derived from its APP_KEY.
// ---------------------------------------------------------------------------------------------

/** An app's console-command key pair. The public half is what the console seals commands to. */
export interface ConsoleCommandKeys {
  /** The public key (base64url, 32 bytes): `controlPlane.publicKey` on the console. */
  publicKey: string;
  /** A short id of the public key, carried in each sealed command. */
  kid: string;
  /** @internal The private half. Never leaves this app. */
  privateKey: KeyObject;
}

const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex');
const SEALED_PREFIX = 'agora:pk1:';

function kidOf(publicKey: string): string {
  return createHash('sha256').update(publicKey).digest('base64url').slice(0, 16);
}

/** The 8-character id every Agora lib's boot log shows for a command key (never the key). */
export function shortKeyId(publicKey: string): string {
  return kidOf(publicKey).slice(0, 8);
}

/** Whether `value` reads as an X25519 public key (base64url of 32 bytes). */
export function isConsolePublicKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').length === 32
  );
}

/**
 * This app's console-command key pair, derived from its `APP_KEY` and the channel's `prefix`: the
 * same `APP_KEY` always gives the same key, so every instance opens what the console sealed. Print
 * the public half with `node ace media:console-key`.
 */
export function consoleCommandKeys(appKey: ChannelSecret, prefix: string): ConsoleCommandKeys {
  const raw = typeof appKey === 'string' ? appKey : appKey?.release?.();
  if (typeof raw !== 'string' || raw.length < 16) {
    throw new Error(
      `[${PACKAGE}] console channel: the command key needs an APP_KEY (16+ characters)`,
    );
  }
  const seed = Buffer.from(
    hkdfSync(
      'sha256',
      raw,
      Buffer.from(`${CONSOLE_TOPIC}:console-commands:${prefix}`, 'utf8'),
      Buffer.from('agora:okp:v1:x25519', 'utf8'),
      32,
    ),
  );
  const privateKey = createPrivateKey({
    key: Buffer.concat([X25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  seed.fill(0);
  const publicKey = (createPublicKey(privateKey).export({ format: 'jwk' }) as { x: string }).x;
  return { publicKey, kid: kidOf(publicKey), privateKey };
}

/** A string, or a Secret-like (`.release()`), as a non-empty string; else `undefined`. */
function released(value: unknown): string | undefined {
  if (typeof value === 'string') return value !== '' ? value : undefined;
  if (value === null || typeof value !== 'object') return undefined;
  const release = (value as { release?: unknown }).release;
  if (typeof release !== 'function') return undefined;
  try {
    const raw = (value as { release(): unknown }).release();
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
  } catch {
    return undefined;
  }
}

interface AppLike {
  config?: { get?(key: string, fallback?: unknown): unknown };
}

/** A config value that may be an AdonisJS config provider (`{ resolver(app) }`), resolved. */
async function resolvedConfig(value: unknown, app: unknown): Promise<unknown> {
  if (value === null || typeof value !== 'object') return value;
  const resolver = (value as { resolver?: unknown }).resolver;
  if (typeof resolver !== 'function') return value;
  try {
    return await (resolver as (app: unknown) => unknown).call(value, app);
  } catch {
    return undefined;
  }
}

/** The first usable key of an encryption config entry, whatever its shape (`keys[...]`, `key`). */
function keyOfEntry(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== 'object') return undefined;
  const { keys, key } = entry as { keys?: unknown; key?: unknown };
  if (Array.isArray(keys)) {
    for (const candidate of keys) {
      const value = released(candidate);
      if (value) return value;
    }
    return undefined;
  }
  return released(key);
}

/**
 * The key of `config/encryption.ts` (AdonisJS 7): the first key of its default entry
 * (`list[default]`, else the first entry), resolving the lazy config providers `defineConfig` and
 * `drivers.*` return. A flat `{ keys }` / `{ key }` config is read as is.
 */
async function encryptionKeyOf(app: unknown): Promise<string | undefined> {
  let raw: unknown;
  try {
    raw = (app as AppLike)?.config?.get?.('encryption');
  } catch {
    return undefined;
  }
  const config = await resolvedConfig(raw, app);
  if (config === null || typeof config !== 'object') return undefined;
  const { list, default: name } = config as { list?: unknown; default?: unknown };
  if (list !== null && typeof list === 'object') {
    const entries = list as Record<string, unknown>;
    const chosen =
      typeof name === 'string' && Object.hasOwn(entries, name) ? name : Object.keys(entries)[0];
    return chosen === undefined
      ? undefined
      : keyOfEntry(await resolvedConfig(entries[chosen], app));
  }
  return keyOfEntry(config);
}

/**
 * The app's `APP_KEY`, the same way in every Agora lib (§13c): `config/app.ts`'s `appKey`, else the
 * default entry of `config/encryption.ts` (AdonisJS 7, lazy providers resolved), else the
 * `APP_KEY` environment variable. A `Secret` (`.release()`) or a string; a source that throws counts
 * as "no key here"; never logged.
 */
export async function appKeyOf(app: unknown): Promise<string | undefined> {
  let fromApp: unknown;
  try {
    fromApp = (app as AppLike)?.config?.get?.('app.appKey');
  } catch {
    fromApp = undefined;
  }
  const appKey = released(fromApp);
  if (appKey) return appKey;
  const fromEncryption = await encryptionKeyOf(app);
  if (fromEncryption) return fromEncryption;
  return released(process.env.APP_KEY);
}

function x25519Public(x: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' });
}

function contentKey(shared: Buffer, kid: string, ephemeralX: string, recipientX: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      shared,
      Buffer.from(`${ephemeralX}.${recipientX}`, 'utf8'),
      Buffer.from(`agora:${CONSOLE_TOPIC}-console:pk1:${kid}`, 'utf8'),
      32,
    ),
  );
}

/** Seals `plaintext` to the X25519 public key `recipient` (ECDH with a one-off key, AES-256-GCM). */
function sealTo(recipient: string, plaintext: string, aad: string): string {
  if (!isConsolePublicKey(recipient)) {
    throw new Error(
      `[${PACKAGE}] console channel: \`publicKey\` is not a console-command key (print the app's with node ace media:console-key)`,
    );
  }
  const kid = kidOf(recipient);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralX = (ephemeral.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const shared = diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: x25519Public(recipient),
  });
  const key = contentKey(shared, kid, ephemeralX, recipient);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(`${kid}\n${aad}`, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const parts = [kid, ephemeralX, iv, cipher.getAuthTag(), body].map((part) =>
    typeof part === 'string' ? part : part.toString('base64url'),
  );
  return `${SEALED_PREFIX}${parts.join(':')}`;
}

/** Opens a {@link sealTo} value with this app's key pair; throws when it does not open. */
function openWith(keys: ConsoleCommandKeys, sealed: string, aad: string): string {
  const [kid, ephemeralX, ivPart, tagPart, bodyPart, ...extra] = sealed
    .slice(SEALED_PREFIX.length)
    .split(':');
  if (kid !== keys.kid || extra.length > 0 || !isConsolePublicKey(ephemeralX)) {
    throw new Error('not sealed to this key');
  }
  const iv = Buffer.from(ivPart ?? '', 'base64url');
  const tag = Buffer.from(tagPart ?? '', 'base64url');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('malformed');
  const shared = diffieHellman({
    privateKey: keys.privateKey,
    publicKey: x25519Public(ephemeralX),
  });
  const decipher = createDecipheriv(
    'aes-256-gcm',
    contentKey(shared, kid, ephemeralX, keys.publicKey),
    iv,
    { authTagLength: 16 },
  );
  decipher.setAAD(Buffer.from(`${kid}\n${aad}`, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(bodyPart ?? '', 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * How a sealed command is encrypted: to the app's command key derived from its `APP_KEY`, or with a
 * key of `@adonis-agora/crypto` (the Hub's, or the app's own). Either way only the owning app
 * opens it, and the AAD binds it to this channel and this command id.
 */
export interface ConsoleSealer {
  /** Whether `sealed` is this sealer's ciphertext (so the app knows which one opens it). */
  owns(sealed: string): boolean;
  seal(plaintext: string, aad: string): Promise<string>;
  open(sealed: string, aad: string): Promise<string>;
}

/** The `encrypt`/`decrypt` pair `@adonis-agora/crypto` exposes (`crypto.client`, `serviceCipher`). */
export interface ConsoleCipher {
  encrypt(input: {
    key: string;
    plaintext: string;
    aad?: string;
    context?: string;
  }): Promise<{ ciphertext: string }>;
  decrypt(input: {
    key: string;
    ciphertext: string;
    aad?: string;
    context?: string;
  }): Promise<{ plaintext: string }>;
}

/**
 * A cipher, or a function returning one: `config/media.ts` is read before `@adonis-agora/crypto`
 * is ready, so `() => crypto.client!` (or `() => serviceCipher(crypto.service, 'app')`) defers it
 * to the first command.
 */
export type ConsoleCipherSource = ConsoleCipher | (() => ConsoleCipher | Promise<ConsoleCipher>);

/** The `@adonis-agora/crypto` key console commands are sealed with, unless another is named. */
export const CONSOLE_CRYPTO_KEY = 'console-media';

/** Seals with an `@adonis-agora/crypto` key: whoever may `encrypt` with it sends, the app opens. */
export function cryptoConsoleSealer(options: {
  cipher: ConsoleCipherSource;
  key?: string | undefined;
  owns?: ((ciphertext: string) => boolean) | undefined;
}): ConsoleSealer {
  const key = options.key ?? CONSOLE_CRYPTO_KEY;
  const source = options.cipher;
  const cipher = async (): Promise<ConsoleCipher> => {
    const resolved = typeof source === 'function' ? await source() : source;
    if (
      !resolved ||
      typeof resolved.encrypt !== 'function' ||
      typeof resolved.decrypt !== 'function'
    ) {
      throw new Error(
        `[${PACKAGE}] console channel: \`crypto.cipher\` is not ready (is @adonis-agora/crypto booted?)`,
      );
    }
    return resolved;
  };
  return {
    // `agora:ct1:<key>:<version>:…`: only this key's ciphertext is taken as a crypto command.
    // A cipher of your own (a KMS, Vault transit) says which ciphertext is its own.
    owns: options.owns ?? ((sealed) => sealed.startsWith(`agora:ct1:${key}:`)),
    async seal(plaintext, aad) {
      const { ciphertext } = await (await cipher()).encrypt({ key, plaintext, aad, context: aad });
      return ciphertext;
    },
    async open(sealed, aad) {
      const { plaintext } = await (await cipher()).decrypt({
        key,
        ciphertext: sealed,
        aad,
        context: aad,
      });
      return plaintext;
    },
  };
}

/** The app's command public key: the string itself, or a function returning it. */
export type ConsolePublicKeySource = string | (() => string | Promise<string>);

/** Seals to the app's X25519 command key: the console side (the key from the console's config). */
export function appKeySealerTo(recipient: ConsolePublicKeySource): ConsoleSealer {
  return {
    owns: (sealed) => sealed.startsWith(SEALED_PREFIX),
    seal: async (plaintext, aad) =>
      sealTo(typeof recipient === 'function' ? await recipient() : recipient, plaintext, aad),
    open: async () => {
      throw new Error('the console side cannot open commands');
    },
  };
}

/** Opens with the app's X25519 command key pair (derived from its `APP_KEY`): the app side. */
export function appKeySealer(keys: ConsoleCommandKeys): ConsoleSealer {
  return {
    owns: (sealed) => sealed.startsWith(`${SEALED_PREFIX}${keys.kid}:`),
    seal: async (plaintext, aad) => sealTo(keys.publicKey, plaintext, aad),
    open: async (sealed, aad) => openWith(keys, sealed, aad),
  };
}

/** The key that MACs the replies to one command: a secret only the console and the app know. */
function replyKey(secret: string, prefix: string, id: string): Buffer {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`agora:console-reply:${CONSOLE_TOPIC}:${prefix}:${id}`)
    .digest();
}

function replyMac(key: Buffer, reply: MediaConsoleReply): string {
  return createHmac('sha256', key)
    .update(`reply\n${canonicalJson(replyFields(reply))}`)
    .digest('base64url');
}

const commandAad = (prefix: string, id: string) =>
  JSON.stringify(['agora:console-command', CONSOLE_TOPIC, prefix, id]);

/**
 * Sealed mode (console side): the whole command, with the console's token when it has one, travels
 * sealed so only the owning app opens it. A Redis reader sees an id and ciphertext: no token to
 * lift and replay, no command to alter, no disk or key names. The sealed payload also carries a
 * one-off secret the app MACs its answer with, so a forged answer (from someone who cannot open the
 * command) is ignored.
 */
class SealedSenderAuth implements ChannelAuth {
  readonly #token: ReturnType<typeof resolveTenantToken> | undefined;
  /** Crypto mode with an automatic token (§13b): a failing token is skipped, not fatal. */
  readonly #optional: ((reason: string, code?: string) => void) | undefined;
  /** Said with a token that could not be minted (the grant to add). */
  readonly #hint: string | undefined;
  #retryAt = 0;
  /** The reasons already said (§13b: one warning per reason). */
  readonly #warned = new Set<string>();
  constructor(
    readonly sealer: ConsoleSealer,
    token: TenantTokenSource | undefined,
    readonly prefix: string,
    options: {
      optional?: ((reason: string, code?: string) => void) | undefined;
      hint?: string | undefined;
    } = {},
  ) {
    this.#token = token === undefined ? undefined : resolveTenantToken(token);
    this.#optional = options.optional;
    this.#hint = options.hint;
  }

  async #mint(): Promise<string | undefined> {
    if (!this.#token) return undefined;
    if (this.#optional && Date.now() < this.#retryAt) return undefined;
    try {
      return await this.#token.get();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const code = (error as { code?: unknown } | null)?.code;
      const errorCode = typeof code === 'string' ? code : undefined;
      // Token mode: the token is the only proof, the command cannot go without it.
      if (!this.#optional) {
        throw new TokenMintError(
          reason,
          this.#hint ? `${reason}. ${this.#hint}` : reason,
          errorCode,
        );
      }
      this.skipToken(reason, errorCode);
      return undefined;
    }
  }

  /**
   * Crypto mode: crypto alone authenticates the console. The token is left out (one warning per
   * reason) and minted again in 5 minutes.
   */
  skipToken(reason: string, code?: string): void {
    this.#retryAt = Date.now() + CONSOLE_RETRY_MS;
    if (this.#warned.has(reason)) return;
    if (this.#warned.size < 100) this.#warned.add(reason);
    try {
      this.#optional?.(reason, code);
    } catch {
      // a logger that throws must not block the command
    }
  }

  async wrap(command: MediaConsoleCommand): Promise<OutgoingMessage> {
    const token = await this.#mint();
    const secret = randomBytes(32).toString('base64url');
    const { mac: _mac, verified: _verified, ...fields } = command;
    const sealed = await this.sealer.seal(
      JSON.stringify({
        command: { ...fields, ts: Date.now() },
        ...(token !== undefined ? { token } : {}),
        replySecret: secret,
      }),
      commandAad(this.prefix, command.id),
    );
    const key = replyKey(secret, this.prefix, command.id);
    return {
      wire: { id: command.id, sealed },
      verifyReply: (reply) => sameMac(replyMac(key, reply), reply.mac),
    };
  }

  unauthorized(): void {
    this.#token?.reset?.();
  }
}

/**
 * Console side, automatic, both ways possible (§13a): the app's key in authkit's directory means
 * the app runs token mode (it publishes only then), so the token way; else crypto. Decided on the
 * first command, cached, decided again after a refusal or 5 minutes (the chooser's business).
 */
class ChoosingSenderAuth implements ChannelAuth {
  constructor(
    readonly chooser: ConsoleModeChooser,
    readonly ways: { token: SealedSenderAuth; crypto: SealedSenderAuth },
  ) {}

  #last: ChannelAuth | undefined;

  async wrap(command: MediaConsoleCommand): Promise<OutgoingMessage> {
    const chosen = await this.chooser.choose();
    if (chosen === 'token') {
      try {
        this.#last = this.ways.token;
        return await this.ways.token.wrap(command);
      } catch (error) {
        // Chosen by itself, and the app-call token cannot be minted (a key a former version of the
        // app published, a grant not given yet): crypto is there, so this command (and the next
        // ones, for 5 minutes: no failing mint per command) goes by crypto, with the §13b warning.
        if (!(error instanceof TokenMintError)) throw error;
        this.chooser.settle('crypto');
        this.ways.crypto.skipToken(error.reason, error.code);
      }
    }
    this.#last = this.ways.crypto;
    return this.ways.crypto.wrap(command);
  }

  unauthorized(): void {
    this.#last?.unauthorized?.();
  }

  failed(): void {
    this.chooser.reset();
  }
}

/** A required token could not be minted (`reason` without the grant hint). */
class TokenMintError extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'TokenMintError';
  }
}

/** How a sealed command's token is checked on the owning app. */
interface TokenCheck {
  /** Classic service-tenant tokens (`verifyTenant`): their partition must be this app. */
  verifyTenant?: ReturnType<typeof resolveTenantVerifier> | undefined;
  /** Authkit app-call tokens: audience-bound to this app already. */
  verifyAppCall?: AppCallVerifier | undefined;
  /** `true`: a command without a token that verifies is refused. `false`: a token is checked when sent. */
  required: boolean;
}

/**
 * Sealed mode (owning app side): open, check freshness, and check the token the command carries.
 * With a token the command's caller and capabilities come from it. A command without one is
 * accepted only when the token is optional (crypto mode: whoever may encrypt with the key is the
 * console, like a shared secret); a token that is sent is always checked.
 */
class SealedReceiverAuth implements ChannelAuth {
  constructor(
    readonly sealer: ConsoleSealer,
    readonly check: TokenCheck,
    readonly prefix: string,
    /** This app's name as the console's token should name it (advisory for the verifier). */
    readonly partition: string | undefined,
  ) {}

  async #verify(token: string): Promise<MediaConsoleCommand['verified'] | null> {
    const { verifyAppCall, verifyTenant } = this.check;
    if (verifyAppCall) {
      try {
        const caller = await verifyAppCall(token);
        if (caller && typeof caller.app === 'string' && Array.isArray(caller.capabilities)) {
          return {
            partition: caller.app,
            capabilities: caller.capabilities.filter((c) => typeof c === 'string'),
            ...(typeof caller.clientId === 'string' ? { clientId: caller.clientId } : {}),
            appCall: true,
          };
        }
      } catch {
        // Issuer unreachable, or not an app-call token: the classic verifier may still take it.
      }
    }
    if (verifyTenant) {
      try {
        const verified = await verifyTenant({
          token,
          app: this.partition,
          partition: this.partition,
          tenant: this.partition,
        });
        if (verified) {
          return {
            partition: verified.partition,
            capabilities: verified.capabilities,
            ...(verified.clientId !== undefined ? { clientId: verified.clientId } : {}),
          };
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  async unwrap(wire: Record<string, unknown>): Promise<IncomingMessage | null> {
    if (typeof wire.sealed !== 'string' || typeof wire.id !== 'string') return null;
    if (!this.sealer.owns(wire.sealed)) return null;
    const id = wire.id;
    let payload: { command?: MediaConsoleCommand; token?: unknown; replySecret?: unknown };
    try {
      payload = JSON.parse(
        await this.sealer.open(wire.sealed, commandAad(this.prefix, id)),
      ) as typeof payload;
    } catch {
      throw new ConsoleCommandRefused("did not open with this app's key");
    }
    const command = payload?.command;
    if (
      !command ||
      command.id !== id ||
      typeof command.verb !== 'string' ||
      typeof payload.replySecret !== 'string'
    ) {
      throw new ConsoleCommandRefused("did not open with this app's key");
    }
    if (!fresh(command.ts)) throw new ConsoleCommandRefused('stale');
    const key = replyKey(payload.replySecret, this.prefix, id);
    const signReply = (reply: MediaConsoleReply): MediaConsoleReply => {
      const { mac: _mac, ...rest } = reply;
      return { ...rest, mac: replyMac(key, rest as MediaConsoleReply) } as MediaConsoleReply;
    };
    const { mac: _mac, ts: _ts, verified: _claimed, ...fields } = command;
    const token = typeof payload.token === 'string' && payload.token !== '' ? payload.token : '';
    const canVerify =
      this.check.verifyAppCall !== undefined || this.check.verifyTenant !== undefined;
    // Nothing to check a token with (crypto alone), or none sent where it is optional.
    if (!canVerify || (!token && !this.check.required)) return { id, signReply, command: fields };

    const verified = token ? await this.#verify(token) : null;
    if (!verified) {
      return {
        id,
        signReply,
        error: {
          message: token
            ? `the console's token was refused by the "${this.prefix}" app`
            : `the "${this.prefix}" app needs a token with each console command`,
          code: UNAUTHORIZED_CONSOLE,
          status: 401,
        },
      };
    }
    return { id, signReply, command: { ...fields, verified } };
  }
}

/** How one channel authenticates: what it sends with, and every way it accepts commands. */
export interface ConsoleChannelAuthOptions {
  /** Shared-secret mode: the same value on the console and on the app (16+ characters). */
  secret?: ChannelSecret | undefined;
  /**
   * Sealed mode with `@adonis-agora/crypto`, both sides: the cipher (`crypto.client`, or
   * `serviceCipher(crypto.service, partition)` where crypto is embedded) and the key
   * (`console-media` by default). The console needs `encrypt` on it, the app `decrypt`.
   */
  crypto?:
    | {
        cipher: ConsoleCipherSource;
        key?: string | undefined;
        /** Whether a ciphertext is this cipher's (default: `agora:ct1:<key>:`), for a KMS of your own. */
        owns?: ((ciphertext: string) => boolean) | undefined;
      }
    | undefined;
  /** App side: verifies authkit app-call tokens (`appCallerVerifier().verifyToken`). */
  verifyAppCall?: AppCallVerifier | undefined;
  /**
   * App side, with `crypto` and `verifyTenant` both set: whether a crypto-sealed command must also
   * carry a token `verifyTenant` accepts. Default `true`. `false` when `verifyTenant` is only there
   * for the token mode (a control plane's own verifier, automatic crypto): whoever may encrypt with
   * the key is the console, as with crypto alone.
   */
  cryptoRequiresToken?: boolean | undefined;
  /** Console side: the token each command carries (`authkitTenantToken(...)`). */
  token?: TenantTokenSource | undefined;
  /**
   * Console side, crypto mode with an automatic token (§13b): called (once until it works again)
   * when the token cannot be minted; the command goes crypto-only, minting is retried in 5 min.
   */
  tokenOptional?: ((reason: string, code?: string) => void) | undefined;
  /** Console side: what to add when a required token cannot be minted (the authkit grant). */
  tokenHint?: string | undefined;
  /**
   * Console side, automatic with both ways possible (§13a): picks token (sealed to `recipient`)
   * or crypto per command, cached by the chooser.
   */
  chooser?: ConsoleModeChooser | undefined;
  /**
   * Console side, token mode without `crypto`: the app's command public key (`node ace
   * media:console-key` on the app prints it). Taken from the console's own config, never from Redis.
   */
  recipient?: ConsolePublicKeySource | undefined;
  /** App side, token mode without `crypto`: this app's command key pair (from its `APP_KEY`). */
  keys?: ConsoleCommandKeys | undefined;
  /** App side: verifies the console's token (`authkitTenantVerifier(...)`). */
  verifyTenant?: TenantVerifierInput | undefined;
  /**
   * App side, token mode: this app's name as the console's token names it (its `partition`),
   * handed to `verifyTenant` as the app the command is for. The command handler checks it.
   */
  partition?: string | undefined;
}

/** An `ioredis` client: pub/sub needs a dedicated connection, made with `duplicate()`. */
export interface IoredisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  duplicate(): IoredisSubscriberLike;
}

export interface IoredisSubscriberLike {
  subscribe(...channels: string[]): unknown;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  disconnect?(): void;
}

/** An `@adonisjs/redis` connection: it keeps its own subscriber and hands each payload over. */
export interface AdonisRedisLike {
  publish(channel: string, message: string): Promise<unknown>;
  set?(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<unknown>;
  subscribe(channel: string, handler: (message: string) => void): unknown;
  unsubscribe?(channel: string): unknown;
}

export type RedisLike = IoredisLike | AdonisRedisLike;

/** How long a command waits for its answer by default. */
export const MEDIA_CONSOLE_TIMEOUT_MS = 15_000;
/** How long the claim on a command lives (longer than any answer is waited for). */
const CLAIM_TTL_MS = 120_000;

function isIoredis(client: RedisLike): client is IoredisLike {
  return typeof (client as IoredisLike).duplicate === 'function';
}

/** `SET key value PX ttl NX` on either client: `'OK'` for the one caller that wins the key. */
function claimOf(
  client: RedisLike,
): ((key: string, value: string) => Promise<unknown>) | undefined {
  const target =
    typeof client.set === 'function'
      ? client
      : (client as { ioConnection?: { set?: IoredisLike['set'] } }).ioConnection;
  const set = target?.set;
  if (typeof set !== 'function') return undefined;
  return (key, value) => set.call(target, key, value, 'PX', CLAIM_TTL_MS, 'NX');
}

/** A command the owning app refused or failed, or that nobody answered. */
export class MediaConsoleChannelError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'MediaConsoleChannelError';
    this.code = code;
  }
}

/**
 * A command this app refused before running it, with the reason every Agora lib logs (§11b):
 * `not JSON`, `no command id`, `did not open with this app's key`, `bad signature`, `stale`,
 * `replayed`, `token refused`, `capabilities-required`, or `mode not accepted here (…)`.
 */
export class ConsoleCommandRefused extends MediaConsoleChannelError {
  readonly reason: string;
  constructor(reason: string) {
    super(`refused a command (${reason})`, UNSIGNED_CHANNEL);
    this.name = 'ConsoleCommandRefused';
    this.reason = reason;
  }
}

/** Nobody listens on the app's channel, or nobody answered in time. */
export const APP_UNREACHABLE = 'federated-app-unreachable';
/** The channel has no authentication, so it neither sends nor answers commands. */
export const UNSIGNED_CHANNEL = 'federated-channel-unsigned';

export class RedisConsoleChannel {
  readonly prefix: string;
  readonly #client: RedisLike;
  readonly #subscriptions: Array<() => void> = [];
  readonly #handlers = new Map<string, (payload: string) => void>();
  readonly #pending = new Map<string, (reply: MediaConsoleReply) => void>();
  #subscriber: IoredisSubscriberLike | undefined;
  #replies: Promise<void> | undefined;
  #answering = false;
  #closed = false;
  /** How commands are sent (one mode). */
  readonly #sender: ChannelAuth | undefined;
  /** How commands are accepted (each configured mode; an app may accept several while migrating). */
  readonly #receivers: ChannelAuth[];
  /** The modes this app accepts, for the refusal of a command in another one. */
  readonly #accepts: string[] = [];
  /** Ids this instance has seen lately: a second sighting is a replay. */
  readonly #seen = new Map<string, number>();
  #onError: ((error: unknown) => void) | undefined;

  /**
   * Redis is not a trust boundary, so a channel neither sends nor answers commands without one of:
   *
   * - `crypto` — commands sealed with an `@adonis-agora/crypto` key (the console may encrypt with it,
   *   the app decrypt), optionally with a `token` the app checks with `verifyTenant`;
   * - a `token` sealed to the app's command key (`recipient` on the console, `keys` on the app,
   *   from its `APP_KEY`), checked with `verifyTenant` (authkit, typically);
   * - `secret` — shared by the console and the app (the same value on both sides).
   */
  constructor(options: { client: RedisLike; prefix: string } & ConsoleChannelAuthOptions) {
    if (!options.prefix) throw new Error(`[${PACKAGE}] console channel: prefix is required`);
    this.#client = options.client;
    this.prefix = options.prefix;
    const secret =
      options.secret === undefined ? undefined : new SecretAuth(options.secret, options.prefix);
    const crypto = options.crypto ? cryptoConsoleSealer(options.crypto) : undefined;

    // Sending: crypto when configured, else a token sealed to the app's key, else the secret.
    if (options.token !== undefined && !crypto && options.recipient === undefined) {
      throw new Error(
        `[${PACKAGE}] console channel: a \`token\` needs \`crypto\` or the app's \`publicKey\``,
      );
    }
    const tokenWay =
      options.recipient !== undefined && options.token !== undefined
        ? new SealedSenderAuth(appKeySealerTo(options.recipient), options.token, options.prefix, {
            hint: options.tokenHint,
          })
        : undefined;
    const cryptoWay = crypto
      ? new SealedSenderAuth(crypto, options.token, options.prefix, {
          optional: options.tokenOptional,
          hint: options.tokenHint,
        })
      : undefined;
    this.#sender =
      options.chooser && tokenWay && cryptoWay
        ? new ChoosingSenderAuth(options.chooser, { token: tokenWay, crypto: cryptoWay })
        : (cryptoWay ?? tokenWay ?? secret);

    // Answering: every configured way. Without crypto, sealed commands need a token check.
    const receivers: ChannelAuth[] = [];
    const verifyTenant =
      options.verifyTenant === undefined ? undefined : resolveTenantVerifier(options.verifyTenant);
    const tokenCheck = (required: boolean): TokenCheck => ({
      verifyTenant,
      verifyAppCall: options.verifyAppCall,
      required,
    });
    if (crypto) {
      // With crypto and an explicit `verifyTenant`, a token is required (unless told otherwise);
      // otherwise a token is checked when the console sends one.
      const required = verifyTenant !== undefined && options.cryptoRequiresToken !== false;
      receivers.push(
        new SealedReceiverAuth(crypto, tokenCheck(required), options.prefix, options.partition),
      );
      this.#accepts.push('crypto');
    }
    if (options.keys && (verifyTenant !== undefined || options.verifyAppCall !== undefined)) {
      receivers.push(
        new SealedReceiverAuth(
          appKeySealer(options.keys),
          tokenCheck(true),
          options.prefix,
          options.partition,
        ),
      );
      this.#accepts.push('token');
    }
    if (secret) {
      receivers.push(secret);
      this.#accepts.push('secret');
    }
    this.#receivers = receivers;
  }

  /** Whether this channel can send commands (crypto, a token and the app's key, or a secret). */
  get signed(): boolean {
    return this.#sender !== undefined;
  }

  /** Whether this channel answers commands in at least one authenticated way. */
  get answers(): boolean {
    return this.#receivers.length > 0;
  }

  #unsigned(): MediaConsoleChannelError {
    return new MediaConsoleChannelError(
      `the "${this.prefix}" ${CONSOLE_TOPIC} console channel has no authentication; use @adonis-agora/crypto (\`crypto\` on both sides), authkit (a \`token\` and the app's \`publicKey\` on the console, \`verifyTenant\` on the app) or the same \`secret\` on both`,
      UNSIGNED_CHANNEL,
    );
  }

  get commandChannel(): string {
    return `${this.prefix}-${CONSOLE_TOPIC}-console`;
  }

  get replyChannel(): string {
    return `${this.prefix}-${CONSOLE_TOPIC}-console-reply`;
  }

  /** Subscribe `handler` to `channel`; resolves once the subscription is in place. */
  async #subscribe(channel: string, handler: (payload: string) => void): Promise<void> {
    const client = this.#client;
    if (isIoredis(client)) {
      if (!this.#subscriber) {
        const sub = client.duplicate();
        this.#subscriber = sub;
        sub.on('message', (ch, payload) => this.#handlers.get(ch)?.(payload));
      }
      this.#handlers.set(channel, handler);
      await this.#subscriber.subscribe(channel);
      return;
    }
    await client.subscribe(channel, handler);
    this.#subscriptions.push(() => void client.unsubscribe?.(channel));
  }

  /**
   * Send `command` to the owning app and wait for its answer. Rejects at once when no instance
   * listens (`PUBLISH` reached nobody) and after `timeoutMs` when nobody answers. An answer that
   * does not carry this command's MAC (a forged one) is ignored.
   */
  async send(
    command: MediaConsoleCommand,
    options: { timeoutMs?: number | undefined } = {},
  ): Promise<MediaConsoleReply> {
    if (this.#closed) throw new MediaConsoleChannelError('console channel closed', APP_UNREACHABLE);
    const sender = this.#sender;
    if (!sender?.wrap) throw this.#unsigned();
    let outgoing: OutgoingMessage;
    try {
      outgoing = await sender.wrap(command);
    } catch (error) {
      // Any send failure drops an automatic per-app choice: the next command decides again.
      sender.failed?.();
      if (error instanceof MediaConsoleChannelError) throw error;
      throw new MediaConsoleChannelError(
        `could not prepare the ${CONSOLE_TOPIC} console command for "${this.prefix}": ${error instanceof Error ? error.message : String(error)}`,
        APP_UNREACHABLE,
      );
    }
    if (!this.#replies) {
      const replies = this.#subscribe(this.replyChannel, (payload) => {
        let reply: MediaConsoleReply;
        try {
          reply = JSON.parse(payload) as MediaConsoleReply;
        } catch {
          return;
        }
        if (typeof reply?.id !== 'string') return;
        this.#pending.get(reply.id)?.(reply);
      });
      this.#replies = replies;
      // A failed subscribe (a Redis blip) is retried by the next send, not kept for good.
      replies.catch(() => {
        if (this.#replies === replies) this.#replies = undefined;
      });
    }
    try {
      await this.#replies;
    } catch (error) {
      throw new MediaConsoleChannelError(
        `could not subscribe to the "${this.prefix}" app's console replies: ${error instanceof Error ? error.message : String(error)}`,
        APP_UNREACHABLE,
      );
    }
    const timeoutMs = options.timeoutMs ?? MEDIA_CONSOLE_TIMEOUT_MS;
    return new Promise<MediaConsoleReply>((resolve, reject) => {
      const fail = (message: string) => {
        sender.failed?.();
        clearTimeout(timer);
        this.#pending.delete(command.id);
        reject(new MediaConsoleChannelError(message, APP_UNREACHABLE));
      };
      const timer = setTimeout(() => {
        // Maybe refused (a refusal is never answered): `fail` drops an automatic choice.
        fail(
          `no instance of "${this.prefix}" answered within ${Math.round(timeoutMs / 100) / 10}s — the app may have refused the command (check its logs, or run \`node ace agora:doctor\` there)`,
        );
      }, timeoutMs);
      timer.unref?.();
      this.#pending.set(command.id, (reply) => {
        // A reply without this command's MAC is someone else's (or forged): wait for the real one.
        // The channel's own `close()` settles with an unsigned reply on purpose.
        if (!(this.#closed || outgoing.verifyReply(reply))) return;
        clearTimeout(timer);
        this.#pending.delete(command.id);
        if (!reply.ok && reply.error.code === UNAUTHORIZED_CONSOLE) sender.unauthorized?.();
        if (!reply.ok && /mode not accepted here/.test(reply.error.message)) sender.failed?.();
        const { mac: _mac, ...verified } = reply;
        resolve(verified as MediaConsoleReply);
      });
      this.#client.publish(this.commandChannel, JSON.stringify(outgoing.wire)).then(
        (receivers) => {
          // Redis says how many subscribers got it: none means no instance answers commands.
          if (receivers === 0) {
            fail(
              `no instance of the "${this.prefix}" app listens for ${CONSOLE_TOPIC} console commands (is it up, with \`consoleCommands\` in config/${CONSOLE_TOPIC}.ts?)`,
            );
          }
        },
        (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
      );
    });
  }

  /**
   * Answer the commands other apps' consoles send this app. Every instance subscribes; the one that
   * wins `SET <prefix>-media-console-claim:<id> NX` runs the command and publishes the answer, so a
   * command runs once however many processes the app has. Throws when the channel has no
   * authentication, or when the client cannot run that `SET`: a command never runs without the
   * claim.
   */
  async answer(
    handler: (command: MediaConsoleCommand) => Promise<unknown>,
    options: { onError?: (error: unknown) => void } = {},
  ): Promise<void> {
    if (this.#answering) return;
    if (this.#receivers.length === 0) throw this.#unsigned();
    const claim = claimOf(this.#client);
    if (!claim) {
      throw new Error(
        `the "${this.prefix}" Redis connection cannot run \`SET key value PX ms NX\`, so ${CONSOLE_TOPIC} console commands cannot be claimed by one instance; refusing to answer them`,
      );
    }
    this.#answering = true;
    this.#onError = options.onError;
    const instance = randomUUID();
    await this.#subscribe(this.commandChannel, (payload) => {
      // Every error path ends here: logged by `onError` (which may not throw either), never a crash.
      let running: Promise<void>;
      try {
        running = this.#run(payload, instance, claim, handler);
      } catch (error) {
        running = Promise.reject(error);
      }
      void running.catch((error) => {
        try {
          options.onError?.(error);
        } catch {
          /* a failing logger must not take the process down */
        }
      });
    });
  }

  async #run(
    payload: string,
    instance: string,
    claim: (key: string, value: string) => Promise<unknown>,
    handler: (command: MediaConsoleCommand) => Promise<unknown>,
  ): Promise<void> {
    let wire: Record<string, unknown>;
    try {
      wire = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      throw new ConsoleCommandRefused('not JSON');
    }
    if (!wire || typeof wire !== 'object' || Array.isArray(wire)) {
      throw new ConsoleCommandRefused('not JSON');
    }
    if (typeof wire.id !== 'string' || wire.id === '') {
      throw new ConsoleCommandRefused('no command id');
    }
    // This instance hears every command once: a second sighting of an id is a replay.
    const now = Date.now();
    for (const [id, until] of this.#seen) if (until < now) this.#seen.delete(id);
    if (this.#seen.has(wire.id)) throw new ConsoleCommandRefused('replayed');
    let incoming: IncomingMessage | null = null;
    for (const receiver of this.#receivers) {
      incoming = (await receiver.unwrap?.(wire)) ?? null;
      if (incoming) break;
    }
    if (!incoming) {
      const came =
        typeof wire.sealed === 'string'
          ? wire.sealed.startsWith(SEALED_PREFIX)
            ? 'token'
            : 'crypto'
          : typeof wire.mac === 'string'
            ? 'secret'
            : 'unsigned';
      throw new ConsoleCommandRefused(
        `mode not accepted here (this app accepts: ${this.#accepts.join(', ')}; the command came as ${came})`,
      );
    }
    // Remembered only once authenticated: a forged message cannot block a genuine id.
    if (this.#seen.size < 10_000) this.#seen.set(incoming.id, now + CLAIM_TTL_MS);
    // One instance runs (or refuses) it; a replay inside the freshness window reuses the id, and
    // the claim (kept 2 minutes) refuses it.
    const claimed = await claim(
      `${this.prefix}-${CONSOLE_TOPIC}-console-claim:${incoming.id}`,
      instance,
    );
    if (claimed !== 'OK') return;
    if (!incoming.command) {
      if (incoming.error?.code === UNAUTHORIZED_CONSOLE) this.#refused('token refused');
      await this.#client.publish(
        this.replyChannel,
        JSON.stringify(
          incoming.signReply({
            id: incoming.id,
            ok: false,
            error: incoming.error ?? { message: 'refused' },
          }),
        ),
      );
      return;
    }
    const { capabilities, ...command } = incoming.command;
    let reply: MediaConsoleReply;
    try {
      const data = await handler({
        ...command,
        args: Array.isArray(command.args) ? command.args : [],
        // Anything but a list of strings is no capability at all (never "every capability").
        ...(Array.isArray(capabilities)
          ? { capabilities: capabilities.filter((c) => typeof c === 'string') }
          : {}),
      });
      // `undefined` (an action with no answer) travels as `null`.
      reply = { id: command.id, ok: true, data: data === undefined ? null : data };
    } catch (err) {
      const { code, status } = (err ?? {}) as { code?: unknown; status?: unknown };
      if (code === 'capabilities-required') this.#refused('capabilities-required');
      reply = {
        id: command.id,
        ok: false,
        error: {
          message: err instanceof Error ? err.message : String(err),
          ...(typeof code === 'string' ? { code } : {}),
          ...(typeof status === 'number' ? { status } : {}),
        },
      };
    }
    // MAC'd in its wire form (a `Date` becomes a string, `undefined` fields vanish), or the
    // console would compute another MAC and drop a genuine answer.
    await this.#client.publish(
      this.replyChannel,
      JSON.stringify(incoming.signReply(JSON.parse(JSON.stringify(reply)))),
    );
  }

  /** Reports a refusal answered to the console (it is logged like the dropped ones). */
  #refused(reason: string): void {
    try {
      this.#onError?.(new ConsoleCommandRefused(reason));
    } catch {
      /* a failing logger must not take the process down */
    }
  }

  /** Stop listening and fail the commands still waiting for an answer. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const [id, settle] of this.#pending) {
      settle({
        id,
        ok: false,
        error: { message: 'console channel closed', code: APP_UNREACHABLE },
      });
    }
    this.#pending.clear();
    for (const unsubscribe of this.#subscriptions.splice(0)) unsubscribe();
    this.#subscriber?.disconnect?.();
    this.#subscriber = undefined;
  }
}

/**
 * The Redis client for `connection` (an `@adonisjs/redis` connection name; omit for its default),
 * resolved through the container's `redis` binding.
 */
export async function resolveRedisConnection(
  container: { make(binding: string): Promise<unknown> },
  connection: string | undefined,
): Promise<RedisLike> {
  let redis: { connection(name?: string): unknown };
  try {
    redis = (await container.make('redis')) as typeof redis;
  } catch (error) {
    throw new Error(
      `[${PACKAGE}] the federated console needs @adonisjs/redis (no "redis" binding: ${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return redis.connection(connection) as RedisLike;
}
