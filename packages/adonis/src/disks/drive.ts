import { DriveNotReadyError } from '../errors.js';
import type { Disk, DiskResolver } from '../types.js';

/** The minimal Drive manager surface we use: `use(name)` returns a disk. */
export interface DriveManagerLike {
  use(name?: string): Disk;
}

/**
 * The module namespace of `@adonisjs/drive/services/main`, narrowed to what we read.
 *
 * `default` is deliberately typed as possibly-`undefined` and deliberately read as a PROPERTY rather
 * than destructured: Drive's service module is
 *
 * ```ts
 * var drive
 * await app.booted(async () => { drive = await app.container.make('drive.manager') })
 * export { drive as default }
 * ```
 *
 * `app.booted()` resolves immediately when the app has not booted yet, so the module finishes
 * evaluating with `drive` still unassigned. Because ESM exports are live bindings, the namespace's
 * `default` property later reflects the assignment — but a value captured out of it at import time
 * (`(await import(...)).default`) is frozen at `undefined` forever. That capture was the bug: every
 * media call then threw `Cannot read properties of undefined (reading 'use')`, and only when the
 * import happened to win the race against boot.
 */
export interface DriveServiceModule {
  readonly default: DriveManagerLike | undefined;
}

export interface DriveBackedResolverOptions {
  /** The `@adonisjs/drive/services/main` namespace (or any object with a live `default`). */
  driveService: DriveServiceModule;
  /** Disks built from `config.disks`; a name here wins over a Drive disk of the same name. */
  configuredDisks: Record<string, Disk>;
  /** Disk name used when a caller asks for no particular disk. */
  defaultDisk: string;
}

/**
 * Build the {@link DiskResolver} the media manager runs on: locally-configured disks first, then
 * `@adonisjs/drive`.
 *
 * The Drive manager is read **lazily, at the first disk resolution that actually needs it** — never
 * when the resolver is built — and memoized once found, so it is still resolved exactly once. This
 * is what makes the resolver safe to construct during `register()`, long before Drive has booted.
 * An app whose disks all come from `config.disks` never touches Drive at all.
 */
export function createDriveBackedResolver(options: DriveBackedResolverOptions): DiskResolver {
  const { driveService, configuredDisks, defaultDisk } = options;
  let drive: DriveManagerLike | undefined;

  return (name) => {
    const key = name ?? defaultDisk;
    const configured = configuredDisks[key];
    if (configured) return configured;

    if (drive === undefined) {
      const resolved = driveService.default;
      if (resolved === undefined) throw new DriveNotReadyError(key);
      drive = resolved;
    }
    return drive.use(name);
  };
}
