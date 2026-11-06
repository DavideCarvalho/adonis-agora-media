import { AssertionError } from 'node:assert';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaManager } from '../src/media_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import { MediaFake } from '../src/testing/media_fake.js';

const h = vi.hoisted(() => {
  const make = vi.fn();
  let bootedHandler: (() => Promise<void> | void) | null = null;
  return {
    app: {
      container: { make },
      booted: vi.fn((handler: () => Promise<void> | void) => {
        bootedHandler = handler;
      }),
    },
    make,
    async bootNow() {
      const handler = bootedHandler;
      bootedHandler = null;
      if (handler) await handler();
    },
  };
});

vi.mock('@adonisjs/core/services/app', () => ({ default: h.app }));

/** The app's real wiring: a disk and a store the fake must NOT touch. */
function realManager() {
  const { resolve, disks } = inMemoryDiskResolver(['s3', 'public']);
  const store = new InMemoryMediaStore();
  const manager = new MediaManager({
    defaultDisk: 's3',
    resolve,
    store,
    emitDiagnostics: false,
    collections: [
      { name: 'avatar', single: true, acceptsMimeTypes: ['text/plain'] },
      { name: 'covers', disk: 'public' },
    ],
  });
  return { manager, disks, store };
}

const attachInput = {
  ownerType: 'User',
  ownerId: 1,
  collection: 'avatar',
  fileName: 'note.txt',
  mimeType: 'text/plain',
  contents: Buffer.from('hello'),
};

describe('MediaManager.fake()', () => {
  let real: ReturnType<typeof realManager>;

  beforeEach(() => {
    real = realManager();
  });

  afterEach(() => {
    real.manager.restore();
  });

  it('reaches code that imported the services/main singleton before faking', async () => {
    vi.resetModules();
    h.make.mockResolvedValue(real.manager);
    const service = await import('../src/services/main.js');
    await h.bootNow();
    // Read after boot, like a live `import media from '@adonis-agora/media/services/main'` binding.
    const media = service.default;
    // "App code": a function closed over the singleton, defined before any fake exists.
    const uploadAvatar = () => media.library.attach(attachInput);

    const fake = media.fake();
    const record = await uploadAvatar();

    fake.assertCalled('attach', (input) => input.collection === 'avatar');
    expect(await fake.store.find(record.id)).not.toBeNull();
    expect(await real.store.find(record.id)).toBeNull();
    expect(real.disks.s3?.files.size).toBe(0);
    expect(fake.disk('s3').files.size).toBe(1);
  });

  it('round-trips attach → list → signedUrl → deliver → delete in memory, with real semantics', async () => {
    const fake = real.manager.fake();
    const media = real.manager;

    const first = await media.library.attach(attachInput);
    // `single: true` still replaces, and the whitelist still rejects.
    const second = await media.library.for('User', 1).attach({
      collection: 'avatar',
      fileName: 'again.txt',
      mimeType: 'text/plain',
      contents: Buffer.from('again'),
    });
    await expect(
      media.library.attach({ ...attachInput, mimeType: 'image/png', fileName: 'x.png' }),
    ).rejects.toThrow();

    const listed = await media.library.list('User', 1, 'avatar');
    expect(listed.map((r) => r.id)).toEqual([second.id]);
    expect(await media.library.find(first.id)).toBeNull();

    const url = await media.library.signedUrl(second.id, 120);
    expect(url).toContain('expires=120');

    const delivered = await media.library.deliver(second.id, { mode: 'proxy' });
    expect(delivered.kind).toBe('stream');

    // A collection on another disk gets its own in-memory disk automatically.
    const cover = await media.library.attach({ ...attachInput, collection: 'covers' });
    expect(cover.disk).toBe('public');
    expect(fake.disk('public').files.size).toBe(1);

    await media.library.delete(second.id);
    expect(await media.library.list('User', 1, 'avatar')).toEqual([]);
    expect(fake.disk('s3').files.size).toBe(0);
  });

  it('records calls with their typed arguments (TTL, ids, owner/collection)', async () => {
    const fake = real.manager.fake();
    const media = real.manager;
    const record = await media.library.attach(attachInput);

    await media.library.signedUrl(record.id, 300, { contentDisposition: 'attachment' });
    await media.library.delete(record.id);
    await media.library.for('Post', 9).list('gallery');

    expect(fake.calls.signedUrl).toEqual([[record.id, 300, { contentDisposition: 'attachment' }]]);
    expect(fake.calls.delete).toEqual([[record.id]]);
    expect(fake.calls.attach[0]?.[0]).toMatchObject({ ownerType: 'User', collection: 'avatar' });
    expect(fake.calls.list).toEqual([['Post', '9', 'gallery']]);

    fake.assertCalled('signedUrl', (_id, ttl) => ttl === 300);
    fake.assertCalled('delete', (id) => id === record.id);
    fake.assertNotCalled('deliver');
    expect(() => fake.assertCalled('signedUrl', (_id, ttl) => ttl === 60)).toThrow(AssertionError);
    expect(() => fake.assertNotCalled('attach')).toThrow(AssertionError);
  });

  it('stubs force a result or an error, and are still recorded', async () => {
    const fake = real.manager.fake();
    const media = real.manager;

    fake.stub('attach', () => {
      throw new Error('S3 is down');
    });
    await expect(media.library.attach(attachInput)).rejects.toThrow('S3 is down');
    expect(fake.calls.attach).toHaveLength(1);

    fake.stub('deliver', async () => ({ kind: 'redirect', url: 'https://cdn.test/x' }));
    expect(await media.library.deliver('anything')).toEqual({
      kind: 'redirect',
      url: 'https://cdn.test/x',
    });

    fake.unstub('attach');
    const record = await media.library.attach(attachInput);
    expect(await media.library.find(record.id)).not.toBeNull();
  });

  it('media.access goes through the recording library while faked', async () => {
    const fake = real.manager.fake();
    const record = await real.manager.library.attach(attachInput);
    const ctx = { auth: { user: { id: '1' } } };

    const image = await real.manager.access.image(ctx, record.id, { authorize: () => true });
    expect(image).toBeDefined();
    fake.assertCalled('find', (id) => id === record.id);

    fake.stub('find', async () => null);
    await expect(
      real.manager.access.image(ctx, record.id, { authorize: () => true }),
    ).rejects.toThrow();
  });

  it('restore() brings the original back; fake twice and restore without fake are safe', async () => {
    const originalLibrary = real.manager.library;
    const originalStore = real.manager.store;
    const originalAccess = real.manager.access;

    real.manager.restore(); // without a fake: no-op
    expect(real.manager.library).toBe(originalLibrary);

    const first = real.manager.fake();
    await real.manager.library.attach(attachInput);
    const second = real.manager.fake(); // replaces the first with a fresh, empty fake
    expect(second).toBeInstanceOf(MediaFake);
    expect(second).not.toBe(first);
    expect(real.manager.library).toBe(second.library);
    expect(real.manager.access).not.toBe(originalAccess);
    expect(await real.manager.library.list('User', 1)).toEqual([]);

    first.restore(); // stale handle: must not undo the newer fake
    expect(real.manager.library).toBe(second.library);

    real.manager.restore();
    real.manager.restore();
    expect(real.manager.library).toBe(originalLibrary);
    expect(real.manager.store).toBe(originalStore);
    expect(real.manager.access).toBe(originalAccess);

    const record = await real.manager.library.attach(attachInput);
    expect(await real.store.find(record.id)).not.toBeNull();
    expect(real.disks.s3?.files.size).toBe(1);
  });
});
