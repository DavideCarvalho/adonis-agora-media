import { describe, expect, it } from 'vitest';
import type { DriveManagerLike, DriveServiceModule } from '../src/disks/drive.js';
import { createDriveBackedResolver } from '../src/disks/drive.js';
import { DriveNotReadyError } from '../src/errors.js';
import { InMemoryDisk } from '../src/testing/in_memory_disk.js';
import type { Disk } from '../src/types.js';

/**
 * Stand-in for `@adonisjs/drive/services/main`. Its real shape is
 * `var drive; await app.booted(() => { drive = ... }); export { drive as default }` — so `default` is
 * `undefined` until boot completes and only a LIVE read sees the later assignment. `reads` counts
 * how often the resolver goes back to the binding, which is how memoization is asserted.
 */
class FakeDriveService implements DriveServiceModule {
  reads = 0;
  manager: DriveManagerLike | undefined;

  get default(): DriveManagerLike | undefined {
    this.reads += 1;
    return this.manager;
  }

  /** Simulate the app finishing its boot: Drive assigns its manager. */
  boot(disks: Record<string, Disk>): void {
    this.manager = { use: (name?: string) => disks[name ?? 'default'] as Disk };
  }
}

describe('createDriveBackedResolver — lazy Drive resolution', () => {
  /**
   * The regression. `MediaManager` is constructed during `register()`, before the app is booted;
   * capturing Drive's export at that moment freezes it at `undefined` and every later media call
   * dies with `Cannot read properties of undefined (reading 'use')` — non-deterministically, since
   * it depends on whether the import wins the race against boot.
   */
  it('a resolver built BEFORE boot resolves a Drive disk once the app has booted', () => {
    const service = new FakeDriveService();
    const resolve = createDriveBackedResolver({
      driveService: service,
      configuredDisks: {},
      defaultDisk: 'default',
    });
    // Built while Drive is still unassigned — and it must not have touched the binding yet.
    expect(service.reads).toBe(0);

    const fs = new InMemoryDisk();
    service.boot({ default: fs });

    expect(resolve()).toBe(fs);
  });

  it('resolves the Drive manager exactly once and memoizes it', () => {
    const service = new FakeDriveService();
    const resolve = createDriveBackedResolver({
      driveService: service,
      configuredDisks: {},
      defaultDisk: 'default',
    });
    const fs = new InMemoryDisk();
    service.boot({ default: fs, other: new InMemoryDisk() });

    resolve();
    resolve('other');
    resolve();

    expect(service.reads).toBe(1);
  });

  it('throws a self-explanatory error, not a TypeError, when resolving before Drive booted', () => {
    const service = new FakeDriveService();
    const resolve = createDriveBackedResolver({
      driveService: service,
      configuredDisks: {},
      defaultDisk: 'default',
    });

    expect(() => resolve('s3')).toThrowError(DriveNotReadyError);
    expect(() => resolve('s3')).toThrow(/has not finished booting/);
  });

  it('recovers on the next call: a pre-boot failure does not poison the memo', () => {
    const service = new FakeDriveService();
    const resolve = createDriveBackedResolver({
      driveService: service,
      configuredDisks: {},
      defaultDisk: 'default',
    });
    expect(() => resolve()).toThrowError(DriveNotReadyError);

    const fs = new InMemoryDisk();
    service.boot({ default: fs });

    expect(resolve()).toBe(fs);
  });

  it('serves a disk declared in `config.disks` without touching Drive at all', () => {
    const service = new FakeDriveService();
    const s3 = new InMemoryDisk();
    const resolve = createDriveBackedResolver({
      driveService: service,
      configuredDisks: { s3 },
      defaultDisk: 's3',
    });

    expect(resolve()).toBe(s3);
    expect(resolve('s3')).toBe(s3);
    expect(service.reads).toBe(0);
  });
});
