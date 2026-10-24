import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';

/** A streaming format. */
export type MediaStreamFormat = 'hls' | 'dash';

/** One playable source — an entry of `media.library.stream(id).sources`. */
export interface MediaStreamSourceData {
  src: string;
  format: MediaStreamFormat;
  type?: string;
}

/**
 * What `media.library.stream(id)` / `media.access.stream(ctx, id)` return on the server, passed
 * through as a prop. Only `sources` (or `src` + `format`) is read.
 */
export interface MediaStreamData {
  src: string;
  format: MediaStreamFormat;
  sources?: readonly MediaStreamSourceData[];
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/**
 * The stream to play: the server's descriptor, one source, or a bare manifest URL (its format
 * read from the extension). `null`/`undefined` detaches.
 */
export type MediaStreamInput = MediaStreamData | MediaStreamSourceData | string | null | undefined;

/**
 * Lazily loads a player library. Pass the `import()` itself, so your bundler only includes the
 * libraries you use, and only fetches them when a video needs one:
 * `{ hls: () => import('hls.js'), dash: () => import('dashjs') }`.
 */
export type PlayerLoader = () => Promise<unknown>;

export interface UseMediaStreamOptions {
  /** Loads hls.js — used for HLS wherever Media Source Extensions exist. Without it, HLS plays only natively (Safari, iOS). */
  hls?: PlayerLoader;
  /** Loads dash.js — needed for DASH sources. */
  dash?: PlayerLoader;
  /** hls.js config, passed to `new Hls(config)`. */
  hlsConfig?: Record<string, unknown>;
  /** dash.js settings, passed to `player.updateSettings(settings)`. */
  dashSettings?: Record<string, unknown>;
  /**
   * Play HLS natively whenever the browser can, even with hls.js available. Default `false`:
   * hls.js where it runs gives quality selection everywhere; native is the fallback (iPhone).
   */
  preferNative?: boolean;
}

/** One quality the player can switch to. */
export interface MediaStreamLevel {
  /** What {@link UseMediaStreamResult.setLevel} takes. */
  index: number;
  width?: number;
  height?: number;
  /** Bits per second. */
  bitrate?: number;
}

/** Which engine is playing. */
export type MediaStreamEngine = 'native' | 'hls.js' | 'dash.js';

export interface UseMediaStreamResult {
  /** `null` until a source is attached. */
  engine: MediaStreamEngine | null;
  /** The source being played. */
  source: MediaStreamSourceData | null;
  /** The manifest is loaded and the qualities known. */
  ready: boolean;
  /** A fatal error, or no source this browser can play. */
  error: Error | null;
  /** The qualities, lowest first as the manifest lists them. Empty with native playback (the browser picks). */
  levels: MediaStreamLevel[];
  /** The quality playing now, `-1` when unknown. */
  currentLevel: number;
  /** Whether the player picks the quality itself (adaptive bitrate). */
  autoLevel: boolean;
  /** Pin a quality by its `index`, or `-1` to go back to automatic. */
  setLevel(index: number): void;
  /** The `Hls` instance or dash.js `MediaPlayer`, for anything this hook does not cover. */
  instance: unknown;
}

/** What attaching one source yields. */
interface Controller {
  engine: MediaStreamEngine;
  instance: unknown;
  setLevel(index: number): void;
  destroy(): void;
}

type Update = (patch: Partial<State>) => void;

interface State {
  engine: MediaStreamEngine | null;
  source: MediaStreamSourceData | null;
  ready: boolean;
  error: Error | null;
  levels: MediaStreamLevel[];
  currentLevel: number;
  autoLevel: boolean;
  instance: unknown;
}

const INITIAL: State = {
  engine: null,
  source: null,
  ready: false,
  error: null,
  levels: [],
  currentLevel: -1,
  autoLevel: true,
  instance: null,
};

const HLS_TYPE = 'application/vnd.apple.mpegurl';

/** Consecutive fatal network errors hls.js may retry before the hook reports `error`. */
const MAX_NETWORK_RETRIES = 2;

/**
 * Plays an HLS or DASH stream in **your** `<video>` — headless: no markup, no controls, no
 * styling. It attaches the right engine and hands back the state to build your own controls on
 * (or none: `controls` on the element is enough).
 *
 * ```tsx
 * // server: video: await media.access.stream(ctx, lesson.videoMediaId)
 * const ref = useRef<HTMLVideoElement>(null)
 * const stream = useMediaStream(ref, video, {
 *   hls: () => import('hls.js'),
 *   dash: () => import('dashjs'),
 * })
 *
 * <video ref={ref} controls playsInline />
 * {stream.levels.map((l) => <button onClick={() => stream.setLevel(l.index)}>{l.height}p</button>)}
 * ```
 *
 * Sources are tried in order (the server lists HLS first). HLS plays through hls.js where Media
 * Source Extensions exist and natively otherwise (iPhone); DASH through dash.js. A player library
 * is only loaded when a source needs it. Changing the stream, or unmounting, tears the player down.
 */
export function useMediaStream(
  videoRef: RefObject<HTMLVideoElement | null>,
  stream: MediaStreamInput,
  options: UseMediaStreamOptions = {},
): UseMediaStreamResult {
  const [state, setState] = useState<State>(INITIAL);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const controllerRef = useRef<Controller | null>(null);

  const sources = sourcesOf(stream);
  const key = sources.map((s) => `${s.format} ${s.src}`).join('\n');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is the identity of `sources`
  useEffect(() => {
    const video = videoRef.current;
    setState(INITIAL);
    if (!video || sources.length === 0) return;

    let cancelled = false;
    let controller: Controller | null = null;
    const update: Update = (patch) => {
      if (!cancelled) setState((current) => ({ ...current, ...patch }));
    };

    (async () => {
      const failures: Error[] = [];
      for (const source of sources) {
        try {
          const attached = await attach(video, source, optionsRef.current, update);
          if (!attached) continue;
          if (cancelled) {
            attached.destroy();
            return;
          }
          controller = attached;
          controllerRef.current = attached;
          update({ engine: attached.engine, source, instance: attached.instance });
          return;
        } catch (error) {
          failures.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
      update({
        error:
          failures[0] ??
          new Error(
            `No playable source: ${sources.map((s) => s.format).join(', ')}. ` +
              'Pass `hls: () => import("hls.js")` / `dash: () => import("dashjs")` to useMediaStream.',
          ),
      });
    })();

    return () => {
      cancelled = true;
      controller?.destroy();
      controllerRef.current = null;
    };
  }, [key, videoRef]);

  const setLevel = useCallback((index: number) => {
    controllerRef.current?.setLevel(index);
    setState((current) => ({ ...current, autoLevel: index === -1 }));
  }, []);

  return { ...state, setLevel };
}

function sourcesOf(stream: MediaStreamInput): MediaStreamSourceData[] {
  if (!stream) return [];
  if (typeof stream === 'string') {
    const format = /\.mpd($|[?#])/i.test(stream) ? 'dash' : 'hls';
    return [{ src: stream, format }];
  }
  if ('sources' in stream && stream.sources && stream.sources.length > 0) {
    return [...stream.sources];
  }
  return [{ src: stream.src, format: stream.format }];
}

/** Attach one source; `null` when this browser/configuration cannot play it (try the next). */
async function attach(
  video: HTMLVideoElement,
  source: MediaStreamSourceData,
  options: UseMediaStreamOptions,
  update: Update,
): Promise<Controller | null> {
  if (source.format === 'dash') {
    return options.dash ? attachDash(video, source.src, options, update) : null;
  }
  const native = video.canPlayType(HLS_TYPE) !== '';
  if (native && (options.preferNative || !options.hls))
    return attachNative(video, source.src, update);
  if (options.hls) {
    const controller = await attachHls(video, source.src, options, update);
    if (controller) return controller;
  }
  return native ? attachNative(video, source.src, update) : null;
}

function attachNative(video: HTMLVideoElement, src: string, update: Update): Controller {
  const onLoaded = () => update({ ready: true });
  const onError = () =>
    update({
      error: new Error(
        `The browser could not play ${src} (MediaError ${video.error?.code ?? '?'})`,
      ),
    });
  video.addEventListener('loadedmetadata', onLoaded);
  video.addEventListener('error', onError);
  video.src = src;
  return {
    engine: 'native',
    instance: null,
    // Native HLS picks the quality itself; there is nothing to pin.
    setLevel() {},
    destroy() {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onError);
      video.removeAttribute('src');
      video.load();
    },
  };
}

/** The slice of hls.js this hook uses. */
interface HlsLike {
  levels: { width?: number; height?: number; bitrate?: number }[];
  currentLevel: number;
  on(event: string, listener: (event: string, data: Record<string, unknown>) => void): void;
  loadSource(src: string): void;
  attachMedia(video: HTMLVideoElement): void;
  startLoad(): void;
  recoverMediaError(): void;
  destroy(): void;
}
interface HlsClass {
  new (config?: Record<string, unknown>): HlsLike;
  isSupported(): boolean;
  Events: Record<string, string>;
  ErrorTypes: Record<string, string>;
}

async function attachHls(
  video: HTMLVideoElement,
  src: string,
  options: UseMediaStreamOptions,
  update: Update,
): Promise<Controller | null> {
  const loaded = (await options.hls!()) as { default?: HlsClass } & Partial<HlsClass>;
  const Hls = (loaded.default ?? loaded) as HlsClass;
  if (!Hls.isSupported()) return null;

  const hls = new Hls(options.hlsConfig);
  let recovered = false;
  let networkRetries = 0;
  // Any fragment that arrives proves the network is back: the retry budget starts over.
  hls.on(Hls.Events.FRAG_LOADED ?? 'hlsFragLoaded', () => {
    networkRetries = 0;
  });
  hls.on(Hls.Events.MANIFEST_PARSED!, () => {
    update({
      ready: true,
      levels: hls.levels.map((level, index) => ({
        index,
        ...(level.width ? { width: level.width } : {}),
        ...(level.height ? { height: level.height } : {}),
        ...(level.bitrate ? { bitrate: level.bitrate } : {}),
      })),
    });
  });
  hls.on(Hls.Events.LEVEL_SWITCHED!, (_event, data) => {
    update({ currentLevel: Number(data.level) });
  });
  hls.on(Hls.Events.ERROR!, (_event, data) => {
    if (!data.fatal) return;
    // hls.js's own recovery recipe: retry the network, rebuild the media pipeline once. Retries
    // are capped, so an outage or a revoked URL (403) surfaces instead of looping forever.
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < MAX_NETWORK_RETRIES) {
      networkRetries += 1;
      return hls.startLoad();
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
      recovered = true;
      return hls.recoverMediaError();
    }
    update({ error: new Error(`hls.js: ${String(data.details ?? data.type)}`) });
    hls.destroy();
  });
  hls.loadSource(src);
  hls.attachMedia(video);
  return {
    engine: 'hls.js',
    instance: hls,
    setLevel(index) {
      hls.currentLevel = index;
    },
    destroy() {
      hls.destroy();
    },
  };
}

/** The slice of dash.js (v4 and v5) this hook uses. */
interface DashPlayerLike {
  initialize(video: HTMLVideoElement, url: string, autoPlay: boolean): void;
  updateSettings(settings: Record<string, unknown>): void;
  on(event: string, listener: (event: Record<string, unknown>) => void): void;
  reset(): void;
  getRepresentationsByType?(
    type: string,
  ): { width?: number; height?: number; bandwidth?: number; bitrateInKbit?: number }[];
  getBitrateInfoListFor?(type: string): { width?: number; height?: number; bitrate?: number }[];
  setRepresentationForTypeByIndex?(type: string, index: number): void;
  setQualityFor?(type: string, index: number): void;
}
interface DashModule {
  MediaPlayer(): { create(): DashPlayerLike };
  supportsMediaSource?(): boolean;
}

async function attachDash(
  video: HTMLVideoElement,
  src: string,
  options: UseMediaStreamOptions,
  update: Update,
): Promise<Controller | null> {
  const loaded = (await options.dash!()) as { default?: DashModule } & Partial<DashModule>;
  const dash = (loaded.MediaPlayer ? loaded : loaded.default) as DashModule;
  if (dash.supportsMediaSource && !dash.supportsMediaSource()) return null;

  const MediaPlayer = dash.MediaPlayer as DashModule['MediaPlayer'] & {
    events?: Record<string, string>;
  };
  const events = MediaPlayer.events ?? {};
  const player = MediaPlayer().create();
  if (options.dashSettings) player.updateSettings(options.dashSettings);

  const levels = (): MediaStreamLevel[] => {
    const list =
      // v5 Representation: `bandwidth` (bps) or `bitrateInKbit`; v4 BitrateInfo: `bitrate` (bps).
      player.getRepresentationsByType?.('video').map((r) => ({
        ...r,
        bitrate: r.bandwidth ?? (r.bitrateInKbit ? r.bitrateInKbit * 1000 : undefined),
      })) ??
      player.getBitrateInfoListFor?.('video') ??
      [];
    return list.map((level, index) => ({
      index,
      ...(level.width ? { width: level.width } : {}),
      ...(level.height ? { height: level.height } : {}),
      ...(level.bitrate ? { bitrate: level.bitrate } : {}),
    }));
  };
  player.on(events.STREAM_INITIALIZED ?? 'streamInitialized', () => {
    update({ ready: true, levels: levels() });
  });
  player.on(events.QUALITY_CHANGE_RENDERED ?? 'qualityChangeRendered', (event) => {
    if (event.mediaType !== 'video') return;
    // v4 reports `newQuality`; v5 the new representation (with its `index`).
    const representation = event.newRepresentation as { index?: number } | undefined;
    const index = representation?.index ?? event.newQuality;
    if (typeof index === 'number') update({ currentLevel: index });
  });
  player.on(events.ERROR ?? 'error', (event) => {
    const error = event.error as { message?: string } | undefined;
    update({ error: new Error(`dash.js: ${error?.message ?? 'playback error'}`) });
  });
  player.initialize(video, src, false);

  return {
    engine: 'dash.js',
    instance: player,
    setLevel(index) {
      const auto = index === -1;
      player.updateSettings({
        streaming: { abr: { autoSwitchBitrate: { video: auto } } },
      });
      if (auto) return;
      if (player.setRepresentationForTypeByIndex) {
        player.setRepresentationForTypeByIndex('video', index);
      } else {
        player.setQualityFor?.('video', index);
      }
    },
    destroy() {
      player.reset();
    },
  };
}
