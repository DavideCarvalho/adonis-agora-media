import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FilePathSource, HLS_FORMATS, Input } from 'mediabunny';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines } from '../src/define_config.js';
import { TransformerRuntimeMissingError } from '../src/errors.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import { VideoTransformer } from '../src/transformers/video.js';

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

describe('engines.mediabunny() at config time', () => {
  it('validates the ladder like engines.ffmpeg()', () => {
    expect(() => engines.mediabunny({ ladder: [{ height: 361, videoBitrate: '800k' }] })).toThrow(
      /even integer/,
    );
    expect(() => engines.mediabunny({ ladder: [{ height: 360, videoBitrate: 'fast' }] })).toThrow(
      /Invalid bitrate/,
    );
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

/** `@mediabunny/server` loads only where its native binary does (glibc). */
function hasServer(): boolean {
  try {
    createRequire(import.meta.url).resolve('@mediabunny/server');
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasBinary('ffmpeg') || !hasServer())(
  'engines.mediabunny({ ladder }) with @mediabunny/server',
  () => {
    let dir: string;
    let source: Buffer;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'agora-mb-ladder-'));
      const path = join(dir, 'src.mp4');
      execFileSync('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=640x360:rate=25:duration=4',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=4',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-shortest',
        path,
      ]);
      source = await readFile(path);
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    async function packageWith(engine: ReturnType<typeof engines.mediabunny>) {
      const { library, disks } = makeLibrary(new VideoTransformer({ engine, targetDuration: 2 }));
      const record = await library.attach({
        ownerType: 'Course',
        ownerId: '1',
        collection: 'videos',
        fileName: 'lesson.mp4',
        mimeType: 'video/mp4',
        contents: source,
      });
      return { disks, record: await library.transform(record.id, 'video') };
    }

    // First, while the server is still unregistered in this process (registration is cached).
    it('a missing @mediabunny/server is a typed runtime error, with the way out', async () => {
      const missing = Object.assign(new Error("Cannot find package '@mediabunny/server'"), {
        code: 'ERR_MODULE_NOT_FOUND',
      });
      const engine = engines.mediabunny({
        ladder: [{ height: 180, videoBitrate: '300k' }],
        server: () => Promise.reject(missing),
      });

      await expect(packageWith(engine)).rejects.toBeInstanceOf(TransformerRuntimeMissingError);
    });

    it('encodes every rung that fits from one video decode, listed in both manifests', async () => {
      const { disks, record } = await packageWith(
        engines.mediabunny({
          ladder: [
            { height: 180, videoBitrate: '300k' },
            { height: 360, videoBitrate: '800k' },
            { height: 720, videoBitrate: '2800k' }, // taller than the source: dropped
          ],
          audioBitrate: '96k',
          hardwareAcceleration: 'prefer-software',
        }),
      );
      const conversion = record.conversions.video!;
      const read = async (file: string) =>
        Buffer.from(await disks.fs!.getBytes(`${conversion.prefix}${file}`)).toString();

      const master = await read('index.m3u8');
      expect([...master.matchAll(/RESOLUTION=(\d+x\d+)/g)].map((m) => m[1])).toEqual([
        '320x180',
        '640x360',
      ]);
      expect(master).toMatch(/#EXT-X-MEDIA:TYPE=AUDIO/);

      const mpd = await read('manifest.mpd');
      expect(mpd.match(/<Representation /g)).toHaveLength(3);
      expect(mpd).toContain('height="180"');
      expect(mpd).toContain('contentType="audio"');
      expect(conversion.meta).toMatchObject({ videoCodec: 'avc', audioCodec: 'aac', height: 360 });

      // A real HLS reader plays the package from 0 s, for the length of the source.
      const exported = await mkdtemp(join(tmpdir(), 'agora-mb-read-'));
      try {
        for (const file of conversion.files!) {
          await mkdir(dirname(join(exported, file)), { recursive: true });
          await writeFile(
            join(exported, file),
            await disks.fs!.getBytes(`${conversion.prefix}${file}`),
          );
        }
        const input = new Input({
          source: new FilePathSource(join(exported, 'index.m3u8')),
          formats: HLS_FORMATS,
        });
        try {
          expect(await input.computeDuration()).toBeGreaterThan(3.5);
          expect(await input.computeDuration()).toBeLessThan(4.5);
        } finally {
          input.dispose();
        }
      } finally {
        await rm(exported, { recursive: true, force: true });
      }
    }, 120_000);

    it('refuses TS segments with a pointer to the ffmpeg engine', async () => {
      const { library } = makeLibrary(
        new VideoTransformer({
          engine: engines.mediabunny({ ladder: [{ height: 180, videoBitrate: '300k' }] }),
          formats: ['hls'],
          segments: 'ts',
        }),
      );
      const record = await library.attach({
        ownerType: 'Course',
        ownerId: '1',
        collection: 'videos',
        fileName: 'lesson.mp4',
        mimeType: 'video/mp4',
        contents: source,
      });

      await expect(library.transform(record.id, 'video')).rejects.toThrow(/CMAF/);
    });
  },
);
