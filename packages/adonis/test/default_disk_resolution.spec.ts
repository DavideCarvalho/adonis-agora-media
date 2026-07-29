import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import type { ApplicationService } from '@adonisjs/core/types';
import { defineConfig as defineDriveConfig, services as driveServices } from '@adonisjs/drive';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaConfig } from '../src/define_config.js';
import { MediaManager } from '../src/media_manager.js';

/**
 * These specs exist because the previous provider test could not see this class of bug: it faked
 * `app.config.get('drive')` as a PLAIN OBJECT. In a real app that value is an unresolved
 * `ConfigProvider` (`{ type: 'provider', resolver }`) — Drive's `defineConfig` returns one — so no
 * property of the resolved config (`default`, `services`, …) is reachable without resolving it.
 *
 * So we boot a REAL `Application` through `IgnitorFactory` with the real `@adonisjs/drive` provider
 * and a drive config produced by Drive's own `defineConfig`. `IgnitorFactory#merge({ config })` feeds
 * `app.useConfig()`, which is exactly what a loaded `config/drive.ts` yields: the file's default
 * export, untouched. Every spec below asserts the shape it booted with, so the reproduction can never
 * silently decay back into a plain-object fake.
 */

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adonis-media-drive-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Boot a real app with the given `drive` + `media` config and return its resolved
 * {@link MediaManager}. `drive` is deliberately typed `unknown`: some specs pass Drive's
 * `ConfigProvider`, one passes a plain object, one passes nothing at all.
 */
async function bootApp(options: {
  drive?: unknown;
  media?: MediaConfig;
}): Promise<{ app: ApplicationService; media: MediaManager; driveConfigValue: unknown }> {
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .merge({
      config: {
        media: options.media ?? {},
        ...(options.drive !== undefined ? { drive: options.drive } : {}),
      },
      rcFileContents: {
        providers: [
          ...(options.drive !== undefined ? [() => import('@adonisjs/drive/drive_provider')] : []),
          () => import('../providers/media_provider.js'),
        ],
      },
    })
    .create(new URL('./', import.meta.url));

  const app = ignitor.createApp('console');
  await app.init();
  await app.boot();

  return {
    app,
    media: await app.container.make(MediaManager),
    driveConfigValue: app.config.get('drive', undefined),
  };
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('default disk resolution (real booted app, real Drive ConfigProvider)', () => {
  it("uses Drive's configured default disk when `media.disk` is omitted", async () => {
    const { media, driveConfigValue } = await bootApp({
      drive: defineDriveConfig({
        default: 'images',
        services: {
          images: driveServices.fs({ location: makeTmpDir(), visibility: 'public' }),
          archive: driveServices.fs({ location: makeTmpDir(), visibility: 'private' }),
        },
      }),
    });

    // Guard the reproduction: the booted value MUST be an unresolved ConfigProvider, otherwise this
    // spec would be testing a fake and would pass over the bug.
    expect(Object.keys(driveConfigValue as object).sort()).toEqual(['resolver', 'type']);
    expect((driveConfigValue as { type: string }).type).toBe('provider');
    expect((driveConfigValue as { default?: string }).default).toBeUndefined();
    expect((driveConfigValue as { config?: unknown }).config).toBeUndefined();

    expect(media.storage.defaultDisk).toBe('images');
  });

  it('still lets an explicit `media.disk` win over Drive’s default', async () => {
    const { media } = await bootApp({
      drive: defineDriveConfig({
        default: 'images',
        services: {
          images: driveServices.fs({ location: makeTmpDir(), visibility: 'public' }),
          archive: driveServices.fs({ location: makeTmpDir(), visibility: 'private' }),
        },
      }),
      media: { disk: 'archive' },
    });

    expect(media.storage.defaultDisk).toBe('archive');
  });

  it("falls back to 'default' when the app has no drive config at all", async () => {
    const { media, driveConfigValue } = await bootApp({});

    expect(driveConfigValue).toBeUndefined();
    expect(media.storage.defaultDisk).toBe('default');
  });
});
