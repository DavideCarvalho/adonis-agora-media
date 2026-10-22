import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { engines, transformers } from '../src/define_config.js';
import {
  FfmpegFailedError,
  HlsSourceUnsupportedError,
  TransformerRuntimeMissingError,
} from '../src/errors.js';
import { HlsDeliveryHandler } from '../src/hls/delivery.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import type { Transformer } from '../src/transformer.js';
import { buildHlsArgs, effectiveLadder } from '../src/transformers/ffmpeg.js';

function hasBinary(name: string): boolean {
  try {
    execFileSync(name, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const hasFfmpeg = hasBinary('ffmpeg') && hasBinary('ffprobe');

function makeLibrary(transformer: Transformer) {
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

const prefix = 'Course/1/videos/vid-1/conversions/hls/';

describe('effectiveLadder', () => {
  const ladder = engines.ladders.standard;

  it('drops rungs taller than the source, sorted ascending', () => {
    expect(effectiveLadder(ladder, 720).map((r) => r.height)).toEqual([360, 720]);
    expect(effectiveLadder([...ladder].reverse(), 1080).map((r) => r.height)).toEqual([
      360, 720, 1080,
    ]);
  });

  it('keeps the smallest rung at the (even) source height when every rung is taller', () => {
    expect(effectiveLadder(ladder, 241)).toEqual([{ ...ladder[0], height: 240 }]);
  });

  it('keeps the whole ladder when the source height is unknown', () => {
    expect(effectiveLadder(ladder, undefined)).toHaveLength(3);
  });
});

describe('buildHlsArgs', () => {
  const base = {
    sourcePath: '/in.mp4',
    outputDir: '/out',
    entryName: 'index.m3u8',
    targetDuration: 4,
    preset: 'veryfast',
    extraArgs: [],
  };

  it('remuxes with stream copy when there is no ladder', () => {
    const args = buildHlsArgs({ ...base, hasAudio: true, renditions: [] });
    expect(args).toContain('copy');
    expect(args).not.toContain('libx264');
    expect(args[args.indexOf('-var_stream_map') + 1]).toBe('v:0,a:0');
    expect(args[args.indexOf('-master_pl_name') + 1]).toBe('index.m3u8');
    expect(args.at(-1)).toBe('/out/playlist-%v.m3u8');
  });

  it('encodes one h264/aac rendition per rung, with keyframes on segment boundaries', () => {
    const args = buildHlsArgs({
      ...base,
      hasAudio: true,
      renditions: [
        { height: 360, videoBitrate: '800k' },
        { height: 720, videoBitrate: '2800k' },
      ],
    });
    expect(args[args.indexOf('-filter_complex') + 1]).toBe(
      '[0:v:0]split=2[v0][v1];[v0]scale=-2:360[v0o];[v1]scale=-2:720[v1o]',
    );
    expect(args[args.indexOf('-maxrate:v:1') + 1]).toBe('4200000');
    expect(args[args.indexOf('-var_stream_map') + 1]).toBe('v:0,a:0 v:1,a:1');
    expect(args[args.indexOf('-force_key_frames') + 1]).toBe('expr:gte(t,n_forced*4)');
  });

  it('passes preset and inserts extraArgs right before the HLS muxer options', () => {
    const args = buildHlsArgs({
      ...base,
      hasAudio: true,
      preset: 'slow',
      extraArgs: ['-threads', '2'],
      renditions: [{ height: 360, videoBitrate: '800k' }],
    });
    expect(args[args.indexOf('-preset') + 1]).toBe('slow');
    expect(args.slice(args.indexOf('-threads'), args.indexOf('-threads') + 4)).toEqual([
      '-threads',
      '2',
      '-f',
      'hls',
    ]);
  });

  it('applies extraArgs in remux mode too', () => {
    const args = buildHlsArgs({ ...base, hasAudio: false, renditions: [], extraArgs: ['-copyts'] });
    expect(args.indexOf('-copyts')).toBe(args.indexOf('-f') - 1);
    expect(args).not.toContain('-preset');
  });

  it('maps no audio for a silent source', () => {
    const args = buildHlsArgs({
      ...base,
      hasAudio: false,
      renditions: [{ height: 360, videoBitrate: '800k' }],
    });
    expect(args.join(' ')).not.toContain('0:a:0');
    expect(args[args.indexOf('-var_stream_map') + 1]).toBe('v:0');
  });
});

describe('ffmpeg engine configuration errors', () => {
  it('rejects an unparseable bitrate when the engine is built', () => {
    expect(() => engines.ffmpegHls({ ladder: [{ height: 360, videoBitrate: 'fast' }] })).toThrow(
      /Invalid bitrate/,
    );
  });

  it('rejects odd, non-positive or fractional rung heights and bad audio bitrates', () => {
    for (const height of [0, -360, 361, 360.5]) {
      expect(() => engines.ffmpegHls({ ladder: [{ height, videoBitrate: '800k' }] })).toThrow(
        /Invalid rendition height/,
      );
    }
    expect(() =>
      engines.ffmpegHls({ ladder: [{ height: 360, videoBitrate: '800k', audioBitrate: 'loud' }] }),
    ).toThrow(/Invalid bitrate/);
  });

  it('reports a missing binary as TransformerRuntimeMissingError', async () => {
    const { library } = makeLibrary(
      transformers.hls({ engine: engines.ffmpegHls({ ffprobePath: 'definitely-not-ffprobe' }) }),
    );
    const record = await attach(library, Buffer.from('x'));
    await expect(library.transform(record.id, 'hls')).rejects.toBeInstanceOf(
      TransformerRuntimeMissingError,
    );
  });
});

// Fake binaries: shell scripts standing in for ffprobe, to drive failure modes a real ffprobe
// won't produce on demand.
describe.skipIf(process.platform === 'win32')('ffmpeg engines with a misbehaving binary', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'media-fakebin-'));
  });

  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function fakeBinary(name: string, body: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  it('reports a binary killed by a signal with a null exitCode (retryable, not a rejection of the file)', async () => {
    const ffprobePath = await fakeBinary('killed-ffprobe', 'kill -9 $$');
    const { library } = makeLibrary(
      transformers.probe({ engine: engines.ffprobe({ ffprobePath }) }),
    );
    const record = await attach(library, Buffer.from('x'));
    const error = await library.transform(record.id, 'probe').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegFailedError);
    expect((error as FfmpegFailedError).exitCode).toBeNull();
  });

  it('reports a non-zero exit with its code and stderr', async () => {
    const ffprobePath = await fakeBinary(
      'failing-ffprobe',
      'echo "moov atom not found" >&2; exit 1',
    );
    const { library } = makeLibrary(
      transformers.probe({ engine: engines.ffprobe({ ffprobePath }) }),
    );
    const record = await attach(library, Buffer.from('x'));
    const error = (await library
      .transform(record.id, 'probe')
      .catch((e: unknown) => e)) as FfmpegFailedError;
    expect(error).toBeInstanceOf(FfmpegFailedError);
    expect(error.exitCode).toBe(1);
    expect(error.message).toContain('moov atom not found');
  });

  it('turns unparseable ffprobe output into FfmpegFailedError instead of a raw SyntaxError', async () => {
    const ffprobePath = await fakeBinary('chatty-ffprobe', 'echo "this is not json"');
    const { library } = makeLibrary(
      transformers.hls({ engine: engines.ffmpegHls({ ffprobePath, ffmpegPath: 'unused' }) }),
    );
    const record = await attach(library, Buffer.from('x'));
    const error = (await library
      .transform(record.id, 'hls')
      .catch((e: unknown) => e)) as FfmpegFailedError;
    expect(error).toBeInstanceOf(FfmpegFailedError);
    expect(error.stderr).toContain('unparseable ffprobe output');
  });
});

describe.skipIf(!hasFfmpeg)('ffmpeg engines against the real binaries', () => {
  let fixture: Buffer;
  let wide: Buffer;
  let tmp: string;

  beforeAll(async () => {
    fixture = await readFile(join(import.meta.dirname, 'fixtures', 'tiny_h264_aac.mp4'));
    // a 2 s 320x240 h264/aac source, generated so the ladder has room for two rungs
    tmp = await mkdtemp(join(tmpdir(), 'media-ffmpeg-'));
    const path = join(tmp, 'wide.mp4');
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=25:duration=2',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      path,
    ]);
    wide = await readFile(path);
  });

  afterAll(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
  });

  it('remuxes into a master + media playlist package the HLS delivery handler serves', async () => {
    const { library, disks } = makeLibrary(transformers.hls({ engine: engines.ffmpegHls() }));
    const record = await attach(library, fixture);

    const updated = await library.transform(record.id, 'hls');
    const conversion = updated.conversions.hls;
    expect(conversion?.path).toBe(`${prefix}index.m3u8`);
    expect(conversion?.files).toEqual(expect.arrayContaining(['index.m3u8', 'playlist-0.m3u8']));
    expect(conversion?.files?.some((f) => /^segment-0-\d+\.ts$/.test(f))).toBe(true);

    const master = Buffer.from(await disks.fs.getBytes(`${prefix}index.m3u8`)).toString('utf8');
    expect(master).toContain('#EXT-X-STREAM-INF');
    expect(master).toContain('playlist-0.m3u8');

    expect(conversion?.meta).toMatchObject({
      width: 64,
      height: 64,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });

    const handler = new HlsDeliveryHandler({
      library,
      urlForPlaylist: ({ mediaId, file }) => `/videos/${mediaId}/hls/${file}`,
    });
    const served = await handler.handle({ mediaId: record.id });
    if (served.kind !== 'playlist') throw new Error('expected playlist');
    expect(served.content).toContain(`/videos/${record.id}/hls/playlist-0.m3u8`);
  }, 60_000);

  it('encodes a multi-rendition ladder without upscaling', async () => {
    const ladder = [
      { height: 120, videoBitrate: '200k', audioBitrate: '64k' },
      { height: 240, videoBitrate: '400k' },
      { height: 480, videoBitrate: '900k' }, // taller than the 240p source: dropped
    ];
    const { library, disks } = makeLibrary(
      transformers.hls({ engine: engines.ffmpegHls({ ladder }) }),
    );
    const record = await attach(library, wide);

    const updated = await library.transform(record.id, 'hls');
    const files = updated.conversions.hls?.files ?? [];
    expect(files.filter((f) => f.startsWith('playlist-')).sort()).toEqual([
      'playlist-0.m3u8',
      'playlist-1.m3u8',
    ]);

    const master = Buffer.from(await disks.fs.getBytes(`${prefix}index.m3u8`)).toString('utf8');
    expect(master).toMatch(/RESOLUTION=160x120/);
    expect(master).toMatch(/RESOLUTION=320x240/);
    expect(master).not.toMatch(/x480/);
  }, 120_000);

  it('surfaces an ffmpeg failure as FfmpegFailedError with stderr', async () => {
    const { library } = makeLibrary(transformers.hls({ engine: engines.ffmpegHls() }));
    const record = await attach(library, Buffer.from('not a video at all'));
    const error = await library.transform(record.id, 'hls').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegFailedError);
    expect((error as FfmpegFailedError).stderr.length).toBeGreaterThan(0);
  }, 30_000);

  it('rejects an audio-only source as HlsSourceUnsupportedError (definitive, like mediabunny)', async () => {
    const audioPath = join(tmp, 'audio.m4a');
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=duration=1',
      '-c:a',
      'aac',
      audioPath,
    ]);
    const { library } = makeLibrary(transformers.hls({ engine: engines.ffmpegHls() }));
    const record = await attach(library, await readFile(audioPath));
    await expect(library.transform(record.id, 'hls')).rejects.toBeInstanceOf(
      HlsSourceUnsupportedError,
    );
  }, 30_000);

  it('reports display dimensions for a rotated (phone) video', async () => {
    // stored 320x240 with a 90° display matrix — how phones record portrait video
    const rotatedPath = join(tmp, 'rotated.mp4');
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-display_rotation:v:0',
      '90',
      '-i',
      join(tmp, 'wide.mp4'),
      '-c',
      'copy',
      rotatedPath,
    ]);
    const { library } = makeLibrary(transformers.probe({ engine: engines.ffprobe() }));
    const record = await attach(library, await readFile(rotatedPath));
    const updated = await library.transform(record.id, 'probe');
    expect(updated.conversions.probe?.meta).toMatchObject({ width: 240, height: 320 });
  }, 30_000);

  it('probes with ffprobe', async () => {
    const { library } = makeLibrary(transformers.probe({ engine: engines.ffprobe() }));
    const record = await attach(library, wide);
    const updated = await library.transform(record.id, 'probe');
    expect(updated.conversions.probe?.meta).toMatchObject({
      hasVideo: true,
      hasAudio: true,
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: 'aac',
      audioSampleRate: 44100,
      audioChannels: 1,
    });
    expect(Number(updated.conversions.probe?.meta?.durationSeconds)).toBeCloseTo(2, 0);
  }, 30_000);
});
