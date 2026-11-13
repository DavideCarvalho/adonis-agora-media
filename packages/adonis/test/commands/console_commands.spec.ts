import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MediaDisksList } from '../../commands/console_disks.js';
import {
  MediaFoldersCreate,
  MediaObjectsCopy,
  MediaObjectsDelete,
  MediaObjectsList,
  MediaObjectsMove,
  MediaObjectsRename,
  MediaObjectsShow,
  MediaObjectsUpload,
} from '../../commands/console_objects.js';
import {
  MediaCollectionsList,
  MediaRecordsDelete,
  MediaRecordsList,
  MediaRecordsShow,
} from '../../commands/console_records.js';
import {
  MediaUploadsAbort,
  MediaUploadsList,
  MediaUploadsShow,
} from '../../commands/console_uploads.js';
import { getMetaData } from '../../commands/main.js';
import { MediaManager } from '../../src/media_manager.js';
import type { MediaRecord } from '../../src/media_record.js';
import { InMemoryMediaStore } from '../../src/testing/in_memory_media_store.js';
import { InMemoryUploadSessionStore } from '../../src/testing/in_memory_upload_session_store.js';

/**
 * The `media:*` console commands through a real Ace kernel: flag/arg parsing, the container lookup
 * of the media manager, the console config, prompts and exit codes. Storage is a Map-backed
 * S3-like disk and the real in-memory stores, so assertions are about objects and records that did
 * (or did not) change.
 */

/** A Map-backed disk with the extended (S3-like) surface the console needs. */
class MapDisk {
  readonly capabilities = { presign: true, multipart: false, publicUrls: false, list: true };
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string | undefined }>();

  async put(key: string, bytes: Uint8Array, options: { contentType?: string } = {}) {
    this.objects.set(key, { bytes: new Uint8Array(bytes), contentType: options.contentType });
  }
  async getBytes(key: string) {
    return this.#get(key).bytes;
  }
  async stat(key: string) {
    const object = this.#get(key);
    return {
      size: object.bytes.length,
      contentType: object.contentType,
      lastModified: new Date('2026-11-01T00:00:00Z'),
    };
  }
  async size(key: string) {
    return this.#get(key).bytes.length;
  }
  async getMetaData(key: string) {
    const { size, contentType, lastModified } = await this.stat(key);
    return { contentLength: size, contentType, lastModified };
  }
  async getSignedUrl(key: string) {
    return `https://signed.example/${key}`;
  }
  async copy(from: string, to: string) {
    this.objects.set(to, { ...this.#get(from) });
  }
  async move(from: string, to: string) {
    await this.copy(from, to);
    this.objects.delete(from);
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
  async deleteMany(keys: string[]) {
    for (const key of keys) this.objects.delete(key);
  }
  async list(prefix: string, options: { delimiter?: string; limit?: number } = {}) {
    const delimiter = options.delimiter ?? '/';
    const folders = new Set<string>();
    const files: Array<{ key: string; name: string; sizeBytes: number; lastModified: Date }> = [];
    for (const [key, object] of [...this.objects].sort(([a], [b]) => a.localeCompare(b))) {
      if (!key.startsWith(prefix) || key === prefix) continue;
      const rest = key.slice(prefix.length);
      const cut = delimiter === '' ? -1 : rest.indexOf(delimiter);
      if (cut !== -1) {
        folders.add(prefix + rest.slice(0, cut + 1));
        continue;
      }
      files.push({
        key,
        name: rest,
        sizeBytes: object.bytes.length,
        lastModified: new Date('2026-11-01T00:00:00Z'),
      });
    }
    return { folders: [...folders], files, cursor: undefined };
  }
  #get(key: string) {
    const object = this.objects.get(key);
    if (!object) throw new Error(`missing: ${key}`);
    return object;
  }
}

function record(over: Partial<MediaRecord>): MediaRecord {
  return {
    id: 'm1',
    ownerType: 'User',
    ownerId: '1',
    collection: 'avatars',
    name: 'me',
    fileName: 'me.png',
    mimeType: 'image/png',
    size: 10,
    disk: 's3',
    path: 'User/1/avatars/m1/me.png',
    order: 0,
    customProperties: {},
    conversions: { thumb: { disk: 's3', path: 'User/1/avatars/m1/thumb.png' } },
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    ...over,
  } as MediaRecord;
}

interface World {
  disk: MapDisk;
  store: InMemoryMediaStore;
  sessions: InMemoryUploadSessionStore;
}

async function world(): Promise<World> {
  const disk = new MapDisk();
  await disk.put('a.txt', new TextEncoder().encode('hello'), { contentType: 'text/plain' });
  await disk.put('photos/b.jpg', new Uint8Array(3), { contentType: 'image/jpeg' });
  await disk.put('photos/2026/c.jpg', new Uint8Array(4));
  const store = new InMemoryMediaStore();
  await store.save(record({ id: 'm1' }));
  await store.save(
    record({ id: 'm2', collection: 'docs', createdAt: new Date('2026-11-02T00:00:00Z') }),
  );
  const sessions = new InMemoryUploadSessionStore();
  await sessions.create({
    id: 'u1',
    disk: 's3',
    key: 'big.mov',
    contentType: 'video/quicktime',
    size: 100,
    offset: 25,
    parts: 1,
  });
  await sessions.addPart('u1', { partNumber: 1, etag: 'etag-1' });
  return { disk, store, sessions };
}

/** The manager surface the console reads (structural, like the console's own tests). */
function manager(w: World, tenancy = false) {
  return {
    storage: {
      defaultDisk: 's3',
      disk: (name?: string) => {
        if ((name ?? 's3') !== 's3') throw new Error(`unknown disk: ${name}`);
        return w.disk;
      },
    },
    hasResumable: true,
    resumable: {
      list: (filter?: Parameters<InMemoryUploadSessionStore['list']>[0]) => w.sessions.list(filter),
      abort: (id: string) => w.sessions.delete(id),
      listParts: (id: string) => w.sessions.listParts(id),
    },
    store: w.store,
    tenancy: { enabled: tenancy },
  };
}

let fixture: string;

beforeAll(() => {
  fixture = mkdtempSync(path.join(tmpdir(), 'media-cli-'));
  mkdirSync(path.join(fixture, 'app'), { recursive: true });
  writeFileSync(
    path.join(fixture, 'package.json'),
    JSON.stringify({ type: 'module', name: 'media-cli-fixture', version: '0.0.0' }),
  );
  writeFileSync(path.join(fixture, 'upload.json'), '{"hi":1}');
});

type Kernel = Awaited<ReturnType<typeof makeKernel>>;

/** One kernel for the file; each run swaps the world it sees (the binding reads `current`). */
let kernel: Kernel;
let current: { world: World; tenancy: boolean } | undefined;

async function makeKernel() {
  const { IgnitorFactory, AceFactory } = await import('@adonisjs/core/factories');
  const ignitor = new IgnitorFactory()
    .withCoreProviders()
    .withCoreConfig()
    .create(new URL(`file://${fixture}/`), {
      importer: async (specifier: string) => import(specifier),
    });
  const ace = await new AceFactory().make(ignitor);
  await ace.app.boot();
  ace.ui.switchMode('raw');
  ace.app.config.set('media', { disk: 's3' });
  ace.app.container.bind(MediaManager, () => {
    if (!current) throw new Error('no world');
    return manager(current.world, current.tenancy) as never;
  });
  return ace;
}

beforeAll(async () => {
  kernel = await makeKernel();
});

type CommandClass = Parameters<Kernel['create']>[0];

async function run(
  w: World,
  command: CommandClass,
  argv: string[],
  options: { actions?: boolean; tenancy?: boolean; answer?: [string, boolean] } = {},
) {
  current = { world: w, tenancy: options.tenancy ?? false };
  kernel.app.config.set('media_dashboard', { actions: options.actions ?? true });
  kernel.ui.logger.flushLogs();
  const cmd = await kernel.create(command, argv);
  if (options.answer) {
    const [question, yes] = options.answer;
    const trap = cmd.prompt.trap(question);
    if (yes) trap.accept();
    else trap.reject();
  }
  await cmd.exec();
  const logs = cmd.ui.logger.getLogs().map((log) => log.message);
  const output = logs.join('\n');
  return {
    exitCode: cmd.exitCode ?? 0,
    output,
    json: () => JSON.parse(logs.join('\n')),
  };
}

describe('media console commands', () => {
  it('are registered under media:<noun>:<verb>', async () => {
    const names = (await getMetaData()).map((meta) => meta.commandName);
    expect(names).toEqual(
      expect.arrayContaining([
        'media:disks:list',
        'media:objects:list',
        'media:objects:show',
        'media:objects:upload',
        'media:objects:copy',
        'media:objects:move',
        'media:objects:rename',
        'media:objects:delete',
        'media:folders:create',
        'media:collections:list',
        'media:records:list',
        'media:records:show',
        'media:records:delete',
        'media:uploads:list',
        'media:uploads:show',
        'media:uploads:abort',
      ]),
    );
  });

  describe('disks', () => {
    it('lists the console disks (--json is the API shape)', async () => {
      const w = await world();
      const result = await run(w, MediaDisksList, ['--json']);
      expect(result.exitCode).toBe(0);
      expect(result.json()).toEqual({
        data: [
          {
            name: 's3',
            default: true,
            capabilities: { presign: true, multipart: false, publicUrls: false, list: true },
          },
        ],
      });
      const table = await run(w, MediaDisksList, []);
      expect(table.output).toContain('s3');
    });
  });

  describe('objects', () => {
    it('browses a prefix, folders first, as a cursor page', async () => {
      const w = await world();
      const root = await run(w, MediaObjectsList, ['--json']);
      expect(root.json()).toEqual({
        data: [
          { type: 'folder', name: 'photos', prefix: 'photos/' },
          {
            type: 'file',
            key: 'a.txt',
            name: 'a.txt',
            sizeBytes: 5,
            lastModified: '2026-11-01T00:00:00.000Z',
          },
        ],
        meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
      });
      const photos = await run(w, MediaObjectsList, ['--prefix=photos/']);
      expect(photos.output).toContain('photos/2026/');
      expect(photos.output).toContain('photos/b.jpg');
    });

    it('refuses a sort the listing cannot honour, and an unknown disk', async () => {
      const w = await world();
      const sorted = await run(w, MediaObjectsList, ['--sort=-key']);
      expect(sorted.exitCode).toBe(1);
      expect(sorted.output).toContain('can only be sorted by "key"');
      const unknown = await run(w, MediaObjectsList, ['--disk=nope']);
      expect(unknown.exitCode).toBe(1);
      expect(unknown.output).toContain('unknown disk');
    });

    it('shows an object, with a URL on request', async () => {
      const w = await world();
      const result = await run(w, MediaObjectsShow, ['a.txt', '--url', '--json']);
      expect(result.json()).toEqual({
        object: {
          key: 'a.txt',
          size: 5,
          contentType: 'text/plain',
          lastModified: '2026-11-01T00:00:00.000Z',
          url: 'https://signed.example/a.txt',
        },
        insights: [],
      });
      const missing = await run(w, MediaObjectsShow, ['nope.txt']);
      expect(missing.exitCode).toBe(1);
    });

    it('uploads a local file under a prefix, typed from its extension', async () => {
      const w = await world();
      const file = path.join(fixture, 'upload.json');
      const result = await run(w, MediaObjectsUpload, [file, '--prefix=docs/', '--json']);
      expect(result.exitCode).toBe(0);
      expect(result.json()).toEqual({ disk: 's3', key: 'docs/upload.json', size: 8 });
      expect(w.disk.objects.get('docs/upload.json')?.contentType).toBe('application/json');
      const both = await run(w, MediaObjectsUpload, [file, '--key=x.json', '--prefix=docs/']);
      expect(both.exitCode).toBe(1);
      expect(both.output).toContain('not both');
    });

    it('copies, moves and renames objects and folders', async () => {
      const w = await world();
      expect((await run(w, MediaObjectsCopy, ['a.txt', 'b.txt'])).exitCode).toBe(0);
      expect(w.disk.objects.has('a.txt')).toBe(true);
      expect(w.disk.objects.has('b.txt')).toBe(true);

      expect((await run(w, MediaObjectsMove, ['b.txt', 'archive/b.txt'])).exitCode).toBe(0);
      expect(w.disk.objects.has('b.txt')).toBe(false);
      expect(w.disk.objects.has('archive/b.txt')).toBe(true);

      const renamed = await run(w, MediaObjectsRename, ['archive/b.txt', 'c.txt', '--json']);
      expect(renamed.json()).toEqual({
        ok: true,
        disk: 's3',
        from: 'archive/b.txt',
        to: 'archive/c.txt',
        folder: false,
      });
      expect(w.disk.objects.has('archive/c.txt')).toBe(true);

      expect((await run(w, MediaObjectsRename, ['photos/', 'pics', '--folder'])).exitCode).toBe(0);
      expect(w.disk.objects.has('pics/b.jpg')).toBe(true);
      expect(w.disk.objects.has('pics/2026/c.jpg')).toBe(true);
      expect(w.disk.objects.has('photos/b.jpg')).toBe(false);

      const bad = await run(w, MediaObjectsRename, ['a.txt', 'x/y']);
      expect(bad.exitCode).toBe(1);
    });

    it('refuses changes while the console actions are off', async () => {
      const w = await world();
      const result = await run(w, MediaObjectsCopy, ['a.txt', 'b.txt'], { actions: false });
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('actions are disabled');
      expect(w.disk.objects.has('b.txt')).toBe(false);
    });

    it('deletes after confirmation, or with --force; --dry-run deletes nothing', async () => {
      const w = await world();
      const dry = await run(w, MediaObjectsDelete, ['a.txt', '--dry-run', '--json']);
      expect(dry.json()).toEqual({
        dryRun: true,
        disk: 's3',
        objects: [
          {
            key: 'a.txt',
            size: 5,
            contentType: 'text/plain',
            lastModified: '2026-11-01T00:00:00.000Z',
          },
        ],
      });
      expect(w.disk.objects.has('a.txt')).toBe(true);

      const declined = await run(w, MediaObjectsDelete, ['a.txt'], {
        answer: ['Delete 1 object(s) from s3?', false],
      });
      expect(declined.exitCode).toBe(1);
      expect(w.disk.objects.has('a.txt')).toBe(true);

      const confirmed = await run(w, MediaObjectsDelete, ['a.txt'], {
        answer: ['Delete 1 object(s) from s3?', true],
      });
      expect(confirmed.exitCode).toBe(0);
      expect(w.disk.objects.has('a.txt')).toBe(false);

      const folder = await run(w, MediaObjectsDelete, ['photos', '--folder', '--force', '--json']);
      expect(folder.json()).toEqual({ ok: true, disk: 's3', folder: 'photos' });
      expect([...w.disk.objects.keys()].filter((key) => key.startsWith('photos/'))).toEqual([]);
    });

    it('creates a folder', async () => {
      const w = await world();
      const result = await run(w, MediaFoldersCreate, ['/inbox/2026/', '--json']);
      expect(result.json()).toEqual({ ok: true, disk: 's3', folder: 'inbox/2026/' });
      expect(w.disk.objects.has('inbox/2026/')).toBe(true);
    });
  });

  describe('collections and records', () => {
    it('summarises collections', async () => {
      const w = await world();
      const result = await run(w, MediaCollectionsList, ['--json']);
      expect(result.json().data).toEqual(
        expect.arrayContaining([
          { key: 'avatars', count: 1, sumSize: 10 },
          { key: 'docs', count: 1, sumSize: 10 },
        ]),
      );
    });

    it('lists records newest first, filtered and paged', async () => {
      const w = await world();
      const all = await run(w, MediaRecordsList, ['--json']);
      expect(all.json().data.map((r: { id: string }) => r.id)).toEqual(['m2', 'm1']);
      expect(all.json().meta).toEqual({
        nextCursor: null,
        prevCursor: null,
        hasNext: false,
        hasPrev: false,
      });

      const docs = await run(w, MediaRecordsList, ['--collection=docs', '--json']);
      expect(docs.json().data.map((r: { id: string }) => r.id)).toEqual(['m2']);

      const first = await run(w, MediaRecordsList, ['--first=1', '--json']);
      const cursor = first.json().meta.nextCursor;
      expect(first.json().data).toHaveLength(1);
      expect(cursor).not.toBeNull();
      const next = await run(w, MediaRecordsList, ['--first=1', `--after=${cursor}`, '--json']);
      expect(next.json().data.map((r: { id: string }) => r.id)).toEqual(['m1']);

      const sorted = await run(w, MediaRecordsList, ['--sort=createdAt']);
      expect(sorted.exitCode).toBe(1);
    });

    it('shows a record with its conversion URLs', async () => {
      const w = await world();
      const result = await run(w, MediaRecordsShow, ['m1', '--json']);
      expect(result.json().record.id).toBe('m1');
      expect(result.json().variants).toEqual([
        { name: 'thumb', url: 'https://signed.example/User/1/avatars/m1/thumb.png' },
      ]);
      expect((await run(w, MediaRecordsShow, ['nope'])).exitCode).toBe(1);
    });

    it('deletes a record with --force, and refuses an unknown one', async () => {
      const w = await world();
      const result = await run(w, MediaRecordsDelete, ['m1', '--force', '--json']);
      expect(result.json()).toEqual({ ok: true, id: 'm1' });
      expect(await w.store.find('m1')).toBeNull();
      const missing = await run(w, MediaRecordsDelete, ['m1', '--force']);
      expect(missing.exitCode).toBe(1);
      expect(missing.output).toContain('unknown media record');
    });

    it('confines records to --tenant when tenancy is on', async () => {
      const w = await world();
      await w.store.save(record({ id: 't1-file', tenantId: 't1' }));
      await w.store.save(record({ id: 't2-file', tenantId: 't2' }));
      const result = await run(w, MediaRecordsList, ['--tenant=t1', '--json'], { tenancy: true });
      expect(result.json().data.map((r: { id: string }) => r.id)).toEqual(['t1-file']);
      const other = await run(w, MediaRecordsShow, ['t2-file', '--tenant=t1'], { tenancy: true });
      expect(other.exitCode).toBe(1);
      const off = await run(w, MediaRecordsList, ['--tenant=t1']);
      expect(off.exitCode).toBe(1);
      expect(off.output).toContain('--tenant needs tenancy on');
    });
  });

  describe('uploads', () => {
    it('lists and shows uploads in progress', async () => {
      const w = await world();
      const list = await run(w, MediaUploadsList, ['--json']);
      expect(list.json().data).toEqual([
        expect.objectContaining({ id: 'u1', key: 'big.mov', percent: 25, parts: 1 }),
      ]);
      const show = await run(w, MediaUploadsShow, ['u1', '--json']);
      expect(show.json().parts).toEqual([{ partNumber: 1, etag: 'etag-1' }]);
      const sorted = await run(w, MediaUploadsList, ['--sort=size']);
      expect(sorted.exitCode).toBe(1);
    });

    it('aborts an upload after confirmation', async () => {
      const w = await world();
      const declined = await run(w, MediaUploadsAbort, ['u1'], {
        answer: ['Abort upload u1 (s3:big.mov)?', false],
      });
      expect(declined.exitCode).toBe(1);
      expect(await w.sessions.get('u1')).not.toBeNull();
      const done = await run(w, MediaUploadsAbort, ['u1', '--force', '--json']);
      expect(done.json()).toEqual({ ok: true, id: 'u1' });
      expect(await w.sessions.get('u1')).toBeNull();
      expect((await run(w, MediaUploadsAbort, ['u1', '--force'])).exitCode).toBe(1);
    });
  });
});
