import type { ApplicationService } from '@adonisjs/core/types';
import { accountCollections } from '../account_console/extension.js';
import { resolveMediaTenancy } from '../agora/tenancy.js';
import { assertMediaTopology, type MediaConfig } from '../define_config.js';
import {
  ConsoleAuthConfigError,
  type ConsoleSiblings,
  checkTenantConsoleKey,
  classifyConsoleKeyError,
  consoleSiblingsOf,
  consoleSideAuthMessage,
  consoleSideCipher,
  createKeyCommand,
  ensureConsoleKey,
  resolveAppConsoleAuth,
  resolveConsoleSideAuth,
} from '../federation/console_auth.js';
import { appKeyOf, CONSOLE_CRYPTO_KEY } from '../federation/redis_channel.js';
import { DEFAULT_CONTROL_PLANE_PREFIX, MEDIA_SCOPES } from '../topology/protocol.js';
import { type MediaTenantClient, tenantClientOf } from '../topology/tenant_client.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/media';

type AnyConfig = Record<string, unknown>;

/** Drive's disks as boot resolves them: the default name and the service names. */
export interface DriveDisks {
  default?: string;
  services: string[];
}

/**
 * Resolve `config/drive.ts` the way the media provider does at boot: Drive's `defineConfig()`
 * returns a config provider, a hand-rolled config is a plain `{ default, services }`. `null` when
 * there is no Drive config, `'unknown'` when it cannot be resolved.
 */
export async function resolveDriveDisks(
  app: ApplicationService,
): Promise<DriveDisks | null | 'unknown'> {
  const value = app.config.get<unknown>('drive', undefined);
  if (value === undefined || value === null) return null;
  try {
    const { configProvider } = await import('@adonisjs/core');
    const resolved = (await configProvider.resolve<unknown>(app, value)) as {
      config?: { default?: string; services?: Record<string, unknown> };
      default?: string;
      services?: Record<string, unknown>;
    } | null;
    const config = resolved ? (resolved.config ?? resolved) : (value as unknown as typeof resolved);
    if (!config || typeof config !== 'object') return 'unknown';
    return {
      ...(typeof config.default === 'string' ? { default: config.default } : {}),
      services: Object.keys(config.services ?? {}),
    };
  } catch {
    return 'unknown';
  }
}

/** `media.disks`: every disk media writes to exists in `config/media.ts` `disks` or in Drive. */
export function checkDisks(
  media: MediaConfig | undefined,
  drive: DriveDisks | null | 'unknown',
): AgoraDoctorResult {
  if (media === undefined) {
    return { status: 'skip', message: 'config/media.ts is not present.' };
  }
  if (media.topology === 'tenant') {
    return {
      status: 'skip',
      message: 'A media tenant has no disk: its files live on the control plane.',
    };
  }
  if (drive === 'unknown') {
    return {
      status: 'skip',
      message: 'config/drive.ts could not be resolved, so the disks were not checked.',
    };
  }
  const known = new Set([...Object.keys(media.disks ?? {}), ...(drive?.services ?? [])]);
  const referenced = new Map<string, string>();
  const defaultDisk = media.disk ?? drive?.default;
  if (defaultDisk === undefined) {
    return {
      status: 'error',
      message: 'No default disk: config/media.ts sets no `disk` and Drive has no default.',
      fix: 'Set `disk` in config/media.ts, or `default` in config/drive.ts.',
      docs: `${DOCS}/configuration`,
    };
  }
  referenced.set(defaultDisk, media.disk !== undefined ? 'disk' : 'the Drive default');
  for (const collection of media.collections ?? []) {
    if (collection.disk) referenced.set(collection.disk, `collection "${collection.name}"`);
  }
  const resumableDisk = media.uploads?.resumable?.routes?.disk;
  if (resumableDisk) referenced.set(resumableDisk, 'uploads.resumable.routes.disk');
  const directDisk = media.uploads?.direct?.routes?.disk;
  if (directDisk) referenced.set(directDisk, 'uploads.direct.routes.disk');
  const missing = [...referenced].filter(([name]) => !known.has(name));
  if (missing.length === 0) {
    return {
      status: 'ok',
      message: `Every disk media uses exists (${[...referenced.keys()].join(', ')}).`,
    };
  }
  return {
    status: 'error',
    message: `Unknown disk${missing.length > 1 ? 's' : ''}: ${missing
      .map(([name, where]) => `"${name}" (${where})`)
      .join(', ')}.`,
    fix: 'Add the disk to `disks` in config/media.ts or to `services` in config/drive.ts.',
    docs: `${DOCS}/configuration`,
  };
}

/** `media.console-gate`: the media console has an `authorize`. */
export function checkConsoleGate(
  config: AnyConfig | undefined,
  inProduction: boolean,
): AgoraDoctorResult {
  if (config === undefined) {
    return {
      status: 'skip',
      message: 'config/media_dashboard.ts is not present: no media console.',
    };
  }
  if (config.enabled === false)
    return { status: 'skip', message: 'The media console is disabled.' };
  if (config.authorize !== undefined) {
    return { status: 'ok', message: 'The media console has an authorize.' };
  }
  return {
    status: inProduction ? 'error' : 'warn',
    message: inProduction
      ? 'The media console has no authorize: it denies every request in production.'
      : 'The media console has no authorize: it is open here and denies every request in production.',
    fix: "Set `authorize` in config/media_dashboard.ts (for example authorizeByToken({ token: env.get('CONSOLE_TOKEN') })).",
    docs: `${DOCS}/dashboard/authentication`,
  };
}

/** `media.account-console`: every collection the "My files" page lists exists and has rules. */
export function checkAccountConsole(media: MediaConfig | undefined): AgoraDoctorResult {
  const options = media?.accountConsole;
  if (!options) return { status: 'skip', message: 'The account console page is not configured.' };
  const listed = accountCollections(options);
  if (listed.length === 0) {
    return { status: 'skip', message: 'accountConsole lists no collection: nothing is exposed.' };
  }
  const defined = new Map((media?.collections ?? []).map((c) => [c.name, c]));
  const unknown = listed.filter((c) => !defined.has(c.name)).map((c) => c.name);
  const noRules = listed
    .filter((c) => defined.has(c.name) && !defined.get(c.name)?.access?.read)
    .map((c) => c.name);
  if (unknown.length === 0 && noRules.length === 0) {
    return {
      status: 'ok',
      message: `The account console shows ${listed.map((c) => c.name).join(', ')}.`,
    };
  }
  const parts = [
    ...(unknown.length > 0 ? [`not in \`collections\`: ${unknown.join(', ')}`] : []),
    ...(noRules.length > 0 ? [`no \`access.read\` (shows nothing): ${noRules.join(', ')}`] : []),
  ];
  return {
    status: 'warn',
    message: `accountConsole.collections: ${parts.join('; ')}.`,
    fix: 'Define each listed collection in `collections` with an `access` rule in config/media.ts.',
    docs: `${DOCS}/account-console`,
  };
}

/** `media.tenancy-schema` (deep): with tenancy on, the Lucid store has its `tenant_id` column. */
export async function checkTenancySchema(app: ApplicationService): Promise<AgoraDoctorResult> {
  const media = app.config.get<MediaConfig | undefined>('media', undefined);
  if (media === undefined) return { status: 'skip', message: 'config/media.ts is not present.' };
  if (!resolveMediaTenancy(media.tenancy).enabled) {
    return { status: 'skip', message: 'Tenancy is off for media.' };
  }
  const { MediaManager } = await import('../media_manager.js');
  const manager = await app.container.make(MediaManager);
  const store = manager.store as { hasTenantColumn?: () => Promise<boolean> };
  if (typeof store.hasTenantColumn !== 'function') {
    return { status: 'skip', message: 'The media store keeps no SQL table.' };
  }
  if (await store.hasTenantColumn()) {
    return { status: 'ok', message: 'The media table has its tenant_id column.' };
  }
  return {
    status: 'error',
    message: 'Tenancy is on but the media table has no tenant_id column: media queries fail.',
    fix: 'Run `node ace media:publish-migration tenancy` and `node ace migration:run`.',
    docs: `${DOCS}/tenancy`,
  };
}

/** A store `media.timestamps-schema` can probe (the Lucid upload-session store). */
interface UpdatedAtProbe {
  hasUpdatedAtColumn(): Promise<boolean>;
}

/**
 * `media.timestamps-schema` (deep): every Lucid upload-sessions store (resumable and direct) has its
 * `updated_at` column. Without it the store still works, but sessions show no "Updated" time.
 */
export async function checkTimestampsSchema(app: ApplicationService): Promise<AgoraDoctorResult> {
  const media = app.config.get<MediaConfig | undefined>('media', undefined);
  if (media === undefined) return { status: 'skip', message: 'config/media.ts is not present.' };
  const { resolveUploadSessionStore } = await import('../upload_sessions/factory.js');
  const tenancy = resolveMediaTenancy(media.tenancy).enabled ? { tenancy: true } : {};
  const probed: string[] = [];
  const missing: string[] = [];
  for (const [label, uploads] of [
    ['resumable upload sessions', media.uploads?.resumable],
    ['direct upload sessions', media.uploads?.direct],
  ] as const) {
    if (uploads?.store === undefined) continue;
    const store = (await resolveUploadSessionStore(uploads, {
      app,
      ...tenancy,
    })) as Partial<UpdatedAtProbe>;
    if (typeof store.hasUpdatedAtColumn !== 'function') continue;
    probed.push(label);
    if (!(await store.hasUpdatedAtColumn())) missing.push(label);
  }
  if (probed.length === 0) {
    return { status: 'skip', message: 'No upload sessions are stored in SQL.' };
  }
  if (missing.length === 0) {
    return {
      status: 'ok',
      message: `The ${probed.join(' and ')} ${probed.length > 1 ? 'tables have' : 'table has'} updated_at.`,
    };
  }
  return {
    status: 'warn',
    message: `The ${missing.join(' and ')} ${
      missing.length > 1 ? 'tables have' : 'table has'
    } no updated_at column: sessions show no "Updated" time.`,
    fix: 'Run `node ace media:publish-migration timestamps` and `node ace migration:run`.',
    docs: `${DOCS}/stores-and-processors`,
  };
}

/** A store `media.db-schema` can inspect (the Lucid media and upload-session stores). */
interface SchemaInspectable {
  inspectSchema(): Promise<{
    schema: string;
    exists: boolean;
    missingTables: string[];
    writeError: string | null;
  } | null>;
}

/** One store's schema state as doctor results (`[]` when the store has no schema). */
export async function checkStoreSchema(
  label: string,
  store: SchemaInspectable,
): Promise<AgoraDoctorResult[]> {
  const docs = `${DOCS}/stores-and-processors`;
  const found = await store.inspectSchema();
  if (found === null) return [];
  if (!found.exists) {
    return [
      {
        status: 'error',
        message: `${label}: the database schema "${found.schema}" does not exist (or this connection cannot see it).`,
        fix: `Run the media migrations, or create it: CREATE SCHEMA "${found.schema}" (MySQL: CREATE DATABASE).`,
        docs,
      },
    ];
  }
  const results: AgoraDoctorResult[] = [];
  if (found.missingTables.length > 0) {
    results.push({
      status: 'error',
      message: `${label}: missing from schema "${found.schema}": ${found.missingTables.join(', ')}.`,
      fix: 'Run the media migrations (node ace migration:run).',
      docs,
    });
  }
  if (found.writeError !== null) {
    results.push({
      status: 'error',
      message: `${label}: this connection cannot write to schema "${found.schema}": ${found.writeError.split('\n')[0]}`,
      fix: "Grant the app's role USAGE on the schema and INSERT, SELECT, DELETE on its tables.",
      docs,
    });
  }
  if (results.length === 0) {
    results.push({
      status: 'ok',
      message: `${label}: schema "${found.schema}" exists, holds the tables and takes writes.`,
    });
  }
  return results;
}

/**
 * `media.db-schema` (deep): every Lucid store configured with a `schema` (media, resumable and
 * direct upload sessions) finds its schema and tables and can write there. Builds fresh store
 * instances from the config; they query only when inspected.
 */
export async function checkDbSchema(app: ApplicationService): Promise<AgoraDoctorResult[]> {
  const media = app.config.get<MediaConfig | undefined>('media', undefined);
  if (media === undefined) return [];
  const { resolveStore } = await import('../stores/factory.js');
  const { resolveUploadSessionStore } = await import('../upload_sessions/factory.js');
  const tenancy = resolveMediaTenancy(media.tenancy).enabled ? { tenancy: true } : {};
  const results: AgoraDoctorResult[] = [];
  const inspect = async (label: string, build: () => Promise<unknown>) => {
    const store = (await build()) as Partial<SchemaInspectable>;
    if (typeof store.inspectSchema !== 'function') return;
    results.push(...(await checkStoreSchema(label, store as SchemaInspectable)));
  };
  if (media.store !== undefined && factorySchemaOf(media.stores?.[media.store]) !== undefined) {
    await inspect('media store', () => resolveStore(media, { app, ...tenancy }));
  }
  for (const [label, uploads] of [
    ['resumable upload sessions', media.uploads?.resumable],
    ['direct upload sessions', media.uploads?.direct],
  ] as const) {
    if (uploads?.store === undefined) continue;
    if (factorySchemaOf(uploads.stores?.[uploads.store]) === undefined) continue;
    await inspect(label, () => resolveUploadSessionStore(uploads, { app, ...tenancy }));
  }
  return results;
}

/** The schema a store factory was configured with (see `factorySchema` in `stores/factory.ts`). */
function factorySchemaOf(factory: unknown): string | undefined {
  const schema = (factory as { schema?: unknown } | undefined)?.schema;
  return typeof schema === 'string' ? schema : undefined;
}

/** Whether any Lucid store in `config/media.ts` is configured with a `schema`. */
export function hasConfiguredSchema(media: MediaConfig | undefined): boolean {
  if (media === undefined) return false;
  const named = (map: Record<string, unknown> | undefined, name: string | undefined) =>
    name !== undefined && factorySchemaOf(map?.[name]) !== undefined;
  return (
    named(media.stores, media.store) ||
    named(media.uploads?.resumable?.stores, media.uploads?.resumable?.store) ||
    named(media.uploads?.direct?.stores, media.uploads?.direct?.store)
  );
}

/**
 * The `media.db-schema` check. Registered at boot only when a store has a `schema` (so an app
 * without one sees no new line).
 */
export const dbSchemaDoctorCheck: AgoraDoctorCheck = {
  id: 'media.db-schema',
  lib: 'media',
  title: 'Database schema is ready',
  cost: 'deep',
  run: (app) => checkDbSchema(app),
};

/** Every media check, in report order. Ids are frozen for 1.x. */
/** `media.topology`: the topology in config/media.ts is one that can work. */
export function checkTopology(media: MediaConfig | undefined): AgoraDoctorResult {
  if (media === undefined) return { status: 'skip', message: 'config/media.ts is not present.' };
  try {
    assertMediaTopology(media);
  } catch (error) {
    return {
      status: 'error',
      message: (error as Error).message,
      fix: 'Fix the topology fields in config/media.ts.',
      docs: `${DOCS}/topology`,
    };
  }
  const topology = media.topology ?? 'standalone';
  if (topology === 'tenant') {
    const url = typeof media.tenant?.url === 'string' ? media.tenant.url : 'its discovered URL';
    return {
      status: 'ok',
      message: `Tenant "${media.tenant?.partition}": media lives on the control plane at ${url}.`,
    };
  }
  if (topology === 'control-plane') {
    const prefix = media.controlPlane?.prefix ?? DEFAULT_CONTROL_PLANE_PREFIX;
    const accounts = media.controlPlane?.accounts;
    return {
      status: 'ok',
      message: `Control plane: the tenant API is under ${prefix}/v1${
        accounts ? `, with account files in ${accounts.collections.join(', ')}` : ''
      }.`,
    };
  }
  const accounts = media.accounts;
  return {
    status: 'ok',
    message: `Standalone: this app keeps its own media${
      accounts
        ? `, and reads account files on the control plane at ${typeof accounts.url === 'string' ? accounts.url : 'its discovered URL'}`
        : ''
    }.`,
  };
}

/** What a control plane's `whoami` answers. */
interface Whoami {
  partition?: unknown;
  capabilities?: unknown;
  delivery?: unknown;
}

/**
 * `media.control-plane`: a tenant reaches its control plane, which accepts its token for its
 * partition with `media:read` and `media:write`.
 */
export async function checkControlPlane(
  media: MediaConfig | undefined,
  options: { fetch?: typeof fetch } = {},
): Promise<AgoraDoctorResult> {
  if (media?.topology !== 'tenant' || !media.tenant) {
    return { status: 'skip', message: 'This app is not a media tenant.' };
  }
  let client: MediaTenantClient;
  try {
    client = tenantClientOf(media, options);
  } catch (error) {
    return { status: 'error', message: (error as Error).message, docs: `${DOCS}/topology` };
  }
  let who: Whoami;
  try {
    who = await client.json<Whoami>('/whoami');
  } catch (error) {
    const failure = error as { status?: number; message?: string };
    if (failure.status === 401) {
      return {
        status: 'error',
        message: 'The media control plane refused this app’s token (401).',
        fix: 'Check the authkit client credentials of tenant.token, and that the client is registered for urn:agora:media.',
        docs: `${DOCS}/topology`,
      };
    }
    if (failure.status === 404) {
      return {
        status: 'error',
        message: `${client.url ?? 'The control plane'} has no media tenant API (404).`,
        fix: "Point tenant.url at the control plane's prefix (…/_media), and set topology: 'control-plane' there.",
        docs: `${DOCS}/topology`,
      };
    }
    return {
      status: 'error',
      message: `The media control plane did not answer: ${failure.message ?? 'unknown error'}.`,
      fix: 'Check tenant.url (or the issuer listing urn:agora:media) and that the control plane is up.',
      docs: `${DOCS}/topology`,
    };
  }
  const capabilities = Array.isArray(who.capabilities) ? (who.capabilities as string[]) : [];
  const partition = String(who.partition ?? '');
  const where = client.url ?? 'the control plane';
  if (partition !== media.tenant.partition) {
    return {
      status: 'error',
      message: `The token is for app "${partition}", not "${media.tenant.partition}": files would land in another app's partition.`,
      fix: 'Use this app’s own service client in tenant.token, or fix tenant.partition.',
      docs: `${DOCS}/topology`,
    };
  }
  const missing = [MEDIA_SCOPES.read, MEDIA_SCOPES.write].filter((c) => !capabilities.includes(c));
  if (missing.includes(MEDIA_SCOPES.read)) {
    return {
      status: 'error',
      message: `${where}: the token of ${partition} lacks ${missing.join(' and ')}.`,
      fix: `Grant the client ${missing.join(' and ')} on urn:agora:media.`,
      docs: `${DOCS}/topology`,
    };
  }
  if (missing.length > 0) {
    return {
      status: 'warn',
      message: `${where}: ${partition} may read but not write (no ${MEDIA_SCOPES.write}).`,
      fix: `Grant the client ${MEDIA_SCOPES.write} on urn:agora:media if this app adds or deletes files.`,
      docs: `${DOCS}/topology`,
    };
  }
  return {
    status: 'ok',
    message: `${where}: ${partition} with ${capabilities.join(', ')} (${
      who.delivery === 'proxy' ? 'bytes through the control plane' : 'storage URLs available'
    }).`,
  };
}

const CONSOLE_DOCS = `${DOCS}/dashboard/federated-console#authenticating-the-console`;

type DoctorApp = Pick<ApplicationService, 'config'> & { container: unknown };

/** The federated console's config of this app: its `consoleCommands` and its `apps` entries. */
function federationOf(app: DoctorApp) {
  const media = app.config.get<MediaConfig | undefined>('media', undefined);
  const dashboard = app.config.get<AnyConfig | undefined>('media_dashboard', undefined);
  const apps = Object.entries((dashboard?.apps ?? {}) as Record<string, AnyConfig>).filter(
    ([, entry]) => entry && typeof entry === 'object' && 'controlPlane' in entry,
  );
  return { media, consoleCommands: media?.consoleCommands, apps };
}

async function siblingsFor(app: DoctorApp, given?: ConsoleSiblings): Promise<ConsoleSiblings> {
  return (
    given ?? (await consoleSiblingsOf(app.container as never).catch((): ConsoleSiblings => ({})))
  );
}

async function appSideAuth(app: DoctorApp, siblings: ConsoleSiblings) {
  const { media, consoleCommands } = federationOf(app);
  return resolveAppConsoleAuth({
    options: consoleCommands!,
    controlPlaneVerifyTenant: media?.topology === 'control-plane' ? media.verifyTenant : undefined,
    appKey: await appKeyOf(app),
    siblings,
  });
}

/**
 * `media.console-commands`: how each side of the federated console authenticates, exactly as boot
 * resolves it. The owning app (`consoleCommands`): the modes it accepts, an error when none (it
 * fails to boot). The console (`media_dashboard.apps`): how it signs to each app; one it cannot
 * authenticate to is an error when the entry may run actions (the default, a boot error) and a
 * warning when it is browse-only (`actions: false`).
 */
export async function checkConsoleCommands(
  app: DoctorApp,
  options: { siblings?: ConsoleSiblings } = {},
): Promise<AgoraDoctorResult[]> {
  const { consoleCommands, apps } = federationOf(app);
  if (!consoleCommands && apps.length === 0) {
    return [{ status: 'skip', message: 'No federated media console (consoleCommands, apps).' }];
  }
  const siblings = await siblingsFor(app, options.siblings);
  const results: AgoraDoctorResult[] = [];
  if (consoleCommands) {
    try {
      const auth = await appSideAuth(app, siblings);
      results.push({
        status: 'ok',
        // The boot log's sentence.
        message: `console commands: ${auth.modes.join(' + ')}; ${
          consoleCommands.actions === true
            ? 'actions on'
            : 'actions off (set consoleCommands.actions to let the console act)'
        }`,
        docs: CONSOLE_DOCS,
      });
      // §13e: with crypto the token key is not published, and that is fine.
      if (auth.keys && auth.crypto && auth.channel.cryptoRequiresToken !== true) {
        results.push({
          status: 'ok',
          message:
            "console commands: this app's token key is not published: crypto is enough to reach it.",
        });
      }
    } catch (error) {
      results.push({
        status: 'error',
        message:
          error instanceof ConsoleAuthConfigError
            ? 'consoleCommands has no authentication: the app fails to boot.'
            : `consoleCommands: ${error instanceof Error ? error.message : String(error)}`,
        fix: 'Install @adonis-agora/crypto (automatic), or set `secret` or `verifyTenant` in consoleCommands.',
        docs: CONSOLE_DOCS,
      });
    }
  }
  for (const [key, entry] of apps) {
    const { mode } = resolveConsoleSideAuth({
      plane: entry.controlPlane as never,
      partition: typeof entry.partition === 'string' ? entry.partition : key,
      siblings,
    });
    if (mode) {
      results.push({
        status: 'ok',
        message: `console commands to "${key}": ${mode}`,
        docs: CONSOLE_DOCS,
      });
      continue;
    }
    const acts = entry.actions !== false;
    results.push({
      status: acts ? 'error' : 'warn',
      message: acts
        ? `The console cannot authenticate its commands to "${key}": the app fails to boot.`
        : `The console cannot authenticate its commands to "${key}" (browse-only: its disks and file URLs answer 503).`,
      fix: consoleSideAuthMessage(key, siblings, entry.controlPlane as never).replace(
        /^\[@adonis-agora\/media\] /,
        '',
      ),
      docs: CONSOLE_DOCS,
    });
  }
  return results;
}

/**
 * `media.console-commands-key` (deep), each side. The owning app (`consoleCommands`), in crypto
 * mode: the key exists and this process can use it (a probe; a crypto tenant is checked the way its
 * decrypt-only grant allows). The console (`media_dashboard.apps`), in automatic crypto mode: for
 * each app, the key in that app's partition exists (created here when crypto is embedded) and this
 * console can encrypt with it.
 */
export async function checkConsoleCommandsKey(
  app: DoctorApp,
  options: { siblings?: ConsoleSiblings } = {},
): Promise<AgoraDoctorResult[]> {
  const { consoleCommands, apps } = federationOf(app);
  if (!consoleCommands && apps.length === 0) {
    return [{ status: 'skip', message: 'No federated media console (consoleCommands, apps).' }];
  }
  const siblings = await siblingsFor(app, options.siblings);
  const results: AgoraDoctorResult[] = [];
  if (consoleCommands) results.push(await appSideKeyCheck(app, siblings));
  for (const [key, entry] of apps) {
    const partition = typeof entry.partition === 'string' ? entry.partition : key;
    const side = resolveConsoleSideAuth({
      plane: entry.controlPlane as never,
      partition,
      siblings,
    });
    const runtime = siblings.crypto;
    if (side.autoPartition === undefined || !runtime) {
      results.push({
        status: 'skip',
        message: `Commands to "${key}" are not sealed with the automatic crypto key.`,
      });
      continue;
    }
    const who = `The console, for "${key}"`;
    try {
      if (runtime.service) await ensureConsoleKey(runtime, partition);
      const cipher = consoleSideCipher(runtime, partition);
      const aad = 'agora:doctor:console-media';
      const { ciphertext } = await cipher.encrypt({
        key: CONSOLE_CRYPTO_KEY,
        plaintext: 'probe',
        aad,
      });
      let decrypted = false;
      if (runtime.service) {
        const { plaintext } = await runtime.service.decrypt(
          {
            partition,
            capabilities: [`crypto:decrypt:${CONSOLE_CRYPTO_KEY}`],
            actor: 'media:doctor',
          },
          { key: CONSOLE_CRYPTO_KEY, ciphertext, aad },
        );
        if (plaintext !== 'probe')
          throw new Error('the probe did not decrypt to what was encrypted');
        decrypted = true;
      }
      results.push({
        status: 'ok',
        message: `${who}: "${CONSOLE_CRYPTO_KEY}" ${decrypted ? 'encrypts and decrypts' : 'encrypts'} in partition ${partition}.`,
        docs: CONSOLE_DOCS,
      });
    } catch (error) {
      results.push({
        status: 'error',
        message: `${who}: the key "${CONSOLE_CRYPTO_KEY}" does not work in partition ${partition}: ${errorMessage(error).replace(/^\[@adonis-agora\/media\] /, '')}`,
        fix: `Run \`${createKeyCommand(partition)}\` on the crypto server${runtime.service ? '' : ", grant this app's crypto client crypto:seal:console-*"}, and check media_dashboard.apps["${key}"].partition equals that app's crypto partition.`,
        docs: CONSOLE_DOCS,
      });
    }
  }
  return results;
}

/**
 * `media.console-commands-key` (deep): in crypto mode, that the key exists and this process can
 * use it: a probe encrypted and decrypted (where crypto is embedded, the key is created first). A
 * crypto tenant may only decrypt its own console keys (no grant needed): checked that way.
 */
async function appSideKeyCheck(
  app: DoctorApp,
  siblings: ConsoleSiblings,
): Promise<AgoraDoctorResult> {
  let crypto: Awaited<ReturnType<typeof appSideAuth>>['crypto'];
  try {
    crypto = (await appSideAuth(app, siblings)).crypto;
  } catch {
    return {
      status: 'skip',
      message: 'consoleCommands has no authentication (see media.console-commands).',
    };
  }
  if (!crypto) return { status: 'skip', message: 'Console commands are not sealed with crypto.' };
  const runtime = siblings.crypto;
  // A crypto tenant: checked with a dummy decrypt (an app opens its own console keys; never `getKey`).
  if (crypto.auto && runtime && !runtime.service) {
    const report = await checkTenantConsoleKey(runtime);
    if (report?.level === 'warn') {
      return {
        status: 'error',
        message: report.line.replace(/^\[@adonis-agora\/media\] /, ''),
        docs: CONSOLE_DOCS,
      };
    }
    // Missing on a tenant is fine: the crypto server provisions it on the console's first seal.
    return {
      status: 'ok',
      message: report
        ? report.line.replace(/^\[@adonis-agora\/media\] /, '')
        : `The key ${crypto.key} exists in partition ${runtime.partition}.`,
      docs: CONSOLE_DOCS,
    };
  }
  try {
    if (crypto.auto && runtime) await ensureConsoleKey(runtime);
  } catch (error) {
    return {
      status: 'error',
      message: errorMessage(error).replace(/^\[@adonis-agora\/media\] /, ''),
      ...(runtime
        ? {
            fix: `Run \`${createKeyCommand(runtime.partition, crypto.key)}\` on the crypto server.`,
          }
        : {}),
      docs: CONSOLE_DOCS,
    };
  }
  try {
    const cipher = typeof crypto.cipher === 'function' ? await crypto.cipher() : crypto.cipher;
    const probe = `agora:doctor:${Date.now()}`;
    const aad = 'agora:doctor:console-media';
    const { ciphertext } = await cipher.encrypt({ key: crypto.key, plaintext: probe, aad });
    const { plaintext } = await cipher.decrypt({
      key: crypto.key,
      ciphertext,
      aad,
      context: 'doctor',
    });
    if (plaintext !== probe) throw new Error('the probe did not round-trip');
    return {
      status: 'ok',
      message: `The key ${crypto.key} encrypts and decrypts here.`,
      docs: CONSOLE_DOCS,
    };
  } catch (error) {
    // A crypto tenant opens its own console keys but cannot encrypt a probe: that is the setup.
    if (classifyConsoleKeyError(error) === 'refused' && runtime && !runtime.service) {
      return {
        status: 'ok',
        message: `This app decrypts with "${crypto.key}" (no grant needed); the probe cannot encrypt with it.`,
        docs: CONSOLE_DOCS,
      };
    }
    return {
      status: 'warn',
      message: `A probe with the key ${crypto.key} did not round-trip (${errorMessage(error)}).`,
      fix: "Check this app's crypto client: an app opens its own console-* keys with no grant (a crypto:decrypt:console-* grant is harmless if present).",
      docs: CONSOLE_DOCS,
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const mediaDoctorChecks: AgoraDoctorCheck[] = [
  {
    id: 'media.disks',
    lib: 'media',
    title: 'Disks exist',
    run: async (app) =>
      checkDisks(
        app.config.get<MediaConfig | undefined>('media', undefined),
        await resolveDriveDisks(app),
      ),
  },
  {
    id: 'media.console-gate',
    lib: 'media',
    title: 'Console access in production',
    run: (app) =>
      checkConsoleGate(
        app.config.get<AnyConfig | undefined>('media_dashboard', undefined),
        app.inProduction === true,
      ),
  },
  {
    id: 'media.account-console',
    lib: 'media',
    title: 'Account console collections',
    run: (app) => checkAccountConsole(app.config.get<MediaConfig | undefined>('media', undefined)),
  },
  {
    id: 'media.tenancy-schema',
    lib: 'media',
    title: 'Tenant column present',
    cost: 'deep',
    run: (app) => checkTenancySchema(app),
  },
  {
    id: 'media.timestamps-schema',
    lib: 'media',
    title: 'Upload sessions have updated_at',
    cost: 'deep',
    run: (app) => checkTimestampsSchema(app),
  },
  {
    id: 'media.topology',
    lib: 'media',
    title: 'Topology',
    run: (app) => checkTopology(app.config.get<MediaConfig | undefined>('media', undefined)),
  },
  {
    id: 'media.control-plane',
    lib: 'media',
    title: 'Control plane reachable and token accepted',
    cost: 'deep',
    run: (app) => checkControlPlane(app.config.get<MediaConfig | undefined>('media', undefined)),
  },
  {
    id: 'media.console-commands',
    lib: 'media',
    title: 'Console commands authenticated',
    run: (app) => checkConsoleCommands(app),
  },
  {
    id: 'media.console-commands-key',
    lib: 'media',
    title: 'Console commands crypto key usable',
    cost: 'deep',
    run: (app) => checkConsoleCommandsKey(app),
  },
];
