import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnitorFactory } from '@adonisjs/core/factories/core/ignitor';
import { defineConfig as defineDriveConfig, services as driveServices } from '@adonisjs/drive';
import { afterEach, describe, expect, it } from 'vitest';
import { defineConfig, disks, stores, uploadSessions } from '../src/define_config.js';
import { mediaStackUses, readStackUses, STACK_DESCRIPTOR } from '../src/stack.js';

describe('stack descriptors (telescope Architecture page)', () => {
  it('uses the global agora symbol, non-enumerable', () => {
    expect(STACK_DESCRIPTOR).toBe(Symbol.for('@adonis-agora/stack'));
    const factory = disks.s3({ bucket: 'hub-avatars', region: 'us-east-1' });
    expect(Object.keys(factory)).toEqual([]);
    expect(Object.getOwnPropertyDescriptor(factory, STACK_DESCRIPTOR)?.enumerable).toBe(false);
  });

  it('describes an S3 disk by its bucket, never its endpoint or credentials', () => {
    const factory = disks.s3({
      bucket: 'hub-avatars',
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret' },
    });
    expect(readStackUses(factory)).toEqual([
      { tech: 's3', label: 'hub-avatars', purpose: 'media files', host: 'us-east-1' },
    ]);
    expect(JSON.stringify(readStackUses(factory))).not.toContain('secret');
  });

  it('names S3-compatible services from the endpoint', () => {
    const tech = (endpoint: string) => readStackUses(disks.s3({ bucket: 'b', endpoint }))[0]?.tech;
    expect(tech('https://acc.r2.cloudflarestorage.com')).toBe('r2');
    expect(tech('https://storage.googleapis.com')).toBe('gcs');
    expect(tech('http://minio.internal:9000')).toBe('minio');
    expect(tech('https://nyc3.digitaloceanspaces.com')).toBe('s3');
    expect(readStackUses(disks.s3({ bucket: 'b', endpoint: 'http://u:p@minio:9000' }))[0]).toEqual({
      tech: 'minio',
      label: 'b',
      purpose: 'media files',
      host: 'minio',
    });
  });

  it('describes the Drive disks, the selected Lucid stores and the console Redis', () => {
    const config = defineConfig({
      disk: 'avatars',
      store: 'lucid',
      stores: { memory: stores.memory(), lucid: stores.lucid() },
      collections: [{ name: 'docs', disk: 'private' }, { name: 'avatar' }],
      uploads: {
        resumable: {
          store: 'lucid',
          stores: { lucid: uploadSessions.lucid({ connection: 'uploads' }) },
          routes: { enabled: true, disk: 'tus' },
        },
      },
      consoleCommands: { prefix: 'app' },
    });
    expect(
      mediaStackUses(config, {
        defaultDbConnection: 'pg',
        dbClients: { pg: 'pg', uploads: 'mysql2' },
        defaultRedisConnection: 'main',
      }),
    ).toEqual([
      { tech: 'drive', label: 'avatars', purpose: 'media files' },
      { tech: 'drive', label: 'private', purpose: 'media files' },
      { tech: 'drive', label: 'tus', purpose: 'uploads' },
      { tech: 'postgres', connection: 'pg', purpose: 'media records' },
      { tech: 'mysql', connection: 'uploads', purpose: 'upload sessions' },
      { tech: 'redis', connection: 'main', purpose: 'console commands' },
    ]);
  });

  it('skips an unselected Lucid store and a disk that describes itself', () => {
    const config = defineConfig({
      disk: 's3',
      disks: { s3: disks.s3({ bucket: 'media' }) },
      store: 'memory',
      stores: { memory: stores.memory(), lucid: stores.lucid({ connection: 'pg' }) },
    });
    expect(mediaStackUses(config, { defaultDbConnection: 'pg' })).toEqual([]);
  });

  it("falls back to Drive's default disk", () => {
    expect(mediaStackUses(defineConfig({}), { defaultDisk: 'fs' })).toEqual([
      { tech: 'drive', label: 'fs', purpose: 'media files' },
    ]);
  });
});

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('stack descriptors on a booted app', () => {
  it('tags config/media.ts with Drive’s default disk and the default connection', async () => {
    const location = mkdtempSync(join(tmpdir(), 'adonis-media-stack-'));
    tmpDirs.push(location);
    const media = defineConfig({
      store: 'lucid',
      stores: { lucid: stores.lucid() },
    });
    const ignitor = new IgnitorFactory()
      .withCoreProviders()
      .withCoreConfig()
      .merge({
        config: {
          media,
          database: { connection: 'pg', connections: { pg: { client: 'pg' } } },
          drive: defineDriveConfig({
            default: 'images',
            services: { images: driveServices.fs({ location, visibility: 'public' }) },
          }),
        },
        rcFileContents: {
          providers: [
            () => import('@adonisjs/drive/drive_provider'),
            () => import('../providers/media_provider.js'),
          ],
        },
      })
      .create(new URL('./', import.meta.url));
    const app = ignitor.createApp('console');
    await app.init();
    await app.boot();

    expect(readStackUses(app.config.get('media'))).toEqual([
      { tech: 'drive', label: 'images', purpose: 'media files' },
      { tech: 'postgres', connection: 'pg', purpose: 'media records' },
    ]);
  });
});
