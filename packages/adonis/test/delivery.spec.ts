import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryMode } from '../src/delivery.js';
import { MediaDeliveryHandler, resolveDeliveryMode } from '../src/delivery.js';
import { MediaNotFoundError } from '../src/errors.js';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaManager } from '../src/media_manager.js';
import { FakeImageProcessor } from '../src/testing/fake_image_processor.js';
import type { DiskVisibility } from '../src/testing/in_memory_disk.js';
import { InMemoryDisk, inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import type { Disk } from '../src/types.js';

interface ManagerOptions {
  collections?: MediaCollectionConfig[];
  deliveryMode?: DeliveryMode;
  deliverySignedTtlSeconds?: number;
  /** Visibility the `fs` disk reports; `'unknown'` builds a disk with no `getVisibility`. */
  visibility?: DiskVisibility;
  imageProcessor?: FakeImageProcessor;
}

function makeManager(options: ManagerOptions = {}) {
  const { resolve, disks } = inMemoryDiskResolver(['fs'], options.visibility ?? 'private');
  const store = new InMemoryMediaStore();
  const manager = new MediaManager({
    defaultDisk: 'fs',
    resolve,
    store,
    collections: options.collections ?? [{ name: 'docs' }],
    emitDiagnostics: false,
    ...(options.deliveryMode !== undefined ? { deliveryMode: options.deliveryMode } : {}),
    ...(options.deliverySignedTtlSeconds !== undefined
      ? { deliverySignedTtlSeconds: options.deliverySignedTtlSeconds }
      : {}),
    ...(options.imageProcessor !== undefined ? { imageProcessor: options.imageProcessor } : {}),
  });
  return { manager, store, disks };
}

const contents = Buffer.from('the actual stored bytes');

function attach(manager: MediaManager, collection = 'docs') {
  return manager.library.attach({
    ownerType: 'Patient',
    ownerId: 7,
    collection,
    fileName: 'report.txt',
    mimeType: 'text/plain',
    contents,
  });
}

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('resolveDeliveryMode', () => {
  const disk = (visibility: DiskVisibility): Disk => new InMemoryDisk('memory://fs', visibility);

  it('passes an explicit mode straight through without consulting the disk', async () => {
    const probed = disk('public');
    const spy = vi.spyOn(probed, 'getVisibility' as never);
    for (const mode of ['public', 'signed', 'proxy'] as const) {
      expect(await resolveDeliveryMode(mode, probed, 'k')).toBe(mode);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves auto to public on a disk reporting public visibility', async () => {
    expect(await resolveDeliveryMode('auto', disk('public'), 'k')).toBe('public');
  });

  it('resolves auto to signed on a disk reporting private visibility', async () => {
    expect(await resolveDeliveryMode('auto', disk('private'), 'k')).toBe('signed');
  });

  it('falls back to signed when the disk cannot report visibility at all', async () => {
    const unknowable = disk('unknown');
    expect(unknowable.getVisibility).toBeUndefined();
    expect(await resolveDeliveryMode('auto', unknowable, 'k')).toBe('signed');
  });

  it('treats an omitted mode as auto', async () => {
    expect(await resolveDeliveryMode(undefined, disk('public'), 'k')).toBe('public');
  });
});

describe('MediaLibrary.deliver', () => {
  it('returns a redirect to the raw disk URL in public mode', async () => {
    const { manager } = makeManager({ deliveryMode: 'public' });
    const record = await attach(manager);

    const result = await manager.library.deliver(record.id);

    expect(result).toEqual({ kind: 'redirect', url: `memory://fs/${record.path}` });
  });

  it('returns a redirect to a signed URL in signed mode, using the configured TTL', async () => {
    const { manager, disks } = makeManager({
      deliveryMode: 'signed',
      deliverySignedTtlSeconds: 90,
    });
    const record = await attach(manager);

    const result = await manager.library.deliver(record.id);

    expect(result.kind).toBe('redirect');
    expect(result.kind === 'redirect' && result.url).toContain('signature=fake');
    expect(disks.fs?.lastSignedUrlOptions).toEqual({ expiresIn: 90 });
  });

  it('defaults the signed TTL to 300 seconds', async () => {
    const { manager, disks } = makeManager({ deliveryMode: 'signed' });
    const record = await attach(manager);

    await manager.library.deliver(record.id);

    expect(disks.fs?.lastSignedUrlOptions).toEqual({ expiresIn: 300 });
  });

  it('streams the bytes with type/size/filename in proxy mode, never issuing a URL', async () => {
    const { manager, disks } = makeManager({ deliveryMode: 'proxy' });
    const getUrl = vi.spyOn(disks.fs as InMemoryDisk, 'getUrl');
    const getSignedUrl = vi.spyOn(disks.fs as InMemoryDisk, 'getSignedUrl');
    const record = await attach(manager);

    const result = await manager.library.deliver(record.id);

    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') throw new Error('expected a stream');
    expect(await drain(result.stream)).toEqual(contents);
    expect(result.mimeType).toBe('text/plain');
    expect(result.size).toBe(contents.byteLength);
    expect(result.fileName).toBe('report.txt');
    expect(getUrl).not.toHaveBeenCalled();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('resolves auto by the disk visibility — public disk yields a raw URL', async () => {
    const { manager } = makeManager({ visibility: 'public' });
    const record = await attach(manager);

    const result = await manager.library.deliver(record.id);

    expect(result).toEqual({ kind: 'redirect', url: `memory://fs/${record.path}` });
  });

  it('resolves auto by the disk visibility — private disk yields a signed URL', async () => {
    const { manager } = makeManager({ visibility: 'private' });
    const record = await attach(manager);

    const result = await manager.library.deliver(record.id);

    expect(result.kind === 'redirect' && result.url).toContain('signature=fake');
  });

  it('resolves auto to signed when the disk cannot report visibility', async () => {
    const { manager } = makeManager({ visibility: 'unknown' });
    const record = await attach(manager);

    const result = await manager.library.deliver(record.id);

    expect(result.kind === 'redirect' && result.url).toContain('signature=fake');
  });

  it('lets a per-call mode override the configured default', async () => {
    const { manager } = makeManager({ deliveryMode: 'public' });
    const record = await attach(manager);

    const result = await manager.library.deliver(record.id, { mode: 'proxy' });

    expect(result.kind).toBe('stream');
  });

  it('lets a per-call TTL override the configured one', async () => {
    const { manager, disks } = makeManager({
      deliveryMode: 'signed',
      deliverySignedTtlSeconds: 90,
    });
    const record = await attach(manager);

    await manager.library.deliver(record.id, { signedTtlSeconds: 15 });

    expect(disks.fs?.lastSignedUrlOptions).toEqual({ expiresIn: 15 });
  });

  it('delivers a conversion, generating it lazily and describing the variant, not the original', async () => {
    const { manager } = makeManager({
      collections: [{ name: 'gallery', conversions: [{ name: 'thumb', width: 50 }] }],
      deliveryMode: 'proxy',
      imageProcessor: new FakeImageProcessor(),
    });
    const record = await manager.library.attach({
      ownerType: 'Post',
      ownerId: 1,
      collection: 'gallery',
      fileName: 'photo.png',
      mimeType: 'image/png',
      contents: Buffer.from('png-bytes'),
    });

    const result = await manager.library.deliver(record.id, { conversion: 'thumb' });

    expect(result.kind).toBe('stream');
    if (result.kind !== 'stream') throw new Error('expected a stream');
    expect(result.fileName).toMatch(/^thumb\./);
    expect(result.mimeType).not.toBe('');
  });

  it('throws MediaNotFoundError for an unknown id', async () => {
    const { manager } = makeManager();
    await expect(manager.library.deliver('nope')).rejects.toBeInstanceOf(MediaNotFoundError);
  });
});

describe('MediaDeliveryHandler', () => {
  it('accepts a MediaManager and delegates to its library', async () => {
    const { manager } = makeManager({ deliveryMode: 'public' });
    const record = await attach(manager);

    const handler = new MediaDeliveryHandler({ library: manager });
    const result = await handler.handle({ mediaId: record.id });

    expect(result).toEqual({ kind: 'redirect', url: `memory://fs/${record.path}` });
  });

  it('accepts a MediaLibrary directly', async () => {
    const { manager } = makeManager({ deliveryMode: 'proxy' });
    const record = await attach(manager);

    const handler = new MediaDeliveryHandler({ library: manager.library });

    expect((await handler.handle({ mediaId: record.id })).kind).toBe('stream');
  });

  it('overrides the library-configured mode with its own', async () => {
    const { manager } = makeManager({ deliveryMode: 'public' });
    const record = await attach(manager);

    const handler = new MediaDeliveryHandler({ library: manager, mode: 'proxy' });

    expect((await handler.handle({ mediaId: record.id })).kind).toBe('stream');
  });

  it('passes its signedTtlSeconds through to the signed URL', async () => {
    const { manager, disks } = makeManager({ deliveryMode: 'signed' });
    const record = await attach(manager);

    await new MediaDeliveryHandler({ library: manager, signedTtlSeconds: 42 }).handle({
      mediaId: record.id,
    });

    expect(disks.fs?.lastSignedUrlOptions).toEqual({ expiresIn: 42 });
  });

  it('forwards a requested conversion', async () => {
    const { manager } = makeManager({
      collections: [{ name: 'gallery', conversions: [{ name: 'thumb', width: 50 }] }],
      deliveryMode: 'public',
      imageProcessor: new FakeImageProcessor(),
    });
    const record = await manager.library.attach({
      ownerType: 'Post',
      ownerId: 1,
      collection: 'gallery',
      fileName: 'photo.png',
      mimeType: 'image/png',
      contents: Buffer.from('png-bytes'),
    });

    const result = await new MediaDeliveryHandler({ library: manager }).handle({
      mediaId: record.id,
      conversion: 'thumb',
    });

    expect(result.kind === 'redirect' && result.url).toContain('/conversions/thumb.');
  });

  /**
   * The load-bearing half of the TusUploadHandler split: the handler answers "how do these bytes
   * reach the client", never "may this caller have them". If it ever grew an owner/permission check
   * of its own, apps would start relying on a guarantee it cannot make.
   */
  it('performs NO authorization — it serves any id it is handed, from any owner', async () => {
    const { manager } = makeManager({ deliveryMode: 'proxy' });
    const mine = await manager.library.attach({
      ownerType: 'Patient',
      ownerId: 1,
      collection: 'docs',
      fileName: 'mine.txt',
      mimeType: 'text/plain',
      contents,
    });
    const someoneElses = await manager.library.attach({
      ownerType: 'Patient',
      ownerId: 999,
      collection: 'docs',
      fileName: 'theirs.txt',
      mimeType: 'text/plain',
      contents,
    });

    const handler = new MediaDeliveryHandler({ library: manager });

    // No caller identity is even expressible in the request shape.
    expect((await handler.handle({ mediaId: mine.id })).kind).toBe('stream');
    expect((await handler.handle({ mediaId: someoneElses.id })).kind).toBe('stream');
  });
});
