// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type MediaStreamData,
  type MediaStreamInput,
  type UseMediaStreamOptions,
  type UseMediaStreamResult,
  useMediaStream,
} from './use-media-stream.js';

const stream: MediaStreamData = {
  src: '/media/v1/stream/dash/index.m3u8',
  format: 'hls',
  sources: [
    { src: '/media/v1/stream/dash/index.m3u8', format: 'hls' },
    { src: '/media/v1/stream/dash/manifest.mpd', format: 'dash' },
  ],
};

/** A fake hls.js: records calls, lets the test fire events. */
function fakeHls(supported = true) {
  const instances: FakeHls[] = [];
  class FakeHls {
    static isSupported = () => supported;
    static Events = {
      MANIFEST_PARSED: 'hlsManifestParsed',
      FRAG_LOADED: 'hlsFragLoaded',
      LEVEL_SWITCHED: 'hlsLevelSwitched',
      ERROR: 'hlsError',
    };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    levels = [
      { width: 640, height: 360, bitrate: 800_000 },
      { width: 1280, height: 720, bitrate: 2_800_000 },
    ];
    currentLevel = -1;
    listeners: Record<string, (event: string, data: Record<string, unknown>) => void> = {};
    source?: string;
    media?: HTMLVideoElement;
    destroyed = false;
    startLoad = vi.fn();
    recoverMediaError = vi.fn();
    constructor(readonly config?: Record<string, unknown>) {
      instances.push(this);
    }
    on(event: string, listener: (event: string, data: Record<string, unknown>) => void) {
      this.listeners[event] = listener;
    }
    emit(event: string, data: Record<string, unknown> = {}) {
      act(() => this.listeners[event]?.(event, data));
    }
    loadSource(src: string) {
      this.source = src;
    }
    attachMedia(video: HTMLVideoElement) {
      this.media = video;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  return { loader: async () => ({ default: FakeHls }), instances };
}

/** A fake dash.js (v4 shape: `MediaPlayer` on the default export). */
function fakeDash() {
  const players: FakePlayer[] = [];
  class FakePlayer {
    listeners: Record<string, (event: Record<string, unknown>) => void> = {};
    initialized?: { video: HTMLVideoElement; url: string };
    settings: Record<string, unknown>[] = [];
    quality?: number;
    resetCalled = false;
    initialize(video: HTMLVideoElement, url: string) {
      this.initialized = { video, url };
    }
    updateSettings(settings: Record<string, unknown>) {
      this.settings.push(settings);
    }
    on(event: string, listener: (event: Record<string, unknown>) => void) {
      this.listeners[event] = listener;
    }
    emit(event: string, data: Record<string, unknown> = {}) {
      act(() => this.listeners[event]?.(data));
    }
    getBitrateInfoListFor() {
      return [{ width: 640, height: 360, bitrate: 800_000 }];
    }
    setQualityFor(_type: string, index: number) {
      this.quality = index;
    }
    reset() {
      this.resetCalled = true;
    }
  }
  const MediaPlayer = Object.assign(
    () => ({
      create: () => {
        const player = new FakePlayer();
        players.push(player);
        return player;
      },
    }),
    {
      events: {
        STREAM_INITIALIZED: 'streamInitialized',
        QUALITY_CHANGE_RENDERED: 'qualityChangeRendered',
        ERROR: 'error',
      },
    },
  );
  return {
    loader: async () => ({ default: { MediaPlayer, supportsMediaSource: () => true } }),
    players,
  };
}

/** Renders a `<video>` driven by the hook; `result()` is the hook's latest return. */
function mount(input: MediaStreamInput, options: UseMediaStreamOptions = {}) {
  let latest: UseMediaStreamResult | undefined;
  function Player({ value }: { value: MediaStreamInput }) {
    const ref = useRef<HTMLVideoElement>(null);
    latest = useMediaStream(ref, value, options);
    return (
      <video ref={ref} data-testid="video">
        <track kind="captions" />
      </video>
    );
  }
  const view = render(<Player value={input} />);
  return {
    result: () => latest!,
    video: () => view.getByTestId('video') as HTMLVideoElement,
    rerender: (value: MediaStreamInput) => view.rerender(<Player value={value} />),
    unmount: view.unmount,
  };
}

function canPlayHlsNatively(yes: boolean) {
  vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type) =>
    yes && type === 'application/vnd.apple.mpegurl' ? 'maybe' : '',
  );
}

// jsdom implements no media pipeline; `load()` only logs that.
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('useMediaStream', () => {
  it('plays HLS through hls.js and exposes its qualities', async () => {
    canPlayHlsNatively(false);
    const hls = fakeHls();
    const view = mount(stream, { hls: hls.loader, hlsConfig: { maxBufferLength: 10 } });

    await waitFor(() => expect(view.result().engine).toBe('hls.js'));
    const instance = hls.instances[0]!;
    expect(instance.config).toEqual({ maxBufferLength: 10 });
    expect(instance.source).toBe('/media/v1/stream/dash/index.m3u8');
    expect(instance.media).toBe(view.video());
    expect(view.result().ready).toBe(false);

    instance.emit('hlsManifestParsed');
    expect(view.result().ready).toBe(true);
    expect(view.result().levels).toEqual([
      { index: 0, width: 640, height: 360, bitrate: 800_000 },
      { index: 1, width: 1280, height: 720, bitrate: 2_800_000 },
    ]);
    expect(view.result().instance).toBe(instance);

    act(() => view.result().setLevel(1));
    expect(instance.currentLevel).toBe(1);
    expect(view.result().autoLevel).toBe(false);
    instance.emit('hlsLevelSwitched', { level: 1 });
    expect(view.result().currentLevel).toBe(1);
    act(() => view.result().setLevel(-1));
    expect(instance.currentLevel).toBe(-1);
    expect(view.result().autoLevel).toBe(true);
  });

  it('plays HLS natively when the browser can and no hls.js is given (iPhone)', async () => {
    canPlayHlsNatively(true);
    const view = mount(stream);
    await waitFor(() => expect(view.result().engine).toBe('native'));
    expect(view.video().getAttribute('src')).toBe('/media/v1/stream/dash/index.m3u8');
    act(() => {
      view.video().dispatchEvent(new Event('loadedmetadata'));
    });
    expect(view.result().ready).toBe(true);
    expect(view.result().levels).toEqual([]);
  });

  it('falls back to native HLS when hls.js is not supported (no MSE)', async () => {
    canPlayHlsNatively(true);
    const hls = fakeHls(false);
    const view = mount(stream, { hls: hls.loader });
    await waitFor(() => expect(view.result().engine).toBe('native'));
    expect(hls.instances).toHaveLength(0);
  });

  it('with preferNative, does not even load hls.js where native HLS works', async () => {
    canPlayHlsNatively(true);
    const loader = vi.fn(fakeHls().loader);
    const view = mount(stream, { hls: loader, preferNative: true });
    await waitFor(() => expect(view.result().engine).toBe('native'));
    expect(loader).not.toHaveBeenCalled();
  });

  it('moves on to DASH when HLS cannot play, and drives dash.js', async () => {
    canPlayHlsNatively(false);
    const dash = fakeDash();
    const view = mount(stream, { dash: dash.loader, dashSettings: { debug: { logLevel: 0 } } });

    await waitFor(() => expect(view.result().engine).toBe('dash.js'));
    const player = dash.players[0]!;
    expect(player.initialized).toEqual({
      video: view.video(),
      url: '/media/v1/stream/dash/manifest.mpd',
    });
    expect(player.settings[0]).toEqual({ debug: { logLevel: 0 } });

    player.emit('streamInitialized');
    expect(view.result().ready).toBe(true);
    expect(view.result().levels).toEqual([{ index: 0, width: 640, height: 360, bitrate: 800_000 }]);

    act(() => view.result().setLevel(0));
    expect(player.quality).toBe(0);
    expect(player.settings.at(-1)).toEqual({
      streaming: { abr: { autoSwitchBitrate: { video: false } } },
    });
    player.emit('qualityChangeRendered', { mediaType: 'video', newQuality: 0 });
    expect(view.result().currentLevel).toBe(0);

    player.emit('error', { error: { message: 'manifest 403' } });
    expect(view.result().error?.message).toBe('dash.js: manifest 403');
  });

  it('reports an error when nothing can play, naming the missing loaders', async () => {
    canPlayHlsNatively(false);
    const view = mount(stream);
    await waitFor(() => expect(view.result().error).not.toBeNull());
    expect(view.result().error?.message).toMatch(/No playable source: hls, dash/);
    expect(view.result().engine).toBeNull();
  });

  it('recovers from fatal hls.js errors once, then reports', async () => {
    canPlayHlsNatively(false);
    const hls = fakeHls();
    const view = mount(stream, { hls: hls.loader });
    await waitFor(() => expect(view.result().engine).toBe('hls.js'));
    const instance = hls.instances[0]!;

    instance.emit('hlsError', { fatal: false, type: 'mediaError' });
    instance.emit('hlsError', { fatal: true, type: 'networkError' });
    expect(instance.startLoad).toHaveBeenCalledTimes(1);
    instance.emit('hlsError', { fatal: true, type: 'mediaError' });
    expect(instance.recoverMediaError).toHaveBeenCalledTimes(1);
    expect(view.result().error).toBeNull();

    instance.emit('hlsError', { fatal: true, type: 'mediaError', details: 'bufferAppendError' });
    expect(view.result().error?.message).toBe('hls.js: bufferAppendError');
    expect(instance.destroyed).toBe(true);
  });

  it('gives up after repeated fatal network errors, unless fragments arrive in between', async () => {
    canPlayHlsNatively(false);
    const hls = fakeHls();
    const view = mount(stream, { hls: hls.loader });
    await waitFor(() => expect(view.result().engine).toBe('hls.js'));
    const instance = hls.instances[0]!;

    instance.emit('hlsError', { fatal: true, type: 'networkError' });
    instance.emit('hlsError', { fatal: true, type: 'networkError' });
    instance.emit('hlsFragLoaded');
    instance.emit('hlsError', { fatal: true, type: 'networkError' });
    instance.emit('hlsError', { fatal: true, type: 'networkError' });
    expect(instance.startLoad).toHaveBeenCalledTimes(4);
    expect(view.result().error).toBeNull();

    // A third in a row (an expired signature, an outage): reported, not retried forever.
    instance.emit('hlsError', { fatal: true, type: 'networkError', details: 'manifestLoadError' });
    expect(instance.startLoad).toHaveBeenCalledTimes(4);
    expect(view.result().error?.message).toBe('hls.js: manifestLoadError');
    expect(instance.destroyed).toBe(true);
  });

  it('reads dash.js v5 representations, bitrate in kbit included', async () => {
    canPlayHlsNatively(false);
    const dash = fakeDash();
    const view = mount('/m/manifest.mpd', { dash: dash.loader });
    await waitFor(() => expect(view.result().engine).toBe('dash.js'));
    const player = dash.players[0]! as unknown as Record<string, unknown> & {
      emit(event: string): void;
    };
    player.getRepresentationsByType = () => [
      { width: 640, height: 360, bitrateInKbit: 800 },
      { width: 1280, height: 720, bandwidth: 2_800_000 },
    ];
    let pinned: number | undefined;
    player.setRepresentationForTypeByIndex = (_type: string, index: number) => {
      pinned = index;
    };
    player.emit('streamInitialized');
    expect(view.result().levels).toEqual([
      { index: 0, width: 640, height: 360, bitrate: 800_000 },
      { index: 1, width: 1280, height: 720, bitrate: 2_800_000 },
    ]);
    act(() => view.result().setLevel(1));
    expect(pinned).toBe(1);
  });

  it('tears the player down when the stream changes and on unmount', async () => {
    canPlayHlsNatively(false);
    const hls = fakeHls();
    const view = mount(stream, { hls: hls.loader });
    await waitFor(() => expect(hls.instances).toHaveLength(1));

    view.rerender('/media/v2/stream/hls/index.m3u8');
    await waitFor(() => expect(hls.instances).toHaveLength(2));
    expect(hls.instances[0]!.destroyed).toBe(true);
    expect(hls.instances[1]!.source).toBe('/media/v2/stream/hls/index.m3u8');

    view.unmount();
    expect(hls.instances[1]!.destroyed).toBe(true);
  });

  it('reads the format of a bare URL from its extension', async () => {
    canPlayHlsNatively(false);
    const dash = fakeDash();
    const view = mount('/videos/a/manifest.mpd?exp=1&sig=x', { dash: dash.loader });
    await waitFor(() => expect(view.result().engine).toBe('dash.js'));
    expect(dash.players[0]!.initialized?.url).toBe('/videos/a/manifest.mpd?exp=1&sig=x');
  });

  it('does nothing without a stream', () => {
    const view = mount(null);
    expect(view.result()).toMatchObject({ engine: null, ready: false, error: null, levels: [] });
  });
});
