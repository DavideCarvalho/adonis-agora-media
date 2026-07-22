/**
 * HLS playlist (`.m3u8`) reference rewriting — the read-side half of the HLS transformer.
 *
 * Playlists are STORED with references relative to the package's storage layout (that is what the
 * muxer emits, and it keeps the stored artifacts location-agnostic). At serve time those
 * references must become URLs the player can actually fetch — the app's authenticated proxy
 * routes, presigned object URLs, a CDN — and only the app knows which. This module does the part
 * that is the same everywhere: find every reference in a playlist, classify it, and let a
 * callback decide the URL. See {@link HlsDeliveryHandler} for the assembled read path.
 */

/** Content type playlists are served with (RFC 8216's `application/vnd.apple.mpegurl`). */
export const HLS_PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

/** Content type for MPEG-TS segments. */
export const HLS_SEGMENT_CONTENT_TYPE = 'video/mp2t';

/** One URI reference found in a playlist, handed to the {@link HlsUriRewriter}. */
export interface HlsUriRef {
  /** The reference exactly as it appears in the playlist (may carry a query string). */
  uri: string;
  /**
   * `'playlist'` for `.m3u8` references (variant streams in a master playlist, audio/subtitle
   * renditions via `#EXT-X-MEDIA`), `'media'` for everything else (segments, `#EXT-X-MAP` init
   * sections, keys). Classified by extension, ignoring any query/fragment.
   */
  kind: 'playlist' | 'media';
  /**
   * The tag whose `URI="…"` attribute holds this reference (`'EXT-X-MEDIA'`, `'EXT-X-MAP'`,
   * `'EXT-X-I-FRAME-STREAM-INF'`, …), or `undefined` for a plain URI line.
   */
  tag?: string;
}

/**
 * Maps one playlist reference to the URI that should replace it. Return the input unchanged to
 * keep a reference as-is. May be async — building the replacement routinely involves presigning.
 */
export type HlsUriRewriter = (ref: HlsUriRef) => string | Promise<string>;

/**
 * Rewrite every **relative** URI reference in an HLS playlist through `rewrite`, covering all the
 * places RFC 8216 puts one:
 *
 * - plain URI lines (segments in a media playlist, variant playlists in a master playlist),
 * - `URI="…"` attributes on tags (`#EXT-X-MEDIA` audio/subtitle renditions, `#EXT-X-MAP` init
 *   sections, `#EXT-X-I-FRAME-STREAM-INF`, `#EXT-X-KEY`, …).
 *
 * Untouched, by design:
 * - **absolute** references (`https://…`, protocol-relative `//…`, root-relative `/…`) — they no
 *   longer describe the storage layout, so rewriting them is not this function's business;
 * - comments and every other tag/line, byte for byte (line endings included).
 */
export async function rewriteHlsPlaylist(
  content: string,
  rewrite: HlsUriRewriter,
): Promise<string> {
  // Split keeping the separators, so CRLF/LF survive exactly as they came.
  const parts = content.split(/(\r?\n)/);
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    if (line === undefined || line === '') continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXT')) parts[i] = await rewriteTagUris(line, rewrite);
      continue; // plain comment: untouched
    }

    const uri = line.trim();
    if (uri === '' || !isRelativeUri(uri)) continue;
    const replacement = await rewrite({ uri, kind: classifyUri(uri) });
    // Preserve any surrounding whitespace on the line, replacing only the URI itself.
    parts[i] = line.replace(uri, replacement);
  }
  return parts.join('');
}

const TAG_URI_ATTRIBUTE = /URI="([^"]*)"/g;

/** Rewrite every relative `URI="…"` attribute on one tag line. */
async function rewriteTagUris(line: string, rewrite: HlsUriRewriter): Promise<string> {
  const colon = line.indexOf(':');
  const tag = (colon === -1 ? line.slice(1) : line.slice(1, colon)).trim();

  let output = '';
  let consumed = 0;
  for (const match of line.matchAll(TAG_URI_ATTRIBUTE)) {
    const uri = match[1] as string;
    output += line.slice(consumed, match.index);
    if (uri !== '' && isRelativeUri(uri)) {
      const replacement = await rewrite({ uri, kind: classifyUri(uri), tag });
      output += `URI="${replacement}"`;
    } else {
      output += match[0];
    }
    consumed = match.index + match[0].length;
  }
  return output + line.slice(consumed);
}

/**
 * Whether a playlist reference is relative to the playlist's own location — the only kind that
 * describes the storage layout and therefore the only kind {@link rewriteHlsPlaylist} rewrites.
 * Anything carrying a scheme (`https:`, `data:`), protocol-relative (`//cdn/…`) or root-relative
 * (`/api/…`) is already an address, not a layout detail.
 */
export function isRelativeUri(uri: string): boolean {
  if (uri.startsWith('/')) return false; // covers '//' too
  return !/^[a-z][a-z0-9+.-]*:/i.test(uri);
}

/** Classify a reference by extension (query/fragment ignored): `.m3u8` ⇒ playlist, else media. */
export function classifyUri(uri: string): 'playlist' | 'media' {
  const clean = uri.split(/[?#]/, 1)[0] as string;
  return clean.toLowerCase().endsWith('.m3u8') ? 'playlist' : 'media';
}

/**
 * Resolve a reference found in playlist `fromFile` (both package-relative) to the package-relative
 * path it points at, collapsing `.`/`..` segments. Returns `null` when the reference escapes the
 * package root — the caller treats that as "not one of ours" and leaves it alone.
 */
export function resolvePackagePath(fromFile: string, uri: string): string | null {
  const clean = uri.split(/[?#]/, 1)[0] as string;
  const slash = fromFile.lastIndexOf('/');
  const base = slash === -1 ? '' : fromFile.slice(0, slash + 1);
  const resolved: string[] = [];
  for (const segment of `${base}${clean}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (resolved.length === 0) return null;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.length === 0 ? null : resolved.join('/');
}

/** Content type for one artifact of an HLS package, by extension. */
export function hlsArtifactContentType(file: string): string | undefined {
  const lower = file.toLowerCase();
  if (lower.endsWith('.m3u8')) return HLS_PLAYLIST_CONTENT_TYPE;
  if (lower.endsWith('.ts')) return HLS_SEGMENT_CONTENT_TYPE;
  if (lower.endsWith('.m4s') || lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.vtt')) return 'text/vtt';
  return undefined;
}
