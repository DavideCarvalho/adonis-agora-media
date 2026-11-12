import type { ApplicationService } from '@adonisjs/core/types';
import { accountCollections } from '../account_console/extension.js';
import { resolveMediaTenancy } from '../agora/tenancy.js';
import type { MediaConfig } from '../define_config.js';
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

/** Every media check, in report order. Ids are frozen for 1.x. */
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
];
