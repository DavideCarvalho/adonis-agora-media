import type { TenantTokenSource, TenantVerifierInput } from '../topology/auth.js';
import {
  type AppCallVerifier,
  type ChannelSecret,
  CONSOLE_CRYPTO_KEY,
  CONSOLE_RETRY_MS,
  type ConsoleChannelAuthOptions,
  type ConsoleCipher,
  type ConsoleCipherSource,
  type ConsoleCommandKeys,
  type ConsoleModeChooser,
  consoleCommandKeys,
  isConsolePublicKey,
  RedisConsoleChannel,
  shortKeyId,
} from './redis_channel.js';

/**
 * How the federated console's Redis channel is authenticated when nothing says so. The siblings are
 * detected structurally through the container (this package imports neither):
 *
 * - `@adonis-agora/crypto` (`agora.crypto`): commands are sealed with the key `console-media` in the
 *   owning app's crypto partition, whether crypto runs in this app or in another (a tenant);
 * - `@adonis-agora/authkit-client` (`authkit.client`, calls between apps): each command carries the
 *   console app's app-call token for the owning app, which the owning app verifies.
 *
 * Everything is replaceable: explicit `crypto`, `secret`, `token`/`verifyTenant` win, and
 * `crypto: false`, `token: false`, `verifyTenant: false` turn a detection off.
 */

const PACKAGE = '@adonis-agora/media';
/** The sentence every Agora lib's boot error carries (SECURITY-UNIFORM-SPEC §11). */
const DOCTOR_HINT = "Run `node ace agora:doctor` to see every Agora lib's console auth at once.";

/** What else was found, after the uniform message (why the automatic modes did not apply). */
const notesOf = (notes: string[]) => (notes.length ? ` Note: ${notes.join('; ')}.` : '');

/** Where the console's authentication is documented. */
export const CONSOLE_AUTH_DOCS =
  'https://davidecarvalho.github.io/agora/docs/media/dashboard/federated-console#authenticating-the-console';
/** The container binding `@adonis-agora/crypto` publishes its runtime under. */
export const CRYPTO_BINDING = 'agora.crypto';
/** The container binding `@adonis-agora/authkit-client` publishes its manager under. */
export const AUTHKIT_BINDING = 'authkit.client';
/** Who the console's key management and encryption are audited as in crypto. */
const CRYPTO_ACTOR = 'media:console';

/** A crypto principal, as `@adonis-agora/crypto`'s service takes it. */
interface CryptoPrincipalLike {
  partition: string;
  capabilities: string[];
  actor: string;
}

/** What this package reads of `@adonis-agora/crypto`'s runtime (`agora.crypto`). */
export interface CryptoRuntimeLike {
  topology: 'standalone' | 'control-plane' | 'tenant';
  /** The app's crypto partition: its name on a standalone/control plane, its partition on a tenant. */
  partition: string;
  /** Crypto embedded in this app (standalone, control plane): any partition's keys. */
  service?:
    | {
        encrypt(
          principal: CryptoPrincipalLike,
          input: { key: string; plaintext: string; aad?: string },
        ): Promise<{ ciphertext: string }>;
        decrypt(
          principal: CryptoPrincipalLike,
          input: { key: string; ciphertext: string; aad?: string; context?: string },
        ): Promise<{ plaintext: string }>;
        createKey(
          principal: CryptoPrincipalLike,
          input: { name: string; type: 'aes256-gcm'; description?: string },
        ): Promise<unknown>;
        store: { getKey(partition: string, name: string): Promise<unknown> };
      }
    | undefined;
  /**
   * This app's own operations (in-process on a server, over its configured channel on a tenant).
   * `encrypt` takes `partition` to seal for another app (a tenant console, `crypto:seal:<key>`).
   */
  operations: {
    encrypt(input: {
      key: string;
      plaintext: string;
      aad?: string;
      context?: string;
      partition?: string;
    }): Promise<{ ciphertext: string }>;
    decrypt(input: {
      key: string;
      ciphertext: string;
      aad?: string;
      context?: string;
    }): Promise<{ plaintext: string }>;
    createKey?(input: { name: string; type: 'aes256-gcm'; description?: string }): Promise<unknown>;
    /**
     * Whether this app's key exists (`false` when missing), without a decrypt that the crypto audit
     * would record as an error (§13f). Optional: older crypto versions lack it.
     */
    hasKey?(input: { key: string }): Promise<boolean>;
  };
}

/** What this package reads of `@adonis-agora/authkit-client`'s manager (`authkit.client`). */
export interface AuthkitClientLike {
  appCallTokens?(): { token(app: string): Promise<string>; reset?(): void } | null | undefined;
  appCallsConfig?(): unknown;
  /** Publishes one of this app's public keys in authkit's key directory (background, retried). */
  publishAppKey?(input: { purpose: string; jwk: OkpJwk }): Promise<void>;
  /** Another app's public key for `purpose` from authkit's key directory (cached), or `null`. */
  appKey?(input: { app: string; purpose: string }): Promise<OkpJwk | null>;
  appCallerVerifier?(): {
    verifyToken?(
      token: string,
    ): Promise<{ app: string; capabilities: string[]; clientId?: string } | null>;
  } | null;
}

/** An X25519 public JWK (never `d`). */
export interface OkpJwk {
  kty: 'OKP';
  crv: 'X25519';
  x: string;
  kid?: string;
}

/** The purpose media's command key is published under in authkit's key directory. */
export const CONSOLE_KEY_PURPOSE = 'console:media';

/** The public JWK of an app's command key, as published in authkit's key directory. */
export function commandKeyJwk(keys: { publicKey: string; kid: string }): OkpJwk {
  return { kty: 'OKP', crv: 'X25519', x: keys.publicKey, kid: keys.kid };
}

/** `; sealed to key <id>` for a public key given as a string (a function's is not known yet). */
function keyIdOf(publicKey: unknown): string {
  return isConsolePublicKey(publicKey) ? `; sealed to key ${shortKeyId(publicKey)}` : '';
}

/** Whether authkit's key directory can hand this console an app's command key. */
export function hasKeyDirectory(authkit: AuthkitClientLike | undefined): boolean {
  return typeof authkit?.appKey === 'function';
}

/**
 * The app's command public key from authkit's key directory, fetched when a command is sent. A
 * missing one is an actionable error.
 */
function directoryRecipient(authkit: AuthkitClientLike, app: string): () => Promise<string> {
  return async () => {
    const jwk = await authkit.appKey!({ app, purpose: CONSOLE_KEY_PURPOSE });
    if (!jwk || typeof jwk.x !== 'string' || jwk.x === '') {
      throw new Error(
        `the app "${app}" has published no ${CONSOLE_KEY_PURPOSE} key in authkit's key directory: it publishes it automatically at boot when it has authkit's \`service\` configured (and consoleCommands in token mode), or set controlPlane.publicKey (\`node ace media:console-key\` on that app prints it)`,
      );
    }
    return jwk.x;
  };
}

/**
 * §13a: token mode when the app published its key in authkit's directory, else crypto. Cached;
 * decided again after 5 minutes, or when the channel says the app did not take a command.
 */
export function directoryChooser(
  authkit: AuthkitClientLike,
  app: string,
  now: () => number = Date.now,
): ConsoleModeChooser {
  let decided: { way: 'token' | 'crypto'; at: number } | undefined;
  return {
    async choose() {
      if (decided && now() - decided.at < CONSOLE_RETRY_MS) return decided.way;
      let way: 'token' | 'crypto' = 'crypto';
      try {
        const jwk = await authkit.appKey!({ app, purpose: CONSOLE_KEY_PURPOSE });
        if (jwk && typeof jwk.x === 'string' && jwk.x !== '') way = 'token';
      } catch {
        // authkit unreachable: crypto still works.
      }
      decided = { way, at: now() };
      return way;
    },
    reset() {
      decided = undefined;
    },
    settle(way) {
      decided = { way, at: now() };
    },
  };
}

/** The siblings this app has, as the container says. */
export interface ConsoleSiblings {
  crypto?: CryptoRuntimeLike | undefined;
  authkit?: AuthkitClientLike | undefined;
}

interface ContainerLike {
  hasBinding?(binding: string): boolean;
  make(binding: string): Promise<unknown>;
}

function isCryptoRuntime(value: unknown): value is CryptoRuntimeLike {
  const runtime = value as Partial<CryptoRuntimeLike> | null | undefined;
  return (
    typeof runtime === 'object' &&
    runtime !== null &&
    typeof runtime.partition === 'string' &&
    typeof runtime.operations?.encrypt === 'function' &&
    typeof runtime.operations?.decrypt === 'function'
  );
}

function bound(container: ContainerLike, binding: string): boolean {
  return typeof container.hasBinding === 'function' && container.hasBinding(binding);
}

/**
 * `@adonis-agora/crypto`'s runtime when it is booted in this app, else `undefined`. Throws when it
 * is registered but does not start (its own error, with this package's context).
 */
export async function cryptoRuntimeOf(
  container: ContainerLike,
): Promise<CryptoRuntimeLike | undefined> {
  if (!bound(container, CRYPTO_BINDING)) return undefined;
  let runtime: unknown;
  try {
    runtime = await container.make(CRYPTO_BINDING);
  } catch (error) {
    throw new Error(
      `[${PACKAGE}] @adonis-agora/crypto is registered but did not start, so the federated console cannot use it: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return isCryptoRuntime(runtime) ? runtime : undefined;
}

/** `@adonis-agora/authkit-client`'s manager when it is registered here, else `undefined`. */
export async function authkitClientOf(
  container: ContainerLike,
): Promise<AuthkitClientLike | undefined> {
  if (!bound(container, AUTHKIT_BINDING)) return undefined;
  try {
    const manager = (await container.make(AUTHKIT_BINDING)) as AuthkitClientLike | undefined;
    return manager && typeof manager === 'object' ? manager : undefined;
  } catch {
    return undefined;
  }
}

/** Both siblings, as far as this app has them. */
export async function consoleSiblingsOf(container: ContainerLike): Promise<ConsoleSiblings> {
  const [crypto, authkit] = await Promise.all([
    cryptoRuntimeOf(container),
    authkitClientOf(container),
  ]);
  return { crypto, authkit };
}

/** The app-call verifier of authkit (calls between apps), when this app has one. */
function appCallVerifierOf(authkit: AuthkitClientLike | undefined): AppCallVerifier | undefined {
  let verifier: ReturnType<NonNullable<AuthkitClientLike['appCallerVerifier']>> | undefined;
  try {
    verifier = authkit?.appCallerVerifier?.();
  } catch {
    return undefined;
  }
  const verifyToken = verifier?.verifyToken;
  if (typeof verifyToken !== 'function') return undefined;
  return (token) => verifyToken.call(verifier, token);
}

/** Whether authkit hands this app app-call tokens (its `service` config with credentials). */
function hasAppCallTokens(authkit: AuthkitClientLike | undefined): boolean {
  if (!authkit || typeof authkit.appCallTokens !== 'function') return false;
  try {
    if (authkit.appCallTokens()) return true;
    const config = authkit.appCallsConfig?.() as { clientId?: unknown } | undefined;
    return typeof config?.clientId === 'string' && config.clientId !== '';
  } catch {
    return false;
  }
}

/** The app-call token for `app`, read from authkit when a command is sent. */
function appCallToken(authkit: AuthkitClientLike, app: string): TenantTokenSource {
  return {
    get: async () => {
      const tokens = authkit.appCallTokens?.();
      if (!tokens) {
        throw new Error(
          'authkit has no app-call tokens (calls between apps are not installed: check `service` in config/authkit_client.ts)',
        );
      }
      return tokens.token(app);
    },
    reset: () => authkit.appCallTokens?.()?.reset?.(),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The console key                                                                               */
/* -------------------------------------------------------------------------------------------- */

/** Keys being ensured, per runtime and partition (one create per process, retried after a failure). */
const ensured = new WeakMap<object, Map<string, Promise<'created' | 'exists'>>>();

/** The exact command that creates the console key in `partition`, on the crypto server. */
export function createKeyCommand(partition: string, key: string = CONSOLE_CRYPTO_KEY): string {
  return `node ace crypto:keys:create ${key} --type aes256-gcm --application ${partition}`;
}

/**
 * Make sure the console key (`aes256-gcm`) exists in `partition`, with crypto embedded in this app
 * (`runtime.service`): created when missing (idempotent: another instance creating it meanwhile is
 * fine). A failure throws with the exact command to run. Without `service` (a crypto tenant), see
 * {@link checkTenantConsoleKey}: this throws its warning.
 */
export function ensureConsoleKey(
  runtime: CryptoRuntimeLike,
  partition: string = runtime.partition,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<'created' | 'exists'> {
  let byPartition = ensured.get(runtime);
  if (!byPartition) {
    byPartition = new Map();
    ensured.set(runtime, byPartition);
  }
  const id = `${partition}\n${key}`;
  let pending = byPartition.get(id);
  if (!pending) {
    pending = runtime.service
      ? ensureEmbedded(runtime.service, partition, key)
      : checkTenantConsoleKey(runtime, key).then((report) => {
          if (report?.level === 'warn') throw new Error(report.line);
          return report ? 'created' : 'exists';
        });
    const settled = pending;
    settled.catch(() => {
      if (byPartition.get(id) === settled) byPartition.delete(id);
    });
    byPartition.set(id, pending);
  }
  return pending;
}

async function ensureEmbedded(
  service: NonNullable<CryptoRuntimeLike['service']>,
  partition: string,
  key: string,
): Promise<'created' | 'exists'> {
  try {
    if (await service.store.getKey(partition, key)) return 'exists';
    await service.createKey(
      { partition, capabilities: [`crypto:keys:manage:${key}`], actor: CRYPTO_ACTOR },
      {
        name: key,
        type: 'aes256-gcm',
        description: `Federated media console commands (${PACKAGE})`,
      },
    );
    return 'created';
  } catch (error) {
    // Another instance won the race: the key is there all the same.
    if (await service.store.getKey(partition, key).catch(() => undefined)) return 'exists';
    throw new Error(
      `[${PACKAGE}] console commands: could not create the crypto key "${key}" in partition ${partition} (${errorText(error)}); run \`${createKeyCommand(partition, key)}\``,
    );
  }
}

/** What the key-check block calls on this app's crypto. */
type CryptoOperationsLike = CryptoRuntimeLike['operations'];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------------------------------- */
/* App side on a crypto tenant: is the console key there, and usable?                          */
/*                                                                                             */
/* Self-contained on purpose: every Agora lib ports this block as is (only PACKAGE and the     */
/* key default differ). Rules (SECURITY-UNIFORM-SPEC §10.7, §10.14):                           */
/* - ask `operations.hasKey({ key })` when crypto offers it (no audit noise); else probe with a */
/*   dummy decrypt, which an app may always do on its own console keys; never getKey (it needs */
/*   crypto:keys:read);                                                                        */
/* - only "not found" means missing: try to create it (servers with provisioning off), else     */
/*   one INFO line (the crypto server provisions console-* keys on the console's first seal);  */
/* - any other failure (forbidden, unauthenticated, server down) logs one WARN line: never     */
/*   silent, never a boot failure;                                                             */
/* - checked once at boot; after a warning, the next command's own decrypt is the retry (its  */
/*   error is classified the same way), so a command never makes two failing calls.          */
/* ------------------------------------------------------------------------------------------- */

/** What one decrypt failure says about the key. */
export type ConsoleKeyOutcome = 'missing' | 'usable' | 'refused' | 'unreachable';

/**
 * Classifies a decrypt error from @adonis-agora/crypto (its `CryptoError` / client error carry a
 * `code`; the message is the fallback for other clients). `usable`: the key exists and this app
 * may decrypt with it (only the dummy ciphertext was rejected).
 */
export function classifyConsoleKeyError(error: unknown): ConsoleKeyOutcome {
  const code = (error as { code?: unknown } | null)?.code;
  const text = errorText(error);
  if (code === 'not_found' || /no key named|not[ _]found/i.test(text)) return 'missing';
  if (code === 'invalid' || code === 'unreadable') return 'usable';
  if (
    code === 'forbidden' ||
    code === 'unauthenticated' ||
    /forbid|lacks|capabilit|denied|not allowed|unauthori[sz]ed|unauthenticated|\b40[13]\b/i.test(
      text,
    )
  ) {
    return 'refused';
  }
  if (
    /invalid|unreadable|malformed|ciphertext|unable to authenticate|auth(entication)? tag/i.test(
      text,
    )
  )
    return 'usable';
  return 'unreachable';
}

/** A `forbidden` refusal from crypto (its error code, or the message for other clients). */
export function isForbidden(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'forbidden' || /forbid/i.test(errorText(error));
}

/** The one line to log for `outcome`, or `undefined` when all is well. */
export function consoleKeyNote(
  runtime: Pick<CryptoRuntimeLike, 'partition'>,
  outcome: ConsoleKeyOutcome | 'created',
  key: string = CONSOLE_CRYPTO_KEY,
  detail?: string,
): { level: 'info' | 'warn'; line: string } | undefined {
  const where = `the crypto key "${key}" in partition ${runtime.partition}`;
  const create = `\`node ace crypto:keys:create ${key} --type aes256-gcm --application ${runtime.partition}\``;
  const why = detail ? ` (${detail})` : '';
  switch (outcome) {
    case 'usable':
      return undefined;
    case 'created':
      return { level: 'info', line: `[${PACKAGE}] console commands: created ${where}` };
    case 'missing':
      // Not a problem on a crypto tenant: the crypto server provisions `console-*` keys on the
      // console's first seal. Only a server with sealProvisioning off needs the command.
      return {
        level: 'info',
        line: `[${PACKAGE}] console commands: the crypto key "${key}" does not exist in partition ${runtime.partition} yet; the crypto server creates it on the console's first command (if it has sealProvisioning off: ${create.slice(1, -1)})`,
      };
    case 'refused':
      return {
        level: 'warn',
        line: `[${PACKAGE}] console commands: the crypto server refused this app on ${where}${why}; no grant is needed for an app's own console keys (crypto:decrypt:console-* is harmless if present): check this app's crypto token is valid and the crypto server is up to date`,
      };
    case 'unreachable':
      return {
        level: 'warn',
        line: `[${PACKAGE}] console commands: could not check ${where}${why}; is the crypto server up? Retried on the next command`,
      };
  }
}

/**
 * Checks the console key once (a dummy decrypt) and, when it is missing, tries to create it
 * through the channel crypto already configured (works with `crypto:keys:manage:console-*`).
 * Never throws: returns the line to log, or `undefined` when the key is there and usable.
 */
export async function checkTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  key: string = CONSOLE_CRYPTO_KEY,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  let outcome: ConsoleKeyOutcome;
  let detail: string | undefined;
  const hasKey = runtime.operations.hasKey;
  if (typeof hasKey === 'function') {
    // Newer crypto servers answer this directly: no decrypt, no error row in the audit. A
    // `forbidden` refusal is the "no permission" outcome; any other throw (an older server
    // without the route) falls back to the decrypt probe below.
    try {
      if (await hasKey.call(runtime.operations, { key })) return undefined;
      return createMissing(runtime, key);
    } catch (error) {
      if (isForbidden(error)) return consoleKeyNote(runtime, 'refused', key, errorText(error));
    }
  }
  try {
    await runtime.operations.decrypt({
      key,
      ciphertext: `agora:ct1:${key}:1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
      aad: 'agora:console-key-check',
    });
    return undefined; // a dummy that decrypts: cannot happen, but the key is clearly there
  } catch (error) {
    outcome = classifyConsoleKeyError(error);
    detail = errorText(error);
  }
  if (outcome !== 'missing') return consoleKeyNote(runtime, outcome, key, detail);
  return createMissing(runtime, key);
}

/** The key is missing: create it when this app may (servers with provisioning off), else say so. */
async function createMissing(
  runtime: CryptoRuntimeLike,
  key: string,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  try {
    if (typeof runtime.operations.createKey !== 'function') throw new Error('no createKey');
    await runtime.operations.createKey({
      name: key,
      type: 'aes256-gcm',
      description: `${PACKAGE}: seals the federated console's commands to this app`,
    });
    return consoleKeyNote(runtime, 'created', key);
  } catch {
    return consoleKeyNote(runtime, 'missing', key);
  }
}

/**
 * The tenant's console key, watched: `atBoot()` runs {@link checkTenantConsoleKey} once;
 * `decrypt` wraps the app's own decrypt so that, while the last check warned, a command's failure
 * is classified and logged (one line, only when it changes) and its success clears the warning.
 * No extra crypto call per command.
 */
export function watchTenantConsoleKey(
  runtime: CryptoRuntimeLike,
  log: (note: { level: 'info' | 'warn'; line: string }) => void,
  key: string = CONSOLE_CRYPTO_KEY,
): { atBoot(): Promise<void>; decrypt: CryptoOperationsLike['decrypt'] } {
  let last: string | undefined;
  let healthy = false;
  const report = (note: { level: 'info' | 'warn'; line: string } | undefined) => {
    healthy = note === undefined || note.level === 'info';
    if (note && note.line !== last) log(note);
    last = note?.line;
  };
  const boot = once(async () => report(await checkTenantConsoleKey(runtime, key)));
  return {
    atBoot: () => boot().catch(() => undefined),
    decrypt: async (input) => {
      try {
        const result = await runtime.operations.decrypt(input);
        if (!healthy && input.key === key) report(undefined);
        return result;
      } catch (error) {
        if (input.key === key) {
          const outcome = classifyConsoleKeyError(error);
          // A command's ciphertext rejected for itself (tampered) says nothing about the key.
          if (outcome !== 'usable') report(consoleKeyNote(runtime, outcome, key, errorText(error)));
        }
        throw error;
      }
    },
  };
}

/** Runs `ensure` once; a failure (crypto's database down at boot) is retried by the next call. */
function once(ensure: () => Promise<unknown>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () => {
    pending ??= ensure().then(
      () => undefined,
      (error: unknown) => {
        pending = undefined;
        throw error;
      },
    );
    return pending;
  };
}

/** Reports, once per runtime (retried after a failure), what boot says about the console key. */
const reports = new WeakMap<
  object,
  Promise<{ level: 'info' | 'warn'; line: string } | undefined>
>();

/**
 * The console key at boot, as one log line (or none when it is simply there): created, or missing
 * with the exact command to run, or not checkable. Embedded crypto creates it; a crypto tenant is
 * checked with {@link checkTenantConsoleKey}. Never throws: commands fail until it is fixed.
 */
export function consoleKeyReport(
  runtime: CryptoRuntimeLike,
): Promise<{ level: 'info' | 'warn'; line: string } | undefined> {
  let pending = reports.get(runtime);
  if (!pending) {
    pending = runtime.service
      ? ensureEmbedded(runtime.service, runtime.partition, CONSOLE_CRYPTO_KEY).then(
          (result) => (result === 'created' ? consoleKeyNote(runtime, 'created') : undefined),
          (error: unknown) => {
            reports.delete(runtime);
            return { level: 'warn' as const, line: errorText(error) };
          },
        )
      : checkTenantConsoleKey(runtime).then((report) => {
          if (report?.level === 'warn') reports.delete(runtime);
          return report;
        });
    reports.set(runtime, pending);
  }
  return pending;
}

/**
 * The owning app's cipher in automatic crypto mode: its own operations (it decrypts with the key in
 * its own partition). Where crypto is embedded here, the key is created on first use.
 */
export function appConsoleCipher(
  runtime: CryptoRuntimeLike,
  /** A crypto tenant's watched decrypt ({@link watchTenantConsoleKey}). */
  decrypt: CryptoRuntimeLike['operations']['decrypt'] = (input) =>
    runtime.operations.decrypt(input),
): ConsoleCipher {
  const ready = () =>
    runtime.service ? ensureConsoleKey(runtime).catch(() => undefined) : Promise.resolve();
  return {
    encrypt: async (input) => {
      await ready();
      return runtime.operations.encrypt(input);
    },
    decrypt: async (input) => {
      await ready();
      return decrypt(input);
    },
  };
}

/**
 * The console's cipher for the federated app whose crypto partition is `partition`. Encrypt-only:
 * the console never opens a command.
 *
 * - Crypto embedded in the console's app (the Agora Hub): as `media:console`, with nothing but
 *   `crypto:encrypt:console-media` on that partition; the key is created there on first use.
 * - Crypto in another app (the console is a crypto tenant): through the console's own crypto channel,
 *   asking the server to seal with `partition`'s key (its client needs `crypto:seal:console-*`).
 */
export function consoleSideCipher(
  runtime: CryptoRuntimeLike,
  partition: string,
  key: string = CONSOLE_CRYPTO_KEY,
): ConsoleCipher {
  const service = runtime.service;
  return {
    encrypt: async (input) => {
      if (input.key !== key) throw new Error(`the console only encrypts with "${key}"`);
      if (service) {
        await ensureConsoleKey(runtime, partition, key);
        return service.encrypt(
          { partition, capabilities: [`crypto:encrypt:${key}`], actor: CRYPTO_ACTOR },
          {
            key,
            plaintext: input.plaintext,
            ...(input.aad !== undefined ? { aad: input.aad } : {}),
          },
        );
      }
      try {
        return await runtime.operations.encrypt({
          key,
          plaintext: input.plaintext,
          ...(input.aad !== undefined ? { aad: input.aad } : {}),
          ...(input.context !== undefined ? { context: input.context } : {}),
          partition,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `the crypto server did not seal for "${partition}" (${message}): grant this app's crypto client crypto:seal:console-*, upgrade @adonis-agora/crypto on the crypto server if it does not know \`partition\`, or set controlPlane.crypto explicitly`,
        );
      }
    },
    decrypt: async () => {
      throw new Error('the console never opens commands');
    },
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The owning app (answers commands)                                                             */
/* -------------------------------------------------------------------------------------------- */

/** An explicit crypto cipher (a crypto client, a KMS of your own). */
export interface ExplicitConsoleCrypto {
  cipher: ConsoleCipherSource;
  key?: string | undefined;
  /** Whether a ciphertext is this cipher's. Default: `agora:ct1:<key>:` (crypto's format). */
  owns?: ((ciphertext: string) => boolean) | undefined;
}

/** `consoleCommands`, as far as authentication goes. */
export interface AppConsoleAuthConfig {
  prefix: string;
  verifyTenant?: TenantVerifierInput | false | undefined;
  partition?: string | undefined;
  crypto?: ExplicitConsoleCrypto | false | undefined;
  secret?: ChannelSecret | undefined;
}

/** How the owning app answers, once resolved. */
export interface ResolvedAppConsoleAuth {
  /** The channel's authentication options (without `client` and `prefix`). */
  channel: ConsoleChannelAuthOptions;
  /** This app's name as a classic (service-tenant) token must name it. */
  partition: string;
  /** Each way commands are accepted, for the boot log and the doctor. */
  modes: string[];
  /** Token mode without crypto: the key pair the console seals to (its public half is printed). */
  keys?: ConsoleCommandKeys | undefined;
  /** The crypto in use: automatic (this app's runtime) or the configured cipher. */
  crypto?: { auto: boolean; key: string; cipher: ConsoleCipherSource } | undefined;
  /** Automatic crypto on a crypto tenant: checks the key once at boot (see watchTenantConsoleKey). */
  checkKey?: (() => Promise<void>) | undefined;
}

/** `consoleCommands` is on, but no authentication resolves: the boot error says what to add. */
export class ConsoleAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsoleAuthConfigError';
  }
}

function secretLength(secret: ChannelSecret): number {
  const raw = typeof secret === 'string' ? secret : secret?.release?.();
  return typeof raw === 'string' ? raw.length : 0;
}

/**
 * Resolve how this app authenticates the commands of other apps' consoles. Explicit options win
 * (`crypto`, `secret`, `verifyTenant`) and nothing automatic is added to them. With none:
 * `@adonis-agora/crypto` booted here seals commands (key `console-media` in this app's partition),
 * authkit's calls between apps (or a control plane's own `verifyTenant`) checks the token they carry,
 * and, with an `APP_KEY`, tokens sealed to the APP_KEY-derived key are accepted too.
 * Throws a {@link ConsoleAuthConfigError} when nothing resolves.
 */
export function resolveAppConsoleAuth(input: {
  options: AppConsoleAuthConfig;
  /** A control plane's own `verifyTenant` (used when `consoleCommands.verifyTenant` is not set). */
  controlPlaneVerifyTenant?: TenantVerifierInput | undefined;
  appKey: string | undefined;
  siblings: ConsoleSiblings;
  /** Logs the console key's state on a crypto tenant (automatic mode); see watchTenantConsoleKey. */
  logKey?: ((note: { level: 'info' | 'warn'; line: string }) => void) | undefined;
}): ResolvedAppConsoleAuth {
  const { options, appKey } = input;
  const runtime = input.siblings.crypto;
  const explicitCrypto =
    options.crypto && typeof options.crypto === 'object' ? options.crypto : undefined;
  if (explicitCrypto && explicitCrypto.cipher === undefined) {
    throw new ConsoleAuthConfigError(
      `[${PACKAGE}] consoleCommands.crypto needs a \`cipher\` (e.g. \`() => crypto.client!\`), or remove it to let @adonis-agora/crypto be picked up automatically`,
    );
  }
  if (options.secret !== undefined && secretLength(options.secret) < 16) {
    throw new ConsoleAuthConfigError(
      `[${PACKAGE}] consoleCommands.secret must be at least 16 characters (the same value as the console's controlPlane.secret)`,
    );
  }
  const explicitVerifier = options.verifyTenant ? options.verifyTenant : undefined;
  const explicit =
    explicitCrypto !== undefined || options.secret !== undefined || explicitVerifier !== undefined;
  // Tokens: an explicit verifier only; else authkit's app-call verifier and a control plane's own.
  // Only an explicit `verifyTenant` (or `verifyTenant: false`) turns those fallbacks off: an
  // explicit `crypto` or `secret` does not (a token sent with them is still checked).
  const fallbacks = explicitVerifier === undefined && options.verifyTenant !== false;
  const verifyTenant = explicitVerifier ?? (fallbacks ? input.controlPlaneVerifyTenant : undefined);
  const verifyAppCall = fallbacks ? appCallVerifierOf(input.siblings.authkit) : undefined;
  const autoCrypto = !explicit && options.crypto !== false ? runtime : undefined;
  // Never "any partition": a classic token must name this app. Its crypto partition when known.
  const partition = options.partition ?? runtime?.partition ?? options.prefix;

  const modes: string[] = [];
  let crypto: ResolvedAppConsoleAuth['crypto'];
  let watch: ReturnType<typeof watchTenantConsoleKey> | undefined;
  // The labels every Agora lib logs (§11).
  const tokenKinds = [
    ...(explicitVerifier !== undefined ? ['verifyTenant'] : []),
    ...(verifyAppCall ? ['authkit app-call, auto'] : []),
    ...(explicitVerifier === undefined && verifyTenant !== undefined
      ? ["the control plane's verifyTenant"]
      : []),
  ].join(', ');
  const tokenLabel = explicitVerifier
    ? ` + token required (${tokenKinds})`
    : tokenKinds
      ? ` + token checked when sent (${tokenKinds})`
      : '';
  if (explicitCrypto) {
    const key = explicitCrypto.key ?? CONSOLE_CRYPTO_KEY;
    crypto = { auto: false, key, cipher: explicitCrypto.cipher };
    modes.push(`crypto (key ${key})${tokenLabel}`);
  } else if (autoCrypto) {
    watch =
      !autoCrypto.service && input.logKey
        ? watchTenantConsoleKey(autoCrypto, input.logKey)
        : undefined;
    crypto = {
      auto: true,
      key: CONSOLE_CRYPTO_KEY,
      cipher: appConsoleCipher(autoCrypto, watch?.decrypt),
    };
    modes.push(`crypto (auto, key ${CONSOLE_CRYPTO_KEY})${tokenLabel}`);
  }

  // Token mode, sealed to the APP_KEY-derived key: alongside crypto too (a migration path).
  let keys: ConsoleCommandKeys | undefined;
  if ((verifyTenant !== undefined || verifyAppCall !== undefined) && appKey) {
    keys = consoleCommandKeys(appKey, options.prefix);
    // A short id only: `node ace media:console-key` prints the key itself.
    modes.push(`token (${tokenKinds}; sealed to key ${shortKeyId(keys.publicKey)})`);
  }
  if (options.secret !== undefined) modes.push('secret');

  if (modes.length === 0) {
    // Why the automatic modes did not apply, after the uniform message.
    const notes = [
      ...((verifyTenant !== undefined || verifyAppCall !== undefined) && !appKey
        ? [
            `a token verifier is available (${tokenKinds}), but token mode needs an APP_KEY (commands are sealed to a key derived from it)`,
          ]
        : []),
      ...(options.crypto === false ? ['`crypto: false` turned the automatic crypto mode off'] : []),
    ];
    throw new ConsoleAuthConfigError(
      `[${PACKAGE}] consoleCommands needs authentication: install and boot @adonis-agora/crypto in this app (automatic, key ${CONSOLE_CRYPTO_KEY}), or configure authkit-client's \`service\` (automatic: the console uses an authkit app-call token; grant it media:console:* on this app), or set consoleCommands.secret (shared with the console), or consoleCommands.verifyTenant (your own verifier; needs an APP_KEY). ${DOCTOR_HINT} Docs: ${CONSOLE_AUTH_DOCS}${notesOf(notes)}`,
    );
  }

  return {
    channel: {
      ...(options.secret !== undefined ? { secret: options.secret } : {}),
      ...(crypto
        ? {
            crypto: {
              cipher: crypto.cipher,
              key: crypto.key,
              ...(explicitCrypto?.owns ? { owns: explicitCrypto.owns } : {}),
            },
          }
        : {}),
      ...(verifyTenant !== undefined ? { verifyTenant, partition } : { partition }),
      ...(verifyAppCall ? { verifyAppCall } : {}),
      ...(keys ? { keys } : {}),
      // Explicit crypto + explicit verifyTenant: every crypto command carries a token too.
      cryptoRequiresToken: explicitCrypto !== undefined && explicitVerifier !== undefined,
    },
    partition,
    modes,
    ...(keys ? { keys } : {}),
    ...(crypto ? { crypto } : {}),
    ...(watch ? { checkKey: watch.atBoot } : {}),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* The console (sends commands)                                                                  */
/* -------------------------------------------------------------------------------------------- */

/** A federated app's `controlPlane`, as far as authentication goes. */
export interface ConsoleSideAuthConfig {
  secret?: ChannelSecret | undefined;
  token?: TenantTokenSource | false | undefined;
  publicKey?: string | (() => string | Promise<string>) | undefined;
  crypto?: ExplicitConsoleCrypto | false | undefined;
}

/** How the console signs its commands to one federated app, once resolved. */
export interface ResolvedConsoleSideAuth {
  /** The channel's authentication options (without `client` and `prefix`), or none. */
  channel: ConsoleChannelAuthOptions;
  /** How, for the boot log and the doctor; `undefined` when nothing resolves. */
  mode: string | undefined;
  /** Automatic crypto: the partition the key lives in (the app's crypto partition). */
  autoPartition?: string | undefined;
}

/**
 * Resolve how this console authenticates its commands to the federated app whose name (and crypto
 * partition) is `partition`. Explicit options win; with none, the siblings decide: crypto seals
 * with `console-media` in `partition` (embedded here, or through this app's crypto channel), and
 * authkit adds this app's app-call token for that app.
 */
export function resolveConsoleSideAuth(input: {
  plane: ConsoleSideAuthConfig | RedisConsoleChannel;
  partition: string;
  siblings: ConsoleSiblings;
  /** The entry's key in `apps`, for the messages. Default: `partition`. */
  app?: string | undefined;
  /** Where the console's warnings go (a token skipped in crypto mode, §13b). */
  log?: ((level: 'info' | 'warn', line: string) => void) | undefined;
}): ResolvedConsoleSideAuth {
  const { plane, partition } = input;
  const { crypto: runtime, authkit } = input.siblings;
  const app = input.app ?? partition;
  const grantHint = `To attach it: grant the console's service client media:console:* on "${app}" in authkit.`;
  // Crypto mode with the automatic token: the token is optional there (§2c, §13b).
  // A missing grant is expected while an app is being set up (info); anything else is a warning.
  const tokenOptional = (reason: string, code?: string) =>
    input.log?.(
      code === 'invalid_target' || /invalid_target|not granted|no grant/i.test(reason)
        ? 'info'
        : 'warn',
      `[${PACKAGE}] console commands to "${app}": sending without an authkit app-call token (crypto only): ${reason}. ${grantHint}`,
    );
  if (plane instanceof RedisConsoleChannel) {
    return { channel: {}, mode: plane.signed ? 'a channel of its own' : undefined };
  }
  const crypto = plane.crypto && typeof plane.crypto === 'object' ? plane.crypto : undefined;
  const explicitToken = plane.token ? plane.token : undefined;
  const explicit =
    crypto !== undefined || plane.secret !== undefined || explicitToken !== undefined;
  // Authkit's app-call token, automatic: no explicit `token`, not `token: false`, no `secret`
  // (with an explicit `crypto` too).
  const autoToken =
    explicitToken === undefined &&
    plane.token !== false &&
    plane.secret === undefined &&
    authkit &&
    hasAppCallTokens(authkit)
      ? appCallToken(authkit, partition)
      : undefined;
  if (explicit) {
    // Token without crypto: sealed to the app's key, from this config or authkit's key directory.
    const recipient =
      plane.publicKey ??
      (!crypto && explicitToken !== undefined && authkit && hasKeyDirectory(authkit)
        ? directoryRecipient(authkit, partition)
        : undefined);
    const mode = crypto
      ? `crypto (key ${crypto.key ?? CONSOLE_CRYPTO_KEY})${explicitToken ? ' + token' : autoToken ? ' + token (authkit app-call, auto)' : ''}`
      : explicitToken !== undefined && recipient !== undefined
        ? plane.publicKey !== undefined
          ? `token (explicit publicKey${keyIdOf(plane.publicKey)})`
          : 'token (controlPlane.token, authkit key directory; sealed to the key the app publishes)'
        : plane.secret !== undefined
          ? 'secret'
          : undefined;
    return {
      channel: {
        ...(plane.secret !== undefined ? { secret: plane.secret } : {}),
        ...(crypto ? { crypto } : {}),
        ...(explicitToken !== undefined
          ? { token: explicitToken }
          : crypto && autoToken
            ? { token: autoToken, tokenOptional, tokenHint: grantHint }
            : {}),
        // The app's APP_KEY-derived key, from this console's own config: only needed without
        // crypto, and never taken from Redis.
        ...(recipient !== undefined && !crypto ? { recipient } : {}),
      },
      mode,
    };
  }
  const autoCrypto = plane.crypto !== false ? runtime : undefined;
  const token = autoToken;
  const cryptoLabel = `crypto (auto, key ${CONSOLE_CRYPTO_KEY}, partition ${partition})`;
  // Both ways possible (§13a): the app's key in authkit's directory means it runs token mode (an
  // app publishes only then), so the token way; else crypto. Lazily, per app, cached.
  if (autoCrypto && token && plane.publicKey === undefined && authkit && hasKeyDirectory(authkit)) {
    return {
      channel: {
        crypto: { cipher: consoleSideCipher(autoCrypto, partition), key: CONSOLE_CRYPTO_KEY },
        token,
        tokenOptional,
        tokenHint: grantHint,
        recipient: directoryRecipient(authkit, partition),
        chooser: directoryChooser(authkit, partition),
      },
      mode: `auto (authkit key directory if the app publishes one, else ${cryptoLabel})`,
      autoPartition: partition,
    };
  }
  if (autoCrypto) {
    return {
      channel: {
        crypto: { cipher: consoleSideCipher(autoCrypto, partition), key: CONSOLE_CRYPTO_KEY },
        ...(token ? { token, tokenOptional, tokenHint: grantHint } : {}),
      },
      mode: `${cryptoLabel}${token ? ' + token (authkit app-call, auto)' : ''}`,
      autoPartition: partition,
    };
  }
  if (token && plane.publicKey !== undefined) {
    return {
      channel: { token, recipient: plane.publicKey, tokenHint: grantHint },
      mode: `token (authkit app-call, auto, explicit publicKey${keyIdOf(plane.publicKey)})`,
    };
  }
  // authkit without crypto: the app-call token, sealed to the key the app published in authkit.
  if (token && authkit && hasKeyDirectory(authkit)) {
    return {
      channel: { token, recipient: directoryRecipient(authkit, partition), tokenHint: grantHint },
      mode: 'token (authkit app-call, auto, authkit key directory; sealed to the key the app publishes)',
    };
  }

  return { channel: {}, mode: undefined };
}

/** The boot error (or warning) for a federated app the console cannot authenticate to. */
export function consoleSideAuthMessage(
  key: string,
  siblings: ConsoleSiblings = {},
  plane: ConsoleSideAuthConfig | RedisConsoleChannel | undefined = undefined,
): string {
  const entry = `media_dashboard.apps["${key}"]`;
  const options = plane instanceof RedisConsoleChannel ? undefined : plane;
  const notes = [
    ...(options?.crypto === false ? ['`crypto: false` turned the automatic crypto mode off'] : []),
    ...(options?.token === false ? ['`token: false` turned the automatic authkit token off'] : []),
    ...(options?.token !== false &&
    siblings.authkit &&
    hasAppCallTokens(siblings.authkit) &&
    !hasKeyDirectory(siblings.authkit)
      ? [
          `authkit's app-call token is available, but without crypto it must be sealed to the app's key: set ${entry}.controlPlane.publicKey (\`node ace media:console-key\` on that app prints it)`,
        ]
      : []),
  ];
  return `[${PACKAGE}] ${entry}: commands to this app need authentication: boot @adonis-agora/crypto in this app (automatic), or set ${entry}.controlPlane.secret, or ${entry}.controlPlane.token — or actions: false to only browse it. ${DOCTOR_HINT}${notesOf(notes)}`;
}
