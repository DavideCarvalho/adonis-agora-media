import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { transformers } from '../src/define_config.js';
import { type DeliveryRequest, MediaDeliveryHandler } from '../src/delivery.js';
import type { DeliverySigningConfig } from '../src/delivery_signing.js';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaLibrary } from '../src/media_library.js';
import { SharpImageProcessor } from '../src/processors/sharp.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

// Mid-window: the URL changes once per window, at its boundary (12:00 here would be one).
const T0 = Date.UTC(2026, 9, 23, 12, 1, 40);

function setup(signing?: DeliverySigningConfig, collections?: MediaCollectionConfig[]) {
  const { resolve } = inMemoryDiskResolver(['fs']);
  const storage = new StorageManager({ default: 'fs', resolve });
  let now = T0;
  let counter = 0;
  const library = new MediaLibrary({
    storage,
    store: new InMemoryMediaStore(),
    collections: collections ?? [
      {
        name: 'photos',
        conversions: [{ name: 'thumb', width: 100, eager: true }],
        transformers: [transformers.placeholder()],
      },
    ],
    imageProcessor: new SharpImageProcessor(),
    idGenerator: () => `id-${++counter}`,
    emitDiagnostics: false,
    deliveryMode: 'public',
    clock: () => new Date(now),
    ...(signing ? { deliverySigning: signing } : {}),
  });
  const handler = new MediaDeliveryHandler({ library });
  return {
    library,
    handler,
    advance: (seconds: number) => {
      now += seconds * 1000;
    },
  };
}

async function attachPhoto(library: MediaLibrary, width = 1000, height = 500) {
  const png = await sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 90, b: 160 } },
  })
    .png()
    .toBuffer();
  return library.attach({
    ownerType: 'User',
    ownerId: '1',
    collection: 'photos',
    fileName: 'a.png',
    mimeType: 'image/png',
    contents: png,
  });
}

/** What a route hands the handler: `:id` from the path, the rest from the query string. */
function requestFor(url: string): DeliveryRequest {
  const parsed = new URL(url, 'http://app.test');
  const q = parsed.searchParams;
  return {
    mediaId: decodeURIComponent(parsed.pathname.split('/').at(-1)!),
    conversion: q.get('conversion') ?? undefined,
    width: q.get('w') ?? undefined,
    quality: q.get('q') ?? undefined,
    expires: q.get('exp') ?? undefined,
    signature: q.get('sig') ?? undefined,
  };
}

const SECRET = 'test-secret-0123456789';

describe('delivery URLs without signing', () => {
  it('are plain route URLs, and unsigned requests keep the width whitelist', async () => {
    const { library, handler } = setup();
    const record = await attachPhoto(library);
    expect(library.deliveryUrl(record.id, { width: 640 })).toBe('/media/id-1?w=640');
    await expect(handler.handle(requestFor('/media/id-1?w=500'))).rejects.toMatchObject({
      code: 'E_MEDIA_IMAGE_SIZE_NOT_ALLOWED',
    });
  });
});

describe('signed delivery URLs (delivery.signing)', () => {
  it('serve exactly what was signed — any width, since the app chose it', async () => {
    const { library, handler } = setup({ secret: SECRET });
    const record = await attachPhoto(library);

    const url = library.deliveryUrl(record.id, { width: 500 });
    expect(url).toMatch(/^\/media\/id-1\?w=500&exp=\d+&sig=[\w-]+$/);

    const result = await handler.handle(requestFor(url));
    expect(result).toMatchObject({ kind: 'redirect' });
    expect((result as { url: string }).url).toContain('/conversions/@w500q75-webp.webp');
  });

  it('refuse a tampered URL: another width, another record, another secret', async () => {
    const { library, handler } = setup({ secret: SECRET });
    await attachPhoto(library);
    await attachPhoto(library);
    const url = library.deliveryUrl('id-1', { width: 500 });

    const widened = requestFor(url.replace('w=500', 'w=3000'));
    await expect(handler.handle(widened)).rejects.toMatchObject({
      code: 'E_MEDIA_DELIVERY_SIGNATURE',
      reason: 'invalid',
    });
    await expect(handler.handle({ ...requestFor(url), mediaId: 'id-2' })).rejects.toMatchObject({
      reason: 'invalid',
    });

    const other = setup({ secret: 'another-secret' });
    await expect(other.handler.handle(requestFor(url))).rejects.toMatchObject({
      reason: 'invalid',
    });
  });

  it('expire: valid for at least `expiresIn`, at most twice that, then refused', async () => {
    const { library, handler, advance } = setup({ secret: SECRET, expiresIn: 600 });
    await attachPhoto(library);
    const url = library.deliveryUrl('id-1');

    advance(599);
    await expect(handler.handle(requestFor(url))).resolves.toMatchObject({ kind: 'redirect' });
    advance(1201);
    await expect(handler.handle(requestFor(url))).rejects.toMatchObject({ reason: 'expired' });
  });

  it('round the expiry, so a page rendered twice in the window gets the same URL', () => {
    const { library, advance } = setup({ secret: SECRET, expiresIn: 3600 });
    const first = library.deliveryUrl('id-1', { width: 640 });
    advance(60);
    expect(library.deliveryUrl('id-1', { width: 640 })).toBe(first);
    const exp = Number(new URL(first, 'http://x').searchParams.get('exp'));
    expect(exp % 3600).toBe(0);
  });

  it('refuse unsigned requests by default; `required: false` lets them through the whitelist', async () => {
    const strict = setup({ secret: SECRET });
    await attachPhoto(strict.library);
    await expect(strict.handler.handle({ mediaId: 'id-1' })).rejects.toMatchObject({
      reason: 'missing',
    });
    await expect(
      strict.handler.handle({ mediaId: 'id-1', signature: 'abc' }),
    ).rejects.toMatchObject({ reason: 'invalid' });

    const lenient = setup({ secret: SECRET, required: false });
    await attachPhoto(lenient.library);
    await expect(lenient.handler.handle({ mediaId: 'id-1', width: '640' })).resolves.toMatchObject({
      kind: 'redirect',
    });
    await expect(lenient.handler.handle({ mediaId: 'id-1', width: '500' })).rejects.toMatchObject({
      code: 'E_MEDIA_IMAGE_SIZE_NOT_ALLOWED',
    });
  });

  it('sign the conversion too', async () => {
    const { library, handler } = setup({ secret: SECRET });
    await attachPhoto(library);
    const url = library.deliveryUrl('id-1', { conversion: 'thumb' });
    expect(url).toContain('conversion=thumb');
    const result = await handler.handle(requestFor(url));
    expect((result as { url: string }).url).toContain('/conversions/thumb.webp');
    await expect(
      handler.handle({ ...requestFor(url), conversion: undefined }),
    ).rejects.toMatchObject({ reason: 'invalid' });
  });
});

describe('media.library.image() with signing', () => {
  it('onDemand: a srcset of signed resize URLs up to the original, which closes it', async () => {
    const { library, handler } = setup({ secret: SECRET });
    await attachPhoto(library, 1000, 500);

    const image = await library.image('id-1', { onDemand: { widths: [320, 500, 800, 1200] } });

    const candidates = image.srcSet!.split(', ').map((c) => c.split(' '));
    expect(candidates.map(([, w]) => w)).toEqual(['320w', '500w', '800w', '1000w']);
    expect(image.src).toBe(candidates.at(-1)![0]);
    expect(image).toMatchObject({ width: 1000, height: 500 });
    for (const [url] of candidates) {
      await expect(handler.handle(requestFor(url!))).resolves.toMatchObject({ kind: 'redirect' });
    }
  });

  it('presets: every URL goes through the signed route, never a storage URL', async () => {
    const { library, handler } = setup({ secret: SECRET });
    await attachPhoto(library, 1000, 500);

    const image = await library.image('id-1');

    expect(image.srcSet).toMatch(
      /^\/media\/id-1\?conversion=thumb&exp=\d+&sig=\S+ 100w, \/media\/id-1\?exp=\d+&sig=\S+ 1000w$/,
    );
    for (const candidate of image.srcSet!.split(', ')) {
      const url = candidate.split(' ')[0]!;
      await expect(handler.handle(requestFor(url))).resolves.toMatchObject({ kind: 'redirect' });
    }
  });

  it('onDemand on an SVG: just the signed original', async () => {
    const { library } = setup({ secret: SECRET }, [{ name: 'photos' }]);
    await library.attach({
      ownerType: 'User',
      ownerId: '1',
      collection: 'photos',
      fileName: 'logo.svg',
      mimeType: 'image/svg+xml',
      contents: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),
    });
    const image = await library.image('id-1', { onDemand: true });
    expect(image.srcSet).toBeUndefined();
    expect(image.src).toMatch(/^\/media\/id-1\?exp=\d+&sig=/);
  });
});
