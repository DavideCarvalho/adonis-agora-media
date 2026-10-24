import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authorizers, type MediaIdentityResolver, type MediaSubject } from '../src/access.js';
import { engines, transformers } from '../src/define_config.js';
import type { DeliveryMode } from '../src/delivery.js';
import type { DeliverySigningConfig } from '../src/delivery_signing.js';
import { TransformNotReadyError } from '../src/errors.js';
import { MediaAccess } from '../src/media_access.js';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import {
  rewriteDashManifest,
  signManifest,
  streamArtifactContentType,
  streamEntries,
  withQuery,
} from '../src/streaming.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import type { Transformer } from '../src/transformer.js';
import {
  DASH_HLS_ENTRY,
  type DashPackageEngine,
  type DashPackageRequest,
} from '../src/transformers/dash.js';
import { buildDashArgs } from '../src/transformers/ffmpeg.js';

const MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD type="static">
  <Period>
    <AdaptationSet contentType="video">
      <Representation id="0">
        <SegmentTemplate timescale="12800" initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1"/>
      </Representation>
      <Representation id="1">
        <BaseURL>https://cdn.example/abs/</BaseURL>
        <SegmentList><SegmentURL media="https://cdn.example/a.m4s"/></SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
`;

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="media_2.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1
media_0.m3u8
`;

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-MAP:URI="init-0.m4s"
#EXTINF:4,
chunk-0-00001.m4s
#EXT-X-ENDLIST
`;

describe('manifest rewriting', () => {
  it('adds a query to relative DASH templates, XML-escaped, leaving absolute URLs alone', async () => {
    const out = await rewriteDashManifest(MPD, (uri) => withQuery(uri, 'exp=1&sig=x'));
    expect(out).toContain('initialization="init-$RepresentationID$.m4s?exp=1&amp;sig=x"');
    expect(out).toContain('media="chunk-$RepresentationID$-$Number%05d$.m4s?exp=1&amp;sig=x"');
    expect(out).toContain('<BaseURL>https://cdn.example/abs/</BaseURL>');
    expect(out).toContain('media="https://cdn.example/a.m4s"');
  });

  it('rewrites a relative <BaseURL> and unescapes before handing the URI over', async () => {
    const seen: string[] = [];
    const out = await rewriteDashManifest(
      '<MPD><BaseURL>seg/?a=1&amp;b=2</BaseURL><SegmentTemplate media="x.m4s"/></MPD>',
      (uri) => {
        seen.push(uri);
        return withQuery(uri, 'sig=s');
      },
    );
    expect(seen).toEqual(['x.m4s', 'seg/?a=1&b=2']);
    expect(out).toBe(
      '<MPD><BaseURL>seg/?a=1&amp;b=2&amp;sig=s</BaseURL><SegmentTemplate media="x.m4s?sig=s"/></MPD>',
    );
  });

  it('signs every reference of an HLS playlist, tag attributes included', async () => {
    const master = await signManifest('index.m3u8', MASTER, 'exp=1&sig=x');
    expect(master).toContain('URI="media_2.m3u8?exp=1&sig=x"');
    expect(master).toContain('\nmedia_0.m3u8?exp=1&sig=x\n');
    const media = await signManifest('media_0.m3u8', MEDIA_PLAYLIST, 'exp=1&sig=x');
    expect(media).toContain('#EXT-X-MAP:URI="init-0.m4s?exp=1&sig=x"');
    expect(media).toContain('\nchunk-0-00001.m4s?exp=1&sig=x\n');
  });

  it('leaves a manifest untouched without a query', async () => {
    expect(await signManifest('manifest.mpd', MPD, '')).toBe(MPD);
  });

  it('withQuery keeps an existing query and a fragment', () => {
    expect(withQuery('a.m4s?x=1#t', 'sig=s')).toBe('a.m4s?x=1&sig=s#t');
    expect(withQuery('a.m4s', '')).toBe('a.m4s');
  });

  it('knows the content type of every streaming artifact', () => {
    expect(streamArtifactContentType('manifest.mpd')).toBe('application/dash+xml');
    expect(streamArtifactContentType('index.m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(streamArtifactContentType('chunk-0-00001.m4s')).toBe('video/mp4');
    expect(streamArtifactContentType('segment-0-1.ts')).toBe('video/mp2t');
    expect(streamArtifactContentType('notes.txt')).toBeUndefined();
  });
});

/** A fake engine writing a CMAF package shaped like ffmpeg's. */
function fakeDashEngine(requests: DashPackageRequest[] = []): DashPackageEngine {
  return {
    async package(request) {
      requests.push(request);
      await writeFile(join(request.outputDir, request.manifestName), MPD);
      if (request.hlsEntryName) {
        await writeFile(join(request.outputDir, request.hlsEntryName), MASTER);
        await writeFile(join(request.outputDir, 'media_0.m3u8'), MEDIA_PLAYLIST);
        await writeFile(join(request.outputDir, 'media_2.m3u8'), MEDIA_PLAYLIST);
      }
      await writeFile(join(request.outputDir, 'init-0.m4s'), 'init');
      await writeFile(join(request.outputDir, 'chunk-0-00001.m4s'), 'segment-bytes');
      return { durationSeconds: 7200, width: 1280, height: 720, videoCodec: 'h264' };
    },
  };
}

interface TestCtx {
  user: MediaSubject | null;
}
const identity: MediaIdentityResolver = (ctx) => (ctx as TestCtx).user ?? null;

function setup(
  options: {
    transformer?: Transformer;
    signing?: DeliverySigningConfig;
    mode?: DeliveryMode;
    clock?: () => Date;
  } = {},
) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const library = new MediaLibrary({
    storage: new StorageManager({ default: 'fs', resolve }),
    store: new InMemoryMediaStore(),
    collections: [
      {
        name: 'lessons',
        transformers: [options.transformer ?? transformers.dash({ engine: fakeDashEngine() })],
        access: { read: authorizers.owner() },
      },
    ],
    idGenerator: () => 'vid-1',
    emitDiagnostics: false,
    deliveryMode: options.mode ?? 'proxy',
    ...(options.signing ? { deliverySigning: options.signing } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const access = new MediaAccess({ library, identity });
  return { library, access, disks };
}

async function attachVideo(library: MediaLibrary) {
  return library.attach({
    ownerType: 'User',
    ownerId: '7',
    collection: 'lessons',
    fileName: 'aula.mp4',
    mimeType: 'video/mp4',
    contents: Buffer.from('mp4-bytes'),
  });
}

/** Records what the stream route did with the response. */
function fakeHttp(init: {
  user?: MediaSubject | null;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
}) {
  const sent: {
    status?: number;
    json?: { code: string } | undefined;
    headers: Record<string, string>;
    redirect?: string;
    stream?: Readable;
    body?: string;
  } = { headers: {} };
  const ctx = {
    user: init.user ?? null,
    params: init.params ?? {},
    request: { qs: () => init.query ?? {}, header: () => undefined },
    response: {
      status(code: number) {
        sent.status = code;
        return {
          json(body: unknown) {
            sent.json = body as { code: string };
            return body;
          },
        };
      },
      header(name: string, value: string) {
        sent.headers[name.toLowerCase()] = value;
      },
      redirect(url: string) {
        sent.redirect = url;
      },
      stream(stream: Readable) {
        sent.stream = stream;
      },
      send(body: unknown) {
        sent.body = String(body);
      },
    },
  };
  return { ctx, sent };
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
}

const owner: MediaSubject = { id: '7' };
const SECRET = 'test-secret';

describe('transformers.dash()', () => {
  it('uploads the CMAF package and records the HLS master it carries', async () => {
    const requests: DashPackageRequest[] = [];
    const { library, disks } = setup({
      transformer: transformers.dash({ engine: fakeDashEngine(requests), targetDuration: 6 }),
    });
    const record = await attachVideo(library);
    const updated = await library.transform(record.id, 'dash');

    expect(requests[0]).toMatchObject({
      manifestName: 'manifest.mpd',
      hlsEntryName: DASH_HLS_ENTRY,
      targetDuration: 6,
    });
    const conversion = updated.conversions.dash!;
    const prefix = 'User/7/lessons/vid-1/conversions/dash/';
    expect(conversion.path).toBe(`${prefix}manifest.mpd`);
    expect(conversion.files).toEqual([
      'chunk-0-00001.m4s',
      'index.m3u8',
      'init-0.m4s',
      'manifest.mpd',
      'media_0.m3u8',
      'media_2.m3u8',
    ]);
    expect(conversion.meta).toEqual({
      durationSeconds: 7200,
      width: 1280,
      height: 720,
      videoCodec: 'h264',
      segmentCount: 2,
      targetDuration: 6,
      hlsEntry: 'index.m3u8',
    });
    const disk = disks.fs!;
    expect((await disk.getMetaData(`${prefix}manifest.mpd`)).contentType).toBe(
      'application/dash+xml',
    );
    expect((await disk.getMetaData(`${prefix}chunk-0-00001.m4s`)).contentType).toBe('video/mp4');
  });

  it('with hls: false, writes a DASH-only package', async () => {
    const requests: DashPackageRequest[] = [];
    const { library } = setup({
      transformer: transformers.dash({ engine: fakeDashEngine(requests), hls: false }),
    });
    const record = await attachVideo(library);
    const updated = await library.transform(record.id, 'dash');
    expect(requests[0]?.hlsEntryName).toBeUndefined();
    expect(updated.conversions.dash?.meta?.hlsEntry).toBeUndefined();
    expect(streamEntries(updated).map((e) => e.format)).toEqual(['dash']);
  });
});

describe('buildDashArgs', () => {
  const base = {
    sourcePath: '/in/src.mp4',
    outputDir: '/out',
    manifestName: 'manifest.mpd',
    targetDuration: 4,
    audioBitrate: '128k',
    preset: 'veryfast',
    extraArgs: [],
  };

  it('remuxes into a CMAF package with an HLS master over the same segments', () => {
    const args = buildDashArgs({
      ...base,
      hlsEntryName: 'index.m3u8',
      hasAudio: true,
      renditions: [],
    });
    expect(args).toEqual(
      expect.arrayContaining(['-c', 'copy', '-f', 'dash', '-hls_master_name', 'index.m3u8']),
    );
    expect(args.join(' ')).toContain('-map 0:v:0 -map 0:a:0 -c copy');
    expect(args.join(' ')).toContain('-adaptation_sets id=0,streams=v id=1,streams=a');
    expect(args.at(-1)).toBe('/out/manifest.mpd');
  });

  it('encodes a ladder with one shared audio track, and no HLS when not asked', () => {
    const args = buildDashArgs({
      ...base,
      hasAudio: false,
      renditions: [
        { height: 360, videoBitrate: '800k' },
        { height: 720, videoBitrate: '2800k' },
      ],
    });
    const line = args.join(' ');
    expect(line).toContain('[0:v:0]split=2[v0][v1];[v0]scale=-2:360[v0o];[v1]scale=-2:720[v1o]');
    expect(line).toContain('-c:v:1 libx264 -b:v:1 2800k -maxrate:v:1 4200000');
    expect(line).not.toContain('0:a:0');
    expect(line).toContain('-adaptation_sets id=0,streams=v');
    expect(line).not.toContain('hls_playlist');
  });

  it('rejects an odd rendition height up front', () => {
    expect(() => engines.ffmpegDash({ ladder: [{ height: 361, videoBitrate: '1M' }] })).toThrow(
      /even integer/,
    );
  });
});

describe('media.library.stream()', () => {
  it('lists HLS first, then DASH, as stream-route URLs', async () => {
    const { library } = setup();
    const record = await attachVideo(library);
    await library.transform(record.id, 'dash');

    expect(await library.stream(record.id)).toEqual({
      src: '/media/vid-1/stream/dash/index.m3u8',
      format: 'hls',
      sources: [
        {
          src: '/media/vid-1/stream/dash/index.m3u8',
          format: 'hls',
          type: 'application/vnd.apple.mpegurl',
          conversion: 'dash',
        },
        {
          src: '/media/vid-1/stream/dash/manifest.mpd',
          format: 'dash',
          type: 'application/dash+xml',
          conversion: 'dash',
        },
      ],
      width: 1280,
      height: 720,
      durationSeconds: 7200,
    });
  });

  it('signs the URLs for the whole package, valid at least for the video plus an hour', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const { library } = setup({
      signing: { secret: SECRET, expiresIn: 600 },
      clock: () => now,
    });
    const record = await attachVideo(library);
    await library.transform(record.id, 'dash');

    const { src } = await library.stream(record.id);
    const url = new URL(src, 'http://app');
    expect(url.pathname).toBe('/media/vid-1/stream/dash/index.m3u8');
    // 7200s of video + 3600s: well beyond the 600s signing default.
    expect(Number(url.searchParams.get('exp')) - now.getTime() / 1000).toBeGreaterThanOrEqual(
      10_800,
    );
    expect(url.searchParams.get('sig')).toMatch(/^[\w-]+$/);
  });

  it('throws TransformNotReadyError before the package exists', async () => {
    const { library } = setup();
    const record = await attachVideo(library);
    await expect(library.stream(record.id)).rejects.toBeInstanceOf(TransformNotReadyError);
  });
});

describe('media.access.stream()', () => {
  it('refuses who may not read, and hands the sources to who may', async () => {
    const { library, access } = setup();
    const record = await attachVideo(library);
    await library.transform(record.id, 'dash');

    await expect(access.stream({ user: { id: '8' } }, record.id)).rejects.toMatchObject({
      code: 'E_MEDIA_ACCESS_DENIED',
      status: 403,
    });
    expect((await access.stream({ user: owner }, record.id)).format).toBe('hls');
  });
});

describe('media.access.streamRoute()', () => {
  async function ready(options: Parameters<typeof setup>[0] = {}) {
    const env = setup(options);
    const record = await attachVideo(env.library);
    await env.library.transform(record.id, 'dash');
    return { ...env, record, serve: env.access.streamRoute() };
  }

  it('serves a manifest as stored when signing is off (references resolve to the route)', async () => {
    const { serve } = await ready();
    const { ctx, sent } = fakeHttp({
      user: owner,
      params: { id: 'vid-1', conversion: 'dash', '*': ['manifest.mpd'] },
    });
    await serve(ctx);
    expect(sent.headers['content-type']).toBe('application/dash+xml');
    expect(sent.headers['cache-control']).toBe('private, max-age=60');
    expect(sent.body).toBe(MPD);
  });

  it('refuses an anonymous request (401) and a stranger (403)', async () => {
    const { serve } = await ready();
    const anonymous = fakeHttp({ params: { id: 'vid-1', conversion: 'dash', file: 'index.m3u8' } });
    await serve(anonymous.ctx);
    expect(anonymous.sent.status).toBe(401);
    const stranger = fakeHttp({
      user: { id: '8' },
      params: { id: 'vid-1', conversion: 'dash', file: 'index.m3u8' },
    });
    await serve(stranger.ctx);
    expect(stranger.sent.status).toBe(403);
  });

  it('streams a segment in proxy mode with its content type and a long private cache', async () => {
    const { serve } = await ready();
    const { ctx, sent } = fakeHttp({
      user: owner,
      params: { id: 'vid-1', conversion: 'dash', file: 'chunk-0-00001.m4s' },
    });
    await serve(ctx);
    expect(sent.headers['content-type']).toBe('video/mp4');
    expect(sent.headers['cache-control']).toBe('private, max-age=86400');
    expect(await readAll(sent.stream!)).toBe('segment-bytes');
  });

  it('redirects a segment to a short-lived signed URL in signed mode', async () => {
    const { serve } = await ready({ mode: 'signed' });
    const { ctx, sent } = fakeHttp({
      user: owner,
      params: { id: 'vid-1', conversion: 'dash', file: 'init-0.m4s' },
    });
    await serve(ctx);
    expect(sent.redirect).toContain('init-0.m4s');
  });

  it('answers 404 for a file outside the package, traversal included', async () => {
    const { serve } = await ready();
    for (const file of ['nope.m4s', '../../aula.mp4', '']) {
      const { ctx, sent } = fakeHttp({
        user: owner,
        params: { id: 'vid-1', conversion: 'dash', file },
      });
      await serve(ctx);
      expect(sent.status).toBe(404);
    }
    const missing = fakeHttp({
      user: owner,
      params: { id: 'vid-1', conversion: 'hls', file: 'index.m3u8' },
    });
    await serve(missing.ctx);
    expect(missing.sent.json?.code).toBe('E_MEDIA_TRANSFORM_NOT_READY');
  });

  describe('with delivery.signing', () => {
    const signing = { secret: SECRET, expiresIn: 3600 };

    it('a session-authorized manifest hands its references a package signature', async () => {
      const { serve } = await ready({ signing });
      const { ctx, sent } = fakeHttp({
        user: owner,
        params: { id: 'vid-1', conversion: 'dash', file: 'index.m3u8' },
      });
      await serve(ctx);
      const ref = /\nmedia_0\.m3u8\?(exp=\d+&sig=[\w-]+)\n/.exec(sent.body ?? '');
      expect(ref).not.toBeNull();

      // That signature alone opens the media playlist — and the segments it leads to.
      const query = Object.fromEntries(new URLSearchParams(ref![1]));
      const anonymous = fakeHttp({
        params: { id: 'vid-1', conversion: 'dash', file: 'media_0.m3u8' },
        query,
      });
      await serve(anonymous.ctx);
      expect(anonymous.sent.status).toBeUndefined();
      expect(anonymous.sent.body).toContain(`chunk-0-00001.m4s?${ref![1]}`);

      const segment = fakeHttp({
        params: { id: 'vid-1', conversion: 'dash', file: 'chunk-0-00001.m4s' },
        query,
      });
      await serve(segment.ctx);
      expect(await readAll(segment.sent.stream!)).toBe('segment-bytes');
    });

    it('the signed URLs from stream() play without a session', async () => {
      const { serve, library } = await ready({ signing });
      const { sources } = await library.stream('vid-1');
      const dash = new URL(sources.find((s) => s.format === 'dash')!.src, 'http://app');
      const { ctx, sent } = fakeHttp({
        params: { id: 'vid-1', conversion: 'dash', file: 'manifest.mpd' },
        query: Object.fromEntries(dash.searchParams),
      });
      await serve(ctx);
      expect(sent.body).toContain(
        `media="chunk-$RepresentationID$-$Number%05d$.m4s?${dash.searchParams.toString().replace('&', '&amp;')}"`,
      );
    });

    it('refuses a tampered signature and one made for another conversion', async () => {
      const { serve, library } = await ready({ signing });
      const record = (await library.find('vid-1'))!;
      const valid = Object.fromEntries(new URLSearchParams(library.streamQuery(record, 'dash')));

      const tampered = fakeHttp({
        params: { id: 'vid-1', conversion: 'dash', file: 'manifest.mpd' },
        query: { ...valid, sig: `${valid.sig}x` },
      });
      await serve(tampered.ctx);
      expect(tampered.sent.status).toBe(403);

      const other = fakeHttp({
        params: { id: 'vid-1', conversion: 'dash', file: 'manifest.mpd' },
        query: Object.fromEntries(new URLSearchParams(library.streamQuery(record, 'hls'))),
      });
      await serve(other.ctx);
      expect(other.sent.status).toBe(403);
    });
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
  'engines.ffmpegDash against the real binaries',
  () => {
    let dir: string;
    let source: Buffer;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'agora-dash-'));
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

    async function packageWith(transformer: Transformer) {
      const { library, access } = setup({ transformer });
      const record = await library.attach({
        ownerType: 'User',
        ownerId: '7',
        collection: 'lessons',
        fileName: 'aula.mp4',
        mimeType: 'video/mp4',
        contents: source,
      });
      return { library, access, record: await library.transform(record.id, 'dash') };
    }

    it('transcodes a ladder into a CMAF package both formats play', async () => {
      const { access, record } = await packageWith(
        transformers.dash({
          engine: engines.ffmpegDash({ ladder: engines.ladders.compact }),
          targetDuration: 2,
        }),
      );
      const files = record.conversions.dash!.files!;
      expect(files).toEqual(
        expect.arrayContaining(['manifest.mpd', 'index.m3u8', 'init-0.m4s', 'init-1.m4s']),
      );
      expect(files.some((f) => /^chunk-0-\d{5}\.m4s$/.test(f))).toBe(true);
      expect(record.conversions.dash!.meta).toMatchObject({
        videoCodec: 'h264',
        audioCodec: 'aac',
        height: 360,
        hlsEntry: 'index.m3u8',
      });

      // Every reference in the HLS master names a file of the package.
      const serve = access.streamRoute();
      const { ctx, sent } = fakeHttp({
        user: owner,
        params: { id: record.id, conversion: 'dash', file: 'index.m3u8' },
      });
      await serve(ctx);
      const refs = (sent.body ?? '')
        .split('\n')
        .flatMap((line) =>
          line.startsWith('#')
            ? [...line.matchAll(/URI="([^"]+)"/g)].map((m) => m[1]!)
            : line.trim()
              ? [line.trim()]
              : [],
        );
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(files).toContain(ref);
    }, 60_000);

    it('remuxes without re-encoding by default', async () => {
      const { record } = await packageWith(transformers.dash({ targetDuration: 2 }));
      expect(record.conversions.dash!.files).toEqual(
        expect.arrayContaining(['manifest.mpd', 'index.m3u8']),
      );
      expect(record.conversions.dash!.meta).toMatchObject({ width: 640, height: 360 });
    }, 60_000);
  },
);
