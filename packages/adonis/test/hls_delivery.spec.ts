import { describe, expect, it } from 'vitest';
import { MediaNotFoundError, TransformNotReadyError } from '../src/errors.js';
import { HlsDeliveryHandler } from '../src/hls/delivery.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { FakeTransformer } from '../src/testing/fake_transformer.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

const MASTER = [
  '#EXTM3U',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="pt",DEFAULT=YES,URI="audio-pt.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="aac"',
  'playlist-1.m3u8',
  'https://cdn.example.com/external.m3u8',
].join('\n');

const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-TARGETDURATION:4',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:4.000,',
  'segment-1-0.ts',
  '#EXTINF:2.500,',
  'segment-1-1.ts',
  '#EXTINF:1.000,',
  'not-in-package.ts',
  '#EXT-X-ENDLIST',
].join('\n');

async function makeDeliverable() {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const storage = new StorageManager({ default: 'fs', resolve });
  const store = new InMemoryMediaStore();
  const hls = new FakeTransformer({
    name: 'hls',
    artifacts: {
      'index.m3u8': MASTER,
      'playlist-1.m3u8': MEDIA_PLAYLIST,
      'audio-pt.m3u8': '#EXTM3U\nsegment-a-0.ts',
      'segment-1-0.ts': 'seg-1-0',
      'segment-1-1.ts': 'seg-1-1',
      'segment-a-0.ts': 'seg-a-0',
      'init.mp4': 'init-bytes',
    },
    entry: 'index.m3u8',
  });
  const library = new MediaLibrary({
    storage,
    store,
    collections: [{ name: 'videos', transformers: [hls] }],
    idGenerator: () => 'vid-1',
    emitDiagnostics: false,
  });
  const record = await library.attach({
    ownerType: 'Course',
    ownerId: '1',
    collection: 'videos',
    fileName: 'lesson.mp4',
    mimeType: 'video/mp4',
    contents: Buffer.from('fake-mp4'),
  });
  await library.transform(record.id, 'hls');
  return { library, record, disks };
}

const urlForPlaylist = ({ mediaId, file }: { mediaId: string; file: string }) =>
  `/api/videos/${mediaId}/hls/${file}`;

describe('HlsDeliveryHandler: playlists', () => {
  it('serves the entry playlist by default, routing sub-playlists through urlForPlaylist and leaving absolute refs alone', async () => {
    const { library, record } = await makeDeliverable();
    const handler = new HlsDeliveryHandler({ library, urlForPlaylist });

    const result = await handler.handle({ mediaId: record.id });
    expect(result.kind).toBe('playlist');
    if (result.kind !== 'playlist') throw new Error('unreachable');
    expect(result.contentType).toBe('application/vnd.apple.mpegurl');
    expect(result.fileName).toBe('index.m3u8');
    expect(result.content).toContain(`/api/videos/${record.id}/hls/playlist-1.m3u8`);
    expect(result.content).toContain(`URI="/api/videos/${record.id}/hls/audio-pt.m3u8"`);
    expect(result.content).toContain('https://cdn.example.com/external.m3u8');
  });

  it('rewrites media playlist segments (and EXT-X-MAP) to presigned disk URLs by default', async () => {
    const { library, record } = await makeDeliverable();
    const handler = new HlsDeliveryHandler({ library, urlForPlaylist, segmentTtlSeconds: 120 });

    const result = await handler.handle({ mediaId: record.id, file: 'playlist-1.m3u8' });
    if (result.kind !== 'playlist') throw new Error(`expected playlist, got ${result.kind}`);
    const prefix = `Course/1/videos/${record.id}/conversions/hls/`;
    // the in-memory disk renders signed URLs as <base>/<key>?signature=fake&expires=<ttl>
    expect(result.content).toContain(
      `memory://fs/${prefix}segment-1-0.ts?signature=fake&expires=120`,
    );
    expect(result.content).toContain(
      `memory://fs/${prefix}segment-1-1.ts?signature=fake&expires=120`,
    );
    expect(result.content).toContain(
      `#EXT-X-MAP:URI="memory://fs/${prefix}init.mp4?signature=fake&expires=120"`,
    );
    // a reference the transformer never wrote is not ours: untouched
    expect(result.content).toContain('\nnot-in-package.ts');
    // timing tags untouched
    expect(result.content).toContain('#EXTINF:4.000,');
  });

  it('uses urlForSegment when provided instead of presigning', async () => {
    const { library, record } = await makeDeliverable();
    const handler = new HlsDeliveryHandler({
      library,
      urlForPlaylist,
      urlForSegment: ({ mediaId, file }) => `/api/videos/${mediaId}/hls/${file}`,
    });

    const result = await handler.handle({ mediaId: record.id, file: 'playlist-1.m3u8' });
    if (result.kind !== 'playlist') throw new Error('expected playlist');
    expect(result.content).toContain(`/api/videos/${record.id}/hls/segment-1-0.ts`);
    expect(result.content).not.toContain('signature=fake');
  });

  it('serves a named sub-playlist (rewritten) — the handler is reentrant for every hop', async () => {
    const { library, record } = await makeDeliverable();
    const handler = new HlsDeliveryHandler({ library, urlForPlaylist });
    const result = await handler.handle({ mediaId: record.id, file: 'audio-pt.m3u8' });
    if (result.kind !== 'playlist') throw new Error('expected playlist');
    expect(result.content).toContain('signature=fake');
  });
});

describe('HlsDeliveryHandler: media files', () => {
  it('redirects a segment request to a presigned URL by default', async () => {
    const { library, record } = await makeDeliverable();
    const handler = new HlsDeliveryHandler({ library, urlForPlaylist });
    const result = await handler.handle({ mediaId: record.id, file: 'segment-1-0.ts' });
    expect(result.kind).toBe('redirect');
    if (result.kind !== 'redirect') throw new Error('unreachable');
    expect(result.url).toContain('segment-1-0.ts?signature=fake');
  });

  it('streams a segment when segmentDelivery is "stream"', async () => {
    const { library, record } = await makeDeliverable();
    const handler = new HlsDeliveryHandler({
      library,
      urlForPlaylist,
      segmentDelivery: 'stream',
    });
    const result = await handler.handle({ mediaId: record.id, file: 'segment-1-0.ts' });
    if (result.kind !== 'stream') throw new Error(`expected stream, got ${result.kind}`);
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString('utf8')).toBe('seg-1-0');
    expect(result.size).toBe(7);
    expect(result.fileName).toBe('segment-1-0.ts');
  });
});

describe('HlsDeliveryHandler: guardrails', () => {
  it('rejects a file the package does not contain — traversal is structurally impossible', async () => {
    const { library, record } = await makeDeliverable();
    const handler = new HlsDeliveryHandler({ library, urlForPlaylist });
    for (const hostile of ['other.ts', '../lesson.mp4', '../../secrets.txt', 'index.m3u8/../x']) {
      await expect(handler.handle({ mediaId: record.id, file: hostile })).rejects.toBeInstanceOf(
        MediaNotFoundError,
      );
    }
  });

  it('throws TransformNotReadyError before the conversion is generated', async () => {
    const { resolve } = inMemoryDiskResolver(['fs']);
    const storage = new StorageManager({ default: 'fs', resolve });
    const library = new MediaLibrary({
      storage,
      store: new InMemoryMediaStore(),
      collections: [{ name: 'videos', transformers: [new FakeTransformer({ name: 'hls' })] }],
      emitDiagnostics: false,
    });
    const record = await library.attach({
      ownerType: 'Course',
      ownerId: '1',
      collection: 'videos',
      fileName: 'lesson.mp4',
      mimeType: 'video/mp4',
      contents: Buffer.from('x'),
    });
    const handler = new HlsDeliveryHandler({ library, urlForPlaylist });
    await expect(handler.handle({ mediaId: record.id })).rejects.toBeInstanceOf(
      TransformNotReadyError,
    );
  });

  it('throws MediaNotFoundError for an unknown media id', async () => {
    const { library } = await makeDeliverable();
    const handler = new HlsDeliveryHandler({ library, urlForPlaylist });
    await expect(handler.handle({ mediaId: 'ghost' })).rejects.toBeInstanceOf(MediaNotFoundError);
  });
});
