import type { Readable } from 'node:stream';
import type { MediaLibrary } from './media_library.js';
import type { Disk } from './types.js';

/**
 * Requested READ strategy — the mirror image of `uploads.mode` for writes.
 *
 * - `public` — hand back the disk's stable public URL ({@link Disk.getUrl}).
 * - `signed` — hand back a time-limited signed URL ({@link Disk.getSignedUrl}).
 * - `proxy`  — stream the bytes through the app, so the storage never has to be reachable from the
 *   internet at all (a private bucket on a private network).
 * - `auto`   — ask the disk for the object's visibility: `public` when it is public, else `signed`.
 */
export type DeliveryMode = 'auto' | 'public' | 'signed' | 'proxy';

/** The concrete strategy after resolution — `auto` has been collapsed to one of these. */
export type ResolvedDeliveryMode = 'public' | 'signed' | 'proxy';

/** Signed-URL lifetime used when neither the call nor `delivery.signedTtlSeconds` sets one. */
export const DEFAULT_DELIVERY_SIGNED_TTL_SECONDS = 300;

/**
 * What delivering a media record yields. A discriminated union rather than an HTTP response,
 * because the library is framework-agnostic: the app turns a `redirect` into `response.redirect(url)`
 * and a `stream` into `response.stream(stream)` with whatever headers it wants.
 */
export type DeliveryResult =
  | { kind: 'redirect'; url: string }
  | {
      kind: 'stream';
      stream: Readable;
      mimeType: string;
      size?: number | undefined;
      fileName?: string | undefined;
    };

/**
 * Collapse a requested {@link DeliveryMode} to a concrete one for a specific object.
 *
 * Only `auto` needs the disk. Visibility is asked of the disk itself (`getVisibility`, which every
 * `@adonisjs/drive` disk exposes and which the bundled `disks.s3()` answers from its configured
 * visibility) — never guessed from `getUrl` being callable, since a URL can always be *synthesised*
 * for a private object and would resolve `auto` to a link that 403s.
 *
 * A disk that cannot answer leaves the visibility genuinely unknown, and the safe read of unknown is
 * "assume private": `auto` then resolves to `signed`, which works on a public object too.
 */
export async function resolveDeliveryMode(
  mode: DeliveryMode | undefined,
  disk: Disk,
  key: string,
): Promise<ResolvedDeliveryMode> {
  const requested: DeliveryMode = mode ?? 'auto';
  if (requested !== 'auto') return requested;
  if (typeof disk.getVisibility !== 'function') return 'signed';
  return (await disk.getVisibility(key)) === 'public' ? 'public' : 'signed';
}

/** What {@link MediaDeliveryHandler.handle} is asked to deliver. */
export interface DeliveryRequest {
  /** Id of the media record. */
  mediaId: string;
  /** Deliver this named conversion instead of the original (generated lazily if absent). */
  conversion?: string | undefined;
}

export interface MediaDeliveryHandlerOptions {
  /** The {@link MediaLibrary} records are resolved from — or a `MediaManager`, whose `.library` is used. */
  library: MediaLibrary | { library: MediaLibrary };
  /** Default mode for this handler; overrides the library's configured `delivery.mode`. */
  mode?: DeliveryMode | undefined;
  /** Signed-URL lifetime when the resolved mode is `signed`. */
  signedTtlSeconds?: number | undefined;
}

/**
 * Framework-agnostic read counterpart to {@link TusUploadHandler}: the app mounts ONE route, with
 * its own middleware, and delegates the "how do these bytes reach the client" question here.
 *
 * ```ts
 * const delivery = new MediaDeliveryHandler({ library: media })
 *
 * router.get('/media/:id', async ({ params, response, auth }) => {
 *   await authorize(auth.user, params.id)          // ← the app's job, see below
 *   const result = await delivery.handle({ mediaId: params.id })
 *   if (result.kind === 'redirect') return response.redirect(result.url)
 *   response.header('content-type', result.mimeType)
 *   return response.stream(result.stream)
 * }).use(middleware.auth())
 * ```
 *
 * **This handler performs NO authorization.** It resolves a media id to bytes or a URL and nothing
 * else — exactly the split {@link TusUploadHandler} draws. Whoever may read a given record is a
 * question only the app can answer, so guard the route (middleware, an ownership check, a signed
 * media token) before calling `handle`. Mounting it unguarded publishes every record to anyone who
 * can guess an id.
 */
export class MediaDeliveryHandler {
  private readonly library: MediaLibrary;
  private readonly mode: DeliveryMode | undefined;
  private readonly signedTtlSeconds: number | undefined;

  constructor(options: MediaDeliveryHandlerOptions) {
    const source = options.library;
    this.library = 'library' in source ? source.library : source;
    this.mode = options.mode;
    this.signedTtlSeconds = options.signedTtlSeconds;
  }

  handle(request: DeliveryRequest): Promise<DeliveryResult> {
    return this.library.deliver(request.mediaId, {
      ...(request.conversion !== undefined ? { conversion: request.conversion } : {}),
      ...(this.mode !== undefined ? { mode: this.mode } : {}),
      ...(this.signedTtlSeconds !== undefined ? { signedTtlSeconds: this.signedTtlSeconds } : {}),
    });
  }
}
