import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../src/define_config.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { streamArtifactContentType } from '../src/streaming.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import {
  buildStoryboardArgs,
  buildStoryboardVtt,
  storyboardTileHeight,
} from '../src/transformers/ffmpeg.js';
import {
  VIDEO_STORYBOARD,
  VIDEO_STORYBOARD_DEFAULTS,
  type VideoPackageRequest,
  type VideoPackagingEngine,
  type VideoStoryboardRequest,
  VideoTransformer,
} from '../src/transformers/video.js';

const storyboard: VideoStoryboardRequest = { ...VIDEO_STORYBOARD_DEFAULTS, vtt: VIDEO_STORYBOARD };

function makeLibrary(transformer: VideoTransformer<string>) {
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

function attach(library: MediaLibrary, contents: Buffer) {
  return library.attach({
    ownerType: 'Course',
    ownerId: '1',
    collection: 'videos',
    fileName: 'lesson.mp4',
    mimeType: 'video/mp4',
    contents,
  });
}

/** Writes the HLS master and, when asked and `writeStoryboard`, a storyboard. */
function fakeEngine(requests: VideoPackageRequest[], writeStoryboard = true): VideoPackagingEngine {
  return {
    async package(request) {
      requests.push(request);
      if (request.hlsEntry) await writeFile(join(request.outputDir, request.hlsEntry), '#EXTM3U');
      if (request.dashManifest) {
        await writeFile(join(request.outputDir, request.dashManifest), '<MPD/>');
      }
      if (request.storyboard && writeStoryboard) {
        await writeFile(join(request.outputDir, 'storyboard-001.jpg'), 'jpeg');
        await writeFile(join(request.outputDir, request.storyboard.vtt), 'WEBVTT\n');
      }
      return { durationSeconds: 12, width: 1280, height: 720 };
    },
  };
}

describe('storyboard WebVTT', () => {
  it('maps each interval to its tile, row by row, sheet by sheet', () => {
    const vtt = buildStoryboardVtt({
      storyboard: { interval: 5, width: 160, columns: 2, rows: 2, vtt: VIDEO_STORYBOARD },
      height: 90,
      sheets: 2,
      durationSeconds: 23,
    });

    expect(vtt).toBe(
      [
        'WEBVTT',
        '00:00:00.000 --> 00:00:05.000\nstoryboard-001.jpg#xywh=0,0,160,90',
        '00:00:05.000 --> 00:00:10.000\nstoryboard-001.jpg#xywh=160,0,160,90',
        '00:00:10.000 --> 00:00:15.000\nstoryboard-001.jpg#xywh=0,90,160,90',
        '00:00:15.000 --> 00:00:20.000\nstoryboard-001.jpg#xywh=160,90,160,90',
        '00:00:20.000 --> 00:00:23.000\nstoryboard-002.jpg#xywh=0,0,160,90',
      ].join('\n\n') + '\n',
    );
  });

  it('never points past the tiles the written sheets hold', () => {
    const vtt = buildStoryboardVtt({
      storyboard: { interval: 5, width: 160, columns: 2, rows: 2, vtt: VIDEO_STORYBOARD },
      height: 90,
      sheets: 1,
      durationSeconds: 3600,
    });

    expect(vtt.match(/#xywh=/g)).toHaveLength(4);
    expect(vtt).not.toContain('storyboard-002.jpg');
  });

  it('keeps the source aspect ratio in the tile height, rounded to even', () => {
    expect(storyboardTileHeight(160, { width: 1920, height: 1080 })).toBe(90);
    expect(storyboardTileHeight(160, { width: 1080, height: 1920 })).toBe(284);
    expect(storyboardTileHeight(160, {})).toBe(90);
  });

  it('asks ffmpeg for one frame per interval, scaled and tiled into JPEG sheets', () => {
    const args = buildStoryboardArgs({
      sourcePath: '/in/src.mp4',
      outputDir: '/out',
      storyboard,
      height: 90,
    });

    expect(args).toContain('fps=1/5,scale=160:90,tile=10x10');
    expect(args.at(-1)).toBe('/out/storyboard-%03d.jpg');
  });

  it('serves the sprite sheets as JPEG', () => {
    expect(streamArtifactContentType('storyboard-001.jpg')).toBe('image/jpeg');
  });
});

describe('transformers.video({ storyboard })', () => {
  it('passes the resolved options to the engine and records the WebVTT in the meta', async () => {
    const requests: VideoPackageRequest[] = [];
    const { library } = makeLibrary(
      new VideoTransformer({ engine: fakeEngine(requests), storyboard: { interval: 10 } }),
    );
    const record = await attach(library, Buffer.from('mp4'));

    const updated = await library.transform(record.id, 'video');

    expect(requests[0]?.storyboard).toEqual({ ...storyboard, interval: 10 });
    expect(updated.conversions.video?.meta?.storyboard).toBe(VIDEO_STORYBOARD);
    expect(updated.conversions.video?.files).toEqual(
      expect.arrayContaining(['storyboard-001.jpg', VIDEO_STORYBOARD]),
    );
  });

  it('is off by default: no storyboard asked, none recorded', async () => {
    const requests: VideoPackageRequest[] = [];
    const { library } = makeLibrary(new VideoTransformer({ engine: fakeEngine(requests) }));
    const record = await attach(library, Buffer.from('mp4'));

    const updated = await library.transform(record.id, 'video');

    expect(requests[0]?.storyboard).toBeUndefined();
    expect(updated.conversions.video?.meta?.storyboard).toBeUndefined();
  });

  it('fails the transform when the engine did not write the WebVTT', async () => {
    const { library } = makeLibrary(
      new VideoTransformer({ engine: fakeEngine([], false), storyboard: true }),
    );
    const record = await attach(library, Buffer.from('mp4'));

    await expect(library.transform(record.id, 'video')).rejects.toThrow(/storyboard\.vtt/);
  });

  it('refuses at config time without an engine that decodes frames', () => {
    expect(() => new VideoTransformer({ storyboard: true })).toThrow(/engines\.ffmpeg/);
  });

  it('refuses a non-positive interval at config time', () => {
    expect(
      () => new VideoTransformer({ engine: fakeEngine([]), storyboard: { interval: 0 } }),
    ).toThrow(/storyboard\.interval/);
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

describe.skipIf(!hasBinary('ffmpeg') || !hasBinary('ffprobe'))(
  'engines.ffmpeg storyboard against the real binaries',
  () => {
    let dir: string;
    let source: Buffer;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'agora-storyboard-'));
      const path = join(dir, 'src.mp4');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=640x360:rate=25:duration=12',
        '-c:v',
        'libx264',
        path,
      ]);
      source = await readFile(path);
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('writes the sheets and a WebVTT whose tiles match their real size', async () => {
      const { library, disks } = makeLibrary(
        new VideoTransformer({
          engine: engines.ffmpeg(),
          targetDuration: 2,
          storyboard: { interval: 2, width: 160, columns: 3, rows: 2 },
        }),
      );
      const record = await attach(library, source);

      const updated = await library.transform(record.id, 'video');
      const conversion = updated.conversions.video!;

      // 12 s every 2 s = 6 thumbnails = exactly one 3×2 sheet.
      expect(conversion.files).toEqual(expect.arrayContaining(['storyboard-001.jpg']));
      expect(conversion.files).not.toContain('storyboard-002.jpg');
      const vtt = Buffer.from(
        await disks.fs!.getBytes(`${conversion.prefix}${VIDEO_STORYBOARD}`),
      ).toString();
      expect(vtt.match(/#xywh=/g)).toHaveLength(6);
      expect(vtt).toContain('storyboard-001.jpg#xywh=320,90,160,90');

      const sheetPath = join(dir, 'sheet.jpg');
      await writeFile(
        sheetPath,
        await disks.fs!.getBytes(`${conversion.prefix}storyboard-001.jpg`),
      );
      const size = execFileSync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0',
        sheetPath,
      ])
        .toString()
        .trim();
      expect(size).toBe('480,180');
    }, 60_000);
  },
);
