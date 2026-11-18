import { describe, expect, it } from 'vitest';
import {
  buildConsoleService,
  consoleDiskNames,
  readConsoleServiceConfig,
} from '../../src/dashboard/console_service.js';

/** An app that only hosts the federated console: no `config/drive.ts`, no `disks`. */
function config(values: Record<string, unknown>) {
  return { get: <T>(key: string, fallback?: unknown) => (values[key] ?? fallback) as T };
}

const manager = {
  hasResumable: false,
  storage: { defaultDisk: 'default', disk: () => ({}) },
} as never;

describe('console: an app with no storage of its own', () => {
  it('has no storage without config/drive.ts and without disks', () => {
    const settings = readConsoleServiceConfig(config({ media: { store: 'lucid' } }));
    expect(settings.storage).toBe(false);
    expect(consoleDiskNames(settings)).toEqual([]);
    expect(buildConsoleService(manager, settings).topology()).toMatchObject({
      disks: 0,
      storage: false,
    });
  });

  it('has storage with config/drive.ts, or with disks in config/media.ts', () => {
    expect(readConsoleServiceConfig(config({ drive: { default: 's3' } })).storage).toBe(true);
    const withDisks = readConsoleServiceConfig(config({ media: { disks: { s3: {} } } }));
    expect(withDisks.storage).toBe(true);
    expect(consoleDiskNames(withDisks)).toEqual(['default', 's3']);
  });

  it('a console that lists its disks keeps them', () => {
    const settings = readConsoleServiceConfig(
      config({ media_dashboard: { disks: ['archive'] }, media: {} }),
    );
    expect(consoleDiskNames(settings)).toEqual(['archive']);
  });
});
