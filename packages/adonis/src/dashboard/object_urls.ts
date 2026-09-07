/**
 * How the console hands out the `url` it reports for an object's bytes — the link the UI offers as
 * "Open ↗", and the `src` an image/video/audio preview renders from.
 *
 * - `auto` (default): a short-lived signed URL straight to the object store. A real link: it
 *   survives a copy-paste out of the console and needs nothing from this server to resolve.
 * - `proxy`: the console's own same-origin route (`<apiBase>/object/raw`). For a host whose browser
 *   has no path to the store at all — no network route, no CORS grant, a policy against
 *   client-to-bucket traffic — where a signed URL is a link that cannot be opened. The trade is that
 *   these URLs are only meaningful to a session that can reach this server, and every byte travels
 *   through it.
 *
 * Ported from the NestJS sibling console's `server/object-urls.ts`, so the two consoles answer the
 * "the bucket is not reachable from the browser" question the same way, under the same option name.
 *
 * The PDF and text previews are unaffected: they already read through `<apiBase>/object/raw`
 * unconditionally, because they need same-origin bytes to render at all.
 */
export type ObjectUrlStrategy = 'auto' | 'proxy';

/** The resolved {@link ObjectUrlStrategy} plus what `proxy` needs to build a URL. Travels as one
 *  value so the service can never see a strategy without the mount path it depends on. */
export interface ObjectUrlConfig {
  strategy: ObjectUrlStrategy;
  /** Where the console's JSON API is mounted — leading slash, no trailing slash. */
  apiBasePath: string;
}

/**
 * Same-origin URL for the console's object-byte route, rooted at the API mount.
 *
 * Query params rather than the NestJS sibling's `/disks/:disk/object/raw` path segment because that
 * is the shape this console's route already has (`dashboard_provider.ts`) — the SPA's own
 * `objectRawUrl()` builds the identical URL, which is what makes a `proxy` `url` interchangeable
 * with it.
 */
export function objectProxyUrl(apiBasePath: string, disk: string, key: string): string {
  const query = new URLSearchParams({ disk, key });
  return `${apiBasePath}/object/raw?${query.toString()}`;
}
