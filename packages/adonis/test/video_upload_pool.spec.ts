import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MediaLibrary } from '../src/media_library.js';
import { StorageManager } from '../src/storage_manager.js';
import { FakeTransformer } from '../src/testing/fake_transformer.js';
import { InMemoryDisk } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import { type VideoPackagingEngine, VideoTransformer } from '../src/transformers/video.js';
import type { DiskWriteOptions } from '../src/types.js';

const SEGMENTS = 40;

/** Writes an HLS package of {@link SEGMENTS} segments. */
const engine: VideoPackagingEngine = {
  async package(request) {
    await mkdir(join(request.outputDir, 'video'), { recursive: true });
    await writeFile(join(request.outputDir, 'video', 'init-1.m4s'), 'init');
    for (let i = 0; i < SEGMENTS; i += 1) {
      await writeFile(
        join(request.outputDir, 'video', `segment-${String(i).padStart(3, '0')}.m4s`),
        `s${i}`,
      );
    }
    await writeFile(join(request.outputDir, request.hlsEntry ?? 'index.m3u8'), '#EXTM3U');
    return { durationSeconds: 1, width: 1, height: 1 };
  },
};

/** A disk whose streamed writes take a few ms, tracking how many are in flight at once. */
class SlowDisk extends InMemoryDisk {
  inFlight = 0;
  maxInFlight = 0;
  failOn: string | undefined;
  readonly landedAfterFailure: string[] = [];
  #failed = false;

  override async putStream(key: string, contents: Readable, options?: DiskWriteOptions) {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) =>
        setTimeout(resolve, key.endsWith(this.failOn ?? '\0') ? 1 : 15),
      );
      if (this.failOn !== undefined && key.endsWith(this.failOn)) {
        this.#failed = true;
        throw new Error(`upload of ${key} failed`);
      }
      await super.putStream(key, contents, options);
      if (this.#failed) this.landedAfterFailure.push(key);
    } finally {
      this.inFlight -= 1;
    }
  }
}

function makeLibrary(disk: InMemoryDisk) {
  const library = new MediaLibrary({
    storage: new StorageManager({ default: 'fs', resolve: () => disk }),
    store: new InMemoryMediaStore(),
    collections: [
      { name: 'videos', transformers: [new VideoTransformer({ engine, formats: ['hls'] })] },
    ],
    idGenerator: () => 'vid-1',
    emitDiagnostics: false,
  });
  return library;
}

async function attach(library: MediaLibrary) {
  return library.attach({
    ownerType: 'Course',
    ownerId: '1',
    collection: 'videos',
    fileName: 'v.mp4',
    mimeType: 'video/mp4',
    contents: Buffer.from('mp4'),
  });
}

const prefix = 'Course/1/videos/vid-1/conversions/video/';

describe('transformers.video() — package upload', () => {
  it('uploads several files at once, within a small bound, and records them in sorted order', async () => {
    const disk = new SlowDisk();
    const library = makeLibrary(disk);
    await attach(library);

    const updated = await library.transform('vid-1', 'video');

    expect(disk.maxInFlight).toBeGreaterThan(1);
    expect(disk.maxInFlight).toBeLessThanOrEqual(8);
    const files = updated.conversions.video?.files ?? [];
    expect(files).toHaveLength(SEGMENTS + 2);
    expect(files).toEqual([...files].sort());
  });

  it('a failed upload waits for the ones in flight, then sweeps every artifact', async () => {
    const disk = new SlowDisk();
    disk.failOn = 'segment-010.m4s';
    const library = makeLibrary(disk);
    await attach(library);

    await expect(library.transform('vid-1', 'video')).rejects.toThrow('segment-010.m4s');

    expect(disk.inFlight).toBe(0);
    // Uploads already running when the failure hit still landed, and were swept with the rest.
    expect(disk.landedAfterFailure.length).toBeGreaterThan(0);
    expect([...disk.files.keys()].filter((key) => key.startsWith(prefix))).toEqual([]);
    expect((await library.find('vid-1'))?.conversions.video).toBeUndefined();
  });
});

describe('transformer writes — membership of what was written', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tracks written artifacts without scanning the list on every write', async () => {
    const ARTIFACTS = 2000;
    const artifacts: Record<string, string> = { 'index.m3u8': '#EXTM3U' };
    for (let i = 0; i < ARTIFACTS; i += 1) artifacts[`seg-${i}.ts`] = 's';
    const disk = new InMemoryDisk();
    const library = new MediaLibrary({
      storage: new StorageManager({ default: 'fs', resolve: () => disk }),
      store: new InMemoryMediaStore(),
      collections: [
        { name: 'videos', transformers: [new FakeTransformer({ name: 'video', artifacts })] },
      ],
      idGenerator: () => 'vid-1',
      emitDiagnostics: false,
    });
    await attach(library);
    const includes = vi.spyOn(Array.prototype, 'includes');

    const updated = await library.transform('vid-1', 'video');

    expect(updated.conversions.video?.files).toHaveLength(ARTIFACTS + 1);
    expect(includes.mock.calls.length).toBeLessThan(ARTIFACTS / 10);
  });
});
