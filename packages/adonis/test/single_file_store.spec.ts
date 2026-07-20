import { describe, expect, it } from 'vitest';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaManager } from '../src/media_manager.js';
import { removeSingleFileWith, storeSingleFileWith } from '../src/single_file_store.js';
import { FakeImageProcessor } from '../src/testing/fake_image_processor.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

/** Build an in-memory {@link MediaManager} (memory store + in-memory `fs` disk) — no app boot. */
function makeManager(
  collections: MediaCollectionConfig[] = [],
  imageProcessor?: FakeImageProcessor,
) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const store = new InMemoryMediaStore();
  const manager = new MediaManager({
    defaultDisk: 'fs',
    resolve,
    store,
    collections,
    ...(imageProcessor !== undefined ? { imageProcessor } : {}),
    emitDiagnostics: false,
  });
  return { manager, store, disks };
}

const png = Buffer.from('fake-png-bytes');

describe('storeSingleFileWith', () => {
  it('stores a file and the returned url resolves to the stored original', async () => {
    const { manager, disks } = makeManager([{ name: 'avatar', single: true }]);

    const { url, thumbUrl } = await storeSingleFileWith(manager, {
      ownerType: 'AuthAccount',
      ownerId: 'acc-1',
      collection: 'avatar',
      fileName: 'me.png',
      mimeType: 'image/png',
      contents: png,
    });

    // The url points at bytes that actually landed on the disk.
    const path = url.replace('memory://fs/', '');
    expect(disks.fs.files.has(path)).toBe(true);
    expect(path).toContain('AuthAccount/acc-1/avatar/');
    // No `thumb` conversion configured → null, not a throw.
    expect(thumbUrl).toBeNull();
  });

  it('returns a thumbUrl when the collection defines a thumb conversion', async () => {
    const { manager, disks } = makeManager(
      [{ name: 'avatar', single: true, conversions: [{ name: 'thumb', width: 100, height: 100 }] }],
      new FakeImageProcessor(),
    );

    const { url, thumbUrl } = await storeSingleFileWith(manager, {
      ownerType: 'AuthAccount',
      ownerId: 'acc-1',
      collection: 'avatar',
      fileName: 'me.png',
      mimeType: 'image/png',
      contents: png,
    });

    expect(thumbUrl).not.toBeNull();
    expect(thumbUrl).toContain('/conversions/thumb.webp');
    const thumbPath = (thumbUrl as string).replace('memory://fs/', '');
    expect(disks.fs.files.has(thumbPath)).toBe(true);
    // The original still resolves independently of the conversion.
    expect(disks.fs.files.has(url.replace('memory://fs/', ''))).toBe(true);
  });

  it('replaces the prior file on a single-file collection (attach twice → one record)', async () => {
    const { manager, store } = makeManager([{ name: 'avatar', single: true }]);

    await storeSingleFileWith(manager, {
      ownerType: 'AuthAccount',
      ownerId: 'acc-1',
      collection: 'avatar',
      fileName: 'old.png',
      mimeType: 'image/png',
      contents: png,
    });
    await storeSingleFileWith(manager, {
      ownerType: 'AuthAccount',
      ownerId: 'acc-1',
      collection: 'avatar',
      fileName: 'new.png',
      mimeType: 'image/png',
      contents: png,
    });

    const list = await store.listByOwner('AuthAccount', 'acc-1', 'avatar');
    expect(list).toHaveLength(1);
    expect(list[0]?.fileName).toBe('new.png');
  });
});

describe('removeSingleFileWith', () => {
  it("empties the owner's collection", async () => {
    const { manager, store, disks } = makeManager([{ name: 'avatar', single: true }]);

    await storeSingleFileWith(manager, {
      ownerType: 'AuthAccount',
      ownerId: 'acc-1',
      collection: 'avatar',
      fileName: 'me.png',
      mimeType: 'image/png',
      contents: png,
    });
    expect(await store.listByOwner('AuthAccount', 'acc-1', 'avatar')).toHaveLength(1);

    await removeSingleFileWith(manager, {
      ownerType: 'AuthAccount',
      ownerId: 'acc-1',
      collection: 'avatar',
    });

    expect(await store.listByOwner('AuthAccount', 'acc-1', 'avatar')).toHaveLength(0);
    // Bytes are gone from the disk too.
    expect(disks.fs.files.size).toBe(0);
  });

  it('is a no-op when the owner has nothing stored', async () => {
    const { manager } = makeManager([{ name: 'avatar', single: true }]);
    await expect(
      removeSingleFileWith(manager, {
        ownerType: 'AuthAccount',
        ownerId: 'nobody',
        collection: 'avatar',
      }),
    ).resolves.toBeUndefined();
  });
});
