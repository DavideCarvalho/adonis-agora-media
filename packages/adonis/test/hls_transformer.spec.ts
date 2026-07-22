import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HlsDeliveryHandler } from '../src/hls/delivery.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import { HlsTransformer } from '../src/transformers/hls.js';
import type { HlsRemuxEngine, HlsRemuxRequest } from '../src/transformers/hls.js';
import { MetadataProbeTransformer } from '../src/transformers/probe.js';

function makeLibrary(transformer: HlsTransformer<string> | MetadataProbeTransformer<string>) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const storage = new StorageManager({ default: 'fs', resolve });
  const store = new InMemoryMediaStore();
  const library = new MediaLibrary({
    storage,
    store,
    collections: [{ name: 'videos', transformers: [transformer] }],
    idGenerator: () => 'vid-1',
    emitDiagnostics: false,
  });
  return { library, disks };
}

async function attachFixture(library: MediaLibrary, contents: Buffer, fileName = 'lesson.mp4') {
  return library.attach({
    ownerType: 'Course',
    ownerId: '1',
    collection: 'videos',
    fileName,
    mimeType: 'video/mp4',
    contents,
  });
}

describe('HlsTransformer orchestration (fake engine)', () => {
  it('materializes the source, uploads the whole package with HLS content types, and persists meta', async () => {
    const original = Buffer.from('original-mp4-bytes');
    const requests: HlsRemuxRequest[] = [];
    const engine: HlsRemuxEngine = {
      async remux(request) {
        requests.push(request);
        // the engine receives the ORIGINAL bytes as a local file
        expect(await readFile(request.sourcePath)).toEqual(original);
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(request.outputDir, request.entryName), '#EXTM3U\nplaylist-1.m3u8');
        await writeFile(join(request.outputDir, 'playlist-1.m3u8'), '#EXTM3U\nsegment-1-0.ts');
        await writeFile(join(request.outputDir, 'segment-1-0.ts'), 'ts-bytes');
        return {
          durationSeconds: 7.5,
          width: 640,
          height: 360,
          videoCodec: 'avc',
          audioCodec: 'aac',
        };
      },
    };
    const transformer = new HlsTransformer({ engine, targetDuration: 6 });
    const { library, disks } = makeLibrary(transformer);
    const record = await attachFixture(library, original);

    const updated = await library.transform(record.id, 'hls');

    expect(requests[0]?.entryName).toBe('index.m3u8');
    expect(requests[0]?.targetDuration).toBe(6);

    const prefix = 'Course/1/videos/vid-1/conversions/hls/';
    const conversion = updated.conversions.hls;
    expect(conversion?.path).toBe(`${prefix}index.m3u8`);
    expect(conversion?.files).toEqual(['index.m3u8', 'playlist-1.m3u8', 'segment-1-0.ts']);
    expect(conversion?.meta).toEqual({
      durationSeconds: 7.5,
      width: 640,
      height: 360,
      videoCodec: 'avc',
      audioCodec: 'aac',
      segmentCount: 1,
      playlistCount: 2,
      targetDuration: 6,
    });

    // artifacts uploaded with the right content types (streamed with a declared length)
    expect(disks.fs.files.get(`${prefix}index.m3u8`)?.contentType).toBe(
      'application/vnd.apple.mpegurl',
    );
    expect(disks.fs.files.get(`${prefix}segment-1-0.ts`)?.contentType).toBe('video/mp2t');
    expect(disks.fs.files.get(`${prefix}segment-1-0.ts`)?.contentLength).toBe(8);
  });

  it('hands the configured WebCodecs provider through to the engine', async () => {
    const provider = async () => ({ VideoEncoder: class {} });
    let received: HlsRemuxRequest | undefined;
    const engine: HlsRemuxEngine = {
      async remux(request) {
        received = request;
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(request.outputDir, request.entryName), '#EXTM3U');
        return {};
      },
    };
    const transformer = new HlsTransformer({ engine, webcodecs: provider });
    const { library } = makeLibrary(transformer);
    const record = await attachFixture(library, Buffer.from('bytes'));
    await library.transform(record.id, 'hls');
    expect(received?.webcodecs).toBe(provider);
  });

  it('supports a custom conversion name', async () => {
    const engine: HlsRemuxEngine = {
      async remux(request) {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(request.outputDir, request.entryName), '#EXTM3U');
        return {};
      },
    };
    const transformer = new HlsTransformer({ name: 'stream', engine });
    const { library } = makeLibrary(transformer);
    const record = await attachFixture(library, Buffer.from('bytes'));
    const updated = await library.transform(record.id, 'stream');
    expect(updated.conversions.stream?.prefix).toBe('Course/1/videos/vid-1/conversions/stream/');
  });
});

// The real engine: mediabunny is pure JS (no ffmpeg binary, no WebCodecs needed for remux), so the
// full pipeline runs in CI against a 12 KB h264/aac fixture. This is the test that proves the
// production path — including the AAC-priming trim gotcha — not a mock of it.
describe('HlsTransformer with the real mediabunny engine', () => {
  it('remuxes an h264/aac mp4 into a served HLS package', async () => {
    const fixture = await readFile(join(import.meta.dirname, 'fixtures', 'tiny_h264_aac.mp4'));
    const transformer = new HlsTransformer();
    const { library, disks } = makeLibrary(transformer);
    const record = await attachFixture(library, fixture, 'tiny.mp4');

    const updated = await library.transform(record.id, 'hls');
    const conversion = updated.conversions.hls;
    expect(conversion?.path).toBe('Course/1/videos/vid-1/conversions/hls/index.m3u8');

    const files = conversion?.files ?? [];
    expect(files).toContain('index.m3u8');
    expect(files.some((f) => f.endsWith('.ts'))).toBe(true);
    expect(files.filter((f) => f.endsWith('.m3u8')).length).toBeGreaterThanOrEqual(2);

    // playlists are genuine m3u8
    const master = Buffer.from(
      await disks.fs.getBytes('Course/1/videos/vid-1/conversions/hls/index.m3u8'),
    ).toString('utf8');
    expect(master).toContain('#EXTM3U');

    // metadata extracted from the real file
    const meta = conversion?.meta as Record<string, number | string>;
    expect(meta.durationSeconds).toBeGreaterThan(1);
    expect(meta.durationSeconds).toBeLessThan(3);
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
    expect(String(meta.videoCodec)).toContain('avc');
    expect(String(meta.audioCodec)).toContain('aac');
    expect(meta.segmentCount).toBeGreaterThanOrEqual(1);

    // and the delivery handler serves the package end to end
    const handler = new HlsDeliveryHandler({
      library,
      urlForPlaylist: ({ mediaId, file }) => `/videos/${mediaId}/hls/${file}`,
    });
    const served = await handler.handle({ mediaId: record.id });
    if (served.kind !== 'playlist') throw new Error('expected playlist');
    expect(served.content).toContain(`/videos/${record.id}/hls/`);
  }, 60_000);

  it('probes the fixture with the real MetadataProbeTransformer (metadata-only shape)', async () => {
    const fixture = await readFile(join(import.meta.dirname, 'fixtures', 'tiny_h264_aac.mp4'));
    const transformer = new MetadataProbeTransformer();
    const { library, disks } = makeLibrary(transformer);
    const record = await attachFixture(library, fixture, 'tiny.mp4');
    const before = disks.fs.files.size;

    const updated = await library.transform(record.id, 'probe');
    const conversion = updated.conversions.probe;
    expect(conversion?.path).toBeUndefined();
    expect(disks.fs.files.size).toBe(before); // wrote nothing

    const meta = conversion?.meta as Record<string, unknown>;
    expect(meta.hasVideo).toBe(true);
    expect(meta.hasAudio).toBe(true);
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
    expect(meta.durationSeconds).toBeGreaterThan(1);
    expect(String(meta.audioCodec)).toContain('aac');
    expect(typeof meta.audioSampleRate).toBe('number');
  }, 60_000);
});
