import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MediaLibrary } from '../src/media_library.js';
import type { MediaRecord } from '../src/media_record.js';
import { StorageManager } from '../src/storage_manager.js';
import { streamEntries } from '../src/streaming.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import { MetadataProbeTransformer } from '../src/transformers/probe.js';
import {
  type VideoPackageRequest,
  type VideoPackagingEngine,
  VideoTransformer,
} from '../src/transformers/video.js';

function makeLibrary(transformer: VideoTransformer<string> | MetadataProbeTransformer<string>) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const library = new MediaLibrary({
    storage: new StorageManager({ default: 'fs', resolve }),
    store: new InMemoryMediaStore(),
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

/** A fake engine writing whatever manifests it is asked for, over CMAF or TS segments. */
function fakeEngine(requests: VideoPackageRequest[] = []): VideoPackagingEngine {
  return {
    async package(request) {
      requests.push(request);
      const ext = request.segments === 'ts' ? 'ts' : 'm4s';
      await mkdir(join(request.outputDir, 'video'), { recursive: true });
      if (request.segments === 'cmaf') {
        await writeFile(join(request.outputDir, 'video', 'init-1.m4s'), 'init');
      }
      await writeFile(join(request.outputDir, 'video', `segment-1-1.${ext}`), 'segment');
      if (request.hlsEntry) {
        await writeFile(join(request.outputDir, request.hlsEntry), '#EXTM3U');
        await writeFile(join(request.outputDir, 'video', 'playlist-1.m3u8'), '#EXTM3U');
      }
      if (request.dashManifest) {
        await writeFile(join(request.outputDir, request.dashManifest), '<MPD/>');
      }
      return {
        durationSeconds: 7.5,
        width: 640,
        height: 360,
        videoCodec: 'avc',
        audioCodec: 'aac',
      };
    },
  };
}

const prefix = 'Course/1/videos/vid-1/conversions/video/';

describe('transformers.video() orchestration (fake engine)', () => {
  it('by default packages CMAF with both manifests, and records both', async () => {
    const original = Buffer.from('original-mp4-bytes');
    const requests: VideoPackageRequest[] = [];
    const engine: VideoPackagingEngine = {
      async package(request) {
        // the engine receives the ORIGINAL bytes as a local file
        expect(await readFile(request.sourcePath)).toEqual(original);
        return fakeEngine(requests).package(request);
      },
    };
    const { library, disks } = makeLibrary(new VideoTransformer({ engine, targetDuration: 6 }));
    const record = await attachFixture(library, original);

    const updated = await library.transform(record.id, 'video');

    expect(requests[0]).toMatchObject({
      segments: 'cmaf',
      hlsEntry: 'index.m3u8',
      dashManifest: 'manifest.mpd',
      targetDuration: 6,
    });
    const conversion = updated.conversions.video!;
    expect(conversion.path).toBe(`${prefix}index.m3u8`);
    expect(conversion.files).toEqual([
      'index.m3u8',
      'manifest.mpd',
      'video/init-1.m4s',
      'video/playlist-1.m3u8',
      'video/segment-1-1.m4s',
    ]);
    expect(conversion.meta).toEqual({
      durationSeconds: 7.5,
      width: 640,
      height: 360,
      videoCodec: 'avc',
      audioCodec: 'aac',
      segments: 'cmaf',
      segmentCount: 1,
      targetDuration: 6,
      hlsEntry: 'index.m3u8',
      dashManifest: 'manifest.mpd',
    });
    expect(streamEntries(updated).map((e) => `${e.format}:${e.file}`)).toEqual([
      'hls:index.m3u8',
      'dash:manifest.mpd',
    ]);
    expect(disks.fs.files.get(`${prefix}manifest.mpd`)?.contentType).toBe('application/dash+xml');
    expect(disks.fs.files.get(`${prefix}video/segment-1-1.m4s`)?.contentType).toBe('video/mp4');
    expect(disks.fs.files.get(`${prefix}video/segment-1-1.m4s`)?.contentLength).toBe(7);
  });

  it('packages HLS over TS segments', async () => {
    const requests: VideoPackageRequest[] = [];
    const transformer = new VideoTransformer({
      engine: fakeEngine(requests),
      segments: 'ts',
      formats: ['hls'],
    });
    const { library, disks } = makeLibrary(transformer);
    const record = await attachFixture(library, Buffer.from('x'));
    const updated = await library.transform(record.id, 'video');

    expect(requests[0]).toMatchObject({ segments: 'ts', hlsEntry: 'index.m3u8' });
    expect(requests[0]?.dashManifest).toBeUndefined();
    expect(updated.conversions.video?.meta).toMatchObject({
      segments: 'ts',
      hlsEntry: 'index.m3u8',
    });
    expect(updated.conversions.video?.meta?.dashManifest).toBeUndefined();
    expect(disks.fs.files.get(`${prefix}video/segment-1-1.ts`)?.contentType).toBe('video/mp2t');
  });

  it('a DASH-only package has the MPD as its entry', async () => {
    const { library } = makeLibrary(
      new VideoTransformer({ engine: fakeEngine(), formats: ['dash'] }),
    );
    const record = await attachFixture(library, Buffer.from('x'));
    const updated = await library.transform(record.id, 'video');
    expect(updated.conversions.video?.path).toBe(`${prefix}manifest.mpd`);
    expect(streamEntries(updated).map((e) => e.format)).toEqual(['dash']);
  });

  it('refuses DASH over TS, and no format at all, when configured', () => {
    expect(() => new VideoTransformer({ segments: 'ts' })).toThrow(/DASH cannot use TS segments/);
    expect(() => new VideoTransformer({ formats: [] })).toThrow(/`formats` is empty/);
  });

  it('fails when the engine did not write a manifest it was asked for', async () => {
    const lazy: VideoPackagingEngine = {
      async package(request) {
        await writeFile(join(request.outputDir, 'index.m3u8'), '#EXTM3U');
        return {};
      },
    };
    const { library } = makeLibrary(new VideoTransformer({ engine: lazy }));
    const record = await attachFixture(library, Buffer.from('x'));
    await expect(library.transform(record.id, 'video')).rejects.toThrow(
      /did not write the DASH manifest "manifest.mpd"/,
    );
  });

  it('hands the WebCodecs provider through, and supports a custom name', async () => {
    const provider = async () => ({ VideoEncoder: class {} });
    const requests: VideoPackageRequest[] = [];
    const { library } = makeLibrary(
      new VideoTransformer({ name: 'lesson', engine: fakeEngine(requests), webcodecs: provider }),
    );
    const record = await attachFixture(library, Buffer.from('bytes'));
    const updated = await library.transform(record.id, 'lesson');
    expect(requests[0]?.webcodecs).toBe(provider);
    expect(updated.conversions.lesson?.prefix).toBe('Course/1/videos/vid-1/conversions/lesson/');
  });
});

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const hasFfmpeg = hasBinary('ffmpeg') && hasBinary('ffprobe');

/** Copy a stored package to a temp directory, so a real player (ffmpeg) can read it. */
async function exportPackage(
  disks: ReturnType<typeof inMemoryDiskResolver>['disks'],
  record: MediaRecord,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agora-video-'));
  const conversion = record.conversions.video!;
  for (const file of conversion.files!) {
    await mkdir(dirname(join(dir, file)), { recursive: true });
    await writeFile(join(dir, file), await disks.fs!.getBytes(`${conversion.prefix}${file}`));
  }
  return dir;
}

/**
 * Decode a manifest end to end with ffmpeg (any broken reference or segment fails it), and
 * return the stream types ffprobe finds in it.
 */
function decode(manifest: string): string[] {
  const flags = ['-hide_banner', '-v', 'error', '-allowed_extensions', 'ALL'];
  execFileSync('ffmpeg', [...flags, '-i', manifest, '-f', 'null', '-'], { stdio: 'pipe' });
  const types = execFileSync(
    'ffprobe',
    [...flags, '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', manifest],
    { encoding: 'utf8' },
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  // ffprobe lists a stream once more per program it belongs to.
  return [...new Set(types)].sort();
}

// The real engine: mediabunny is pure JS (no ffmpeg binary, no WebCodecs needed for remux), so the
// full pipeline runs in CI against a 12 KB h264/aac fixture — including the AAC-priming trim
// gotcha. Where ffmpeg exists, the package is also decoded by a real player, over both manifests.
describe('transformers.video() with the real mediabunny engine', () => {
  it('remuxes an h264/aac mp4 into a CMAF package with an HLS master and a DASH manifest', async () => {
    const fixture = await readFile(join(import.meta.dirname, 'fixtures', 'tiny_h264_aac.mp4'));
    const { library, disks } = makeLibrary(new VideoTransformer());
    const record = await attachFixture(library, fixture, 'tiny.mp4');

    const updated = await library.transform(record.id, 'video');
    const conversion = updated.conversions.video!;
    const files = conversion.files!;
    expect(files).toEqual(
      expect.arrayContaining([
        'index.m3u8',
        'manifest.mpd',
        'video/init-1.m4s',
        'video/playlist-1.m3u8',
        'audio/init-1.m4s',
        'audio/playlist-1.m3u8',
      ]),
    );
    // One track per playlist: no muxed audio/video (dash.js cannot play that).
    expect(files.filter((f) => f.endsWith('index.m3u8'))).toEqual(['index.m3u8']);

    const read = async (file: string) =>
      Buffer.from(await disks.fs!.getBytes(`${conversion.prefix}${file}`)).toString('utf8');
    const master = await read('index.m3u8');
    expect(master).toContain('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio"');
    expect(master).toContain('URI="audio/playlist-1.m3u8"');
    expect(master).toMatch(/CODECS="avc1\.[^,"]+,mp4a\.40\.2"/);
    expect(master).toContain('RESOLUTION=64x64');
    const mpd = await read('manifest.mpd');
    expect(mpd).toContain('<Initialization sourceURL="video/init-1.m4s"/>');
    expect(mpd).toContain('contentType="audio"');
    // Every segment the MPD names is one the transformer wrote.
    for (const match of mpd.matchAll(/(?:media|sourceURL)="([^"]+)"/g)) {
      expect(files).toContain(match[1]);
    }

    const meta = conversion.meta as Record<string, number | string>;
    expect(meta.durationSeconds).toBeGreaterThan(1);
    expect(meta.width).toBe(64);
    expect(String(meta.videoCodec)).toContain('avc');
    expect(String(meta.audioCodec)).toContain('aac');
    expect(meta.segmentCount).toBeGreaterThanOrEqual(2);

    if (hasFfmpeg) {
      const dir = await exportPackage(disks, updated);
      try {
        expect(decode(join(dir, 'manifest.mpd'))).toEqual(['audio', 'video']);
        expect(decode(join(dir, 'index.m3u8'))).toEqual(['audio', 'video']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('remuxes into HLS over TS segments, audio and video muxed together', async () => {
    const fixture = await readFile(join(import.meta.dirname, 'fixtures', 'tiny_h264_aac.mp4'));
    const { library, disks } = makeLibrary(
      new VideoTransformer({ segments: 'ts', formats: ['hls'] }),
    );
    const record = await attachFixture(library, fixture, 'tiny.mp4');
    const updated = await library.transform(record.id, 'video');
    const files = updated.conversions.video!.files!;
    expect(files).toContain('index.m3u8');
    expect(files.some((f) => f.endsWith('.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('.m4s') || f.endsWith('.mpd'))).toBe(false);

    if (hasFfmpeg) {
      const dir = await exportPackage(disks, updated);
      try {
        expect(decode(join(dir, 'index.m3u8'))).toEqual(['audio', 'video']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('a DASH-only CMAF package drops the HLS scaffolding', async () => {
    const fixture = await readFile(join(import.meta.dirname, 'fixtures', 'tiny_h264_aac.mp4'));
    const { library } = makeLibrary(new VideoTransformer({ formats: ['dash'] }));
    const record = await attachFixture(library, fixture, 'tiny.mp4');
    const updated = await library.transform(record.id, 'video');
    const files = updated.conversions.video!.files!;
    expect(files).toContain('manifest.mpd');
    expect(files.some((f) => f.endsWith('.m3u8'))).toBe(false);
  }, 60_000);

  it.skipIf(!hasFfmpeg)(
    'packages a video without audio: no audio playlist, no audio group',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agora-silent-'));
      try {
        const source = join(dir, 'silent.mp4');
        execFileSync('ffmpeg', [
          '-hide_banner',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc=size=128x72:rate=25:duration=2',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          source,
        ]);
        const { library, disks } = makeLibrary(new VideoTransformer());
        const record = await attachFixture(library, await readFile(source), 'silent.mp4');
        const updated = await library.transform(record.id, 'video');
        const files = updated.conversions.video!.files!;
        expect(files.some((f) => f.startsWith('audio/'))).toBe(false);
        const exported = await exportPackage(disks, updated);
        try {
          const master = await readFile(join(exported, 'index.m3u8'), 'utf8');
          expect(master).not.toContain('EXT-X-MEDIA');
          expect(master).not.toContain('AUDIO=');
          expect(decode(join(exported, 'manifest.mpd'))).toEqual(['video']);
          expect(decode(join(exported, 'index.m3u8'))).toEqual(['video']);
        } finally {
          await rm(exported, { recursive: true, force: true });
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    60_000,
  );

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
