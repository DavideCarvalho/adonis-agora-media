import type { DeliveryResult } from '../delivery.js';
import { DEFAULT_DELIVERY_SIGNED_TTL_SECONDS } from '../delivery.js';
import {
  ConversionArtifactMissingError,
  MediaNotFoundError,
  TransformNotReadyError,
} from '../errors.js';
import type { MediaLibrary } from '../media_library.js';
import {
  HLS_PLAYLIST_CONTENT_TYPE,
  hlsArtifactContentType,
  resolvePackagePath,
  rewriteHlsPlaylist,
} from './playlist.js';

/** Identifies one file of a media's HLS package, handed to the URL callbacks. */
export interface HlsFileRef {
  mediaId: string;
  /** Package-relative artifact path (`'index.m3u8'`, `'playlist-1.m3u8'`, `'segment-0-3.ts'`). */
  file: string;
}

/** Builds the URL a rewritten playlist reference should point at. */
export type HlsUrlBuilder = (ref: HlsFileRef) => string | Promise<string>;

/** What {@link HlsDeliveryHandler.handle} is asked to serve. */
export interface HlsDeliveryRequest {
  mediaId: string;
  /**
   * Which file of the package, relative to the conversion prefix. Omit for the entry (master)
   * playlist. Validated against the conversion's persisted artifact list, so a request can never
   * reach outside the package.
   */
  file?: string | undefined;
}

/**
 * What serving one HLS package file yields: playlists come back as rewritten text (they are
 * *always* rewritten, never proxied raw — raw ones reference the storage layout, not URLs), and
 * media files come back as the usual {@link DeliveryResult} (`redirect` to a signed URL, or a
 * `stream` to pipe).
 */
export type HlsDeliveryResult =
  | { kind: 'playlist'; content: string; contentType: string; fileName: string }
  | DeliveryResult;

export interface HlsDeliveryHandlerOptions {
  /** The {@link MediaLibrary} records are resolved from — or a `MediaManager`, whose `.library` is used. */
  library: MediaLibrary | { library: MediaLibrary };
  /** Name of the HLS conversion on the record. Default `'hls'` (the {@link HlsTransformer} default). */
  conversion?: string | undefined;
  /**
   * URL for a **sub-playlist** reference (master → media playlists, audio renditions). Required,
   * and it should point back at a route of yours that calls this handler again — playlists must be
   * rewritten on every hop, and your route is where your authorization runs. There is no safe
   * library default: presigning a playlist would serve it raw from storage, whose relative
   * references then resolve against the storage host and break (or leak).
   */
  urlForPlaylist: HlsUrlBuilder;
  /**
   * URL for a **media** reference (segments, init sections). Default: a presigned URL straight to
   * the object on the disk (`segmentTtlSeconds` lifetime) — the common case, letting players pull
   * segments from storage/CDN without the bytes transiting your app. Point it at your own proxy
   * route instead when storage isn't reachable from clients (then serve those requests with
   * {@link HlsDeliveryHandler.handle}, which streams media files per `segmentDelivery`).
   */
  urlForSegment?: HlsUrlBuilder | undefined;
  /** Lifetime of default presigned segment URLs, seconds. Default 300. */
  segmentTtlSeconds?: number | undefined;
  /**
   * How {@link HlsDeliveryHandler.handle} answers a request for a media file (it always answers
   * playlists with rewritten text): `'redirect'` (default) to a presigned URL, or `'stream'` to
   * proxy the bytes through the app.
   */
  segmentDelivery?: 'redirect' | 'stream' | undefined;
}

/**
 * Framework-agnostic HLS read path — the {@link MediaDeliveryHandler} of a transformer-generated
 * HLS package. One route of yours receives `(:mediaId, :file?)` and delegates here; the handler
 * resolves the record's HLS conversion, validates the requested file against the package's
 * persisted artifact list, and:
 *
 * - for a **playlist**: returns its content with every relative reference rewritten — sub-playlist
 *   references through your `urlForPlaylist` (auth stays yours), media references through
 *   `urlForSegment` or a presigned URL;
 * - for a **media file**: returns a `redirect` (presigned) or a `stream`, per `segmentDelivery`.
 *
 * ```ts
 * const hls = new HlsDeliveryHandler({
 *   library: media,
 *   urlForPlaylist: ({ mediaId, file }) => router.makeUrl('videos.hls', { id: mediaId, file }),
 * })
 *
 * router.get('/videos/:id/hls/:file?', async ({ params, response, auth }) => {
 *   await authorize(auth.user, params.id)             // ← the app's job, as everywhere
 *   const result = await hls.handle({ mediaId: params.id, file: params.file })
 *   if (result.kind === 'redirect') return response.redirect(result.url)
 *   if (result.kind === 'stream') {
 *     response.header('content-type', result.mimeType)
 *     return response.stream(result.stream)
 *   }
 *   response.header('content-type', result.contentType)
 *   return response.send(result.content)
 * }).use(middleware.auth())
 * ```
 *
 * **This handler performs NO authorization** — the same split as {@link MediaDeliveryHandler} and
 * `TusUploadHandler`: guard the route before calling `handle`. Note that a presigned segment URL
 * (the default) is itself a capability: whoever holds it can fetch that segment until the TTL
 * expires. That is the standard HLS trade-off — keep `segmentTtlSeconds` short, or use
 * `segmentDelivery: 'stream'` with a segment `urlForSegment` pointing back at your route to keep
 * every byte behind your auth.
 */
export class HlsDeliveryHandler {
  private readonly library: MediaLibrary;
  private readonly conversion: string;
  private readonly urlForPlaylist: HlsUrlBuilder;
  private readonly urlForSegment: HlsUrlBuilder | undefined;
  private readonly segmentTtlSeconds: number;
  private readonly segmentDelivery: 'redirect' | 'stream';

  constructor(options: HlsDeliveryHandlerOptions) {
    const source = options.library;
    this.library = 'library' in source ? source.library : source;
    this.conversion = options.conversion ?? 'hls';
    this.urlForPlaylist = options.urlForPlaylist;
    this.urlForSegment = options.urlForSegment;
    this.segmentTtlSeconds = options.segmentTtlSeconds ?? DEFAULT_DELIVERY_SIGNED_TTL_SECONDS;
    this.segmentDelivery = options.segmentDelivery ?? 'redirect';
  }

  async handle(request: HlsDeliveryRequest): Promise<HlsDeliveryResult> {
    const { mediaId } = request;
    const record = await this.library.find(mediaId);
    if (!record) throw new MediaNotFoundError(mediaId);

    const variant = record.conversions[this.conversion];
    if (!variant) throw new TransformNotReadyError(mediaId, this.conversion);
    if (variant.path === undefined || variant.disk === undefined) {
      throw new ConversionArtifactMissingError(mediaId, this.conversion);
    }

    // The package's shape comes from what the transformer persisted; a hand-registered
    // single-file conversion degrades to a one-file package.
    const prefix = variant.prefix ?? variant.path.slice(0, variant.path.lastIndexOf('/') + 1);
    const files = variant.files ?? [variant.path.slice(prefix.length)];
    const entry = variant.path.slice(prefix.length);

    const requested = request.file === undefined || request.file === '' ? entry : request.file;
    // Membership in the persisted artifact list is the whole access check: no path arithmetic on
    // caller input ever reaches the disk, so traversal is structurally impossible.
    if (!files.includes(requested)) {
      throw new MediaNotFoundError(`${mediaId}#${this.conversion}:${requested}`);
    }

    const disk = this.library.storage.disk(variant.disk);
    const key = `${prefix}${requested}`;

    if (requested.toLowerCase().endsWith('.m3u8')) {
      const content = Buffer.from(await disk.getBytes(key)).toString('utf8');
      const rewritten = await rewriteHlsPlaylist(content, async (ref) => {
        const target = resolvePackagePath(requested, ref.uri);
        // A relative reference that escapes the package or names a file the transformer never
        // wrote is not ours to rewrite — leave it exactly as it was.
        if (target === null || !files.includes(target)) return ref.uri;
        if (ref.kind === 'playlist') return this.urlForPlaylist({ mediaId, file: target });
        if (this.urlForSegment) return this.urlForSegment({ mediaId, file: target });
        return disk.getSignedUrl(`${prefix}${target}`, { expiresIn: this.segmentTtlSeconds });
      });
      return {
        kind: 'playlist',
        content: rewritten,
        contentType: HLS_PLAYLIST_CONTENT_TYPE,
        fileName: requested,
      };
    }

    if (this.segmentDelivery === 'redirect') {
      return {
        kind: 'redirect',
        url: await disk.getSignedUrl(key, { expiresIn: this.segmentTtlSeconds }),
      };
    }

    const metadata = await disk.getMetaData(key);
    return {
      kind: 'stream',
      stream: await disk.getStream(key),
      mimeType:
        metadata.contentType ?? hlsArtifactContentType(requested) ?? 'application/octet-stream',
      size: metadata.contentLength,
      fileName: requested.slice(requested.lastIndexOf('/') + 1),
    };
  }
}
