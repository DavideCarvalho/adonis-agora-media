import { isRelativeUri, rewriteHlsPlaylist } from './hls/playlist.js';
import type { MediaRecord } from './media_record.js';

/**
 * Adaptive streaming (HLS and DASH) on the read side: which conversions of a record a player can
 * stream, and the per-request rewriting of their manifests.
 *
 * A streaming package is served under one URL "directory" per conversion —
 * `/media/<id>/stream/<conversion>/<file>` — so the references a manifest stores (relative to its
 * own location) resolve to that same route without any rewriting. The only thing ever added is a
 * signature (`?exp=&sig=`) when the app signs its delivery URLs, so segment requests carry the
 * authorization the manifest request was granted.
 */

/** A streaming format a player can be handed. */
export type StreamFormat = 'hls' | 'dash';

/** Content type of an HLS playlist (RFC 8216). */
export const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';

/** Content type of a DASH manifest (ISO/IEC 23009-1). */
export const DASH_MIME_TYPE = 'application/dash+xml';

/** One way to play a video — what `<source>` / a player gets. */
export interface MediaStreamSource {
  /** URL of the entry manifest (master playlist or MPD). */
  src: string;
  format: StreamFormat;
  /** {@link HLS_MIME_TYPE} or {@link DASH_MIME_TYPE}. */
  type: string;
  /** The conversion it comes from. */
  conversion: string;
}

/**
 * Everything a player needs, from `media.library.stream(id)` / `media.access.stream(ctx, id)`.
 * Serializable, so it travels as an Inertia/JSON prop to `useMediaStream` as is.
 */
export interface MediaStream {
  /** The preferred source's URL. */
  src: string;
  /** The preferred source's format. */
  format: StreamFormat;
  /** Every playable source, in order of preference (HLS first: iOS plays it natively). */
  sources: MediaStreamSource[];
  width?: number;
  height?: number;
  durationSeconds?: number;
}

/** One entry manifest of a record: a conversion and the package file a player starts from. */
export interface StreamEntry {
  conversion: string;
  format: StreamFormat;
  /** Package-relative file name of the manifest. */
  file: string;
}

/** Format of a manifest file, by extension; `undefined` for anything else. */
export function streamFormatOf(file: string): StreamFormat | undefined {
  const clean = (file.split(/[?#]/, 1)[0] as string).toLowerCase();
  if (clean.endsWith('.m3u8')) return 'hls';
  if (clean.endsWith('.mpd')) return 'dash';
  return undefined;
}

/**
 * The streaming entry points of a record, HLS before DASH. A conversion counts when its entry
 * artifact is a manifest; a CMAF package (`transformers.dash()`) also lists the HLS master it
 * carries (`meta.hlsEntry`), so one conversion yields both formats. `conversions` restricts — and
 * orders — which conversions are considered.
 */
export function streamEntries(record: MediaRecord, conversions?: readonly string[]): StreamEntry[] {
  const names = conversions ?? Object.keys(record.conversions);
  const entries: StreamEntry[] = [];
  for (const conversion of names) {
    const variant = record.conversions[conversion];
    if (!variant?.path || !variant.files) continue;
    const prefix = variant.prefix ?? variant.path.slice(0, variant.path.lastIndexOf('/') + 1);
    const entry = variant.path.slice(prefix.length);
    const format = streamFormatOf(entry);
    if (format) entries.push({ conversion, format, file: entry });
    const hlsEntry = variant.meta?.hlsEntry;
    if (typeof hlsEntry === 'string' && hlsEntry !== entry && variant.files.includes(hlsEntry)) {
      entries.push({ conversion, format: 'hls', file: hlsEntry });
    }
  }
  // Stable: HLS first, keeping the conversions' order within a format.
  return [
    ...entries.filter((e) => e.format === 'hls'),
    ...entries.filter((e) => e.format === 'dash'),
  ];
}

/** Content type for one file of a streaming package, by extension. */
export function streamArtifactContentType(file: string): string | undefined {
  const lower = file.toLowerCase();
  if (lower.endsWith('.m3u8')) return HLS_MIME_TYPE;
  if (lower.endsWith('.mpd')) return DASH_MIME_TYPE;
  if (lower.endsWith('.ts')) return 'video/mp2t';
  if (lower.endsWith('.m4s') || lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.aac')) return 'audio/aac';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.vtt')) return 'text/vtt';
  return undefined;
}

/** Append a query string (`exp=…&sig=…`, no `?`) to a URI that may already carry one. */
export function withQuery(uri: string, query: string): string {
  if (query === '') return uri;
  const hash = uri.indexOf('#');
  const base = hash === -1 ? uri : uri.slice(0, hash);
  const fragment = hash === -1 ? '' : uri.slice(hash);
  return `${base}${base.includes('?') ? '&' : '?'}${query}${fragment}`;
}

/** DASH attributes holding a URL or URL template. */
const DASH_URL_ATTRIBUTE = /\b(initialization|media|sourceURL|index)="([^"]*)"/g;
const DASH_BASE_URL = /<BaseURL([^>]*)>([^<]*)<\/BaseURL>/g;

/**
 * Rewrite every **relative** URL of a DASH manifest through `rewrite`: `SegmentTemplate`
 * `initialization`/`media` (templates such as `chunk-$Number%05d$.m4s` included — whatever is
 * appended stays outside the `$…$` identifiers), `SegmentURL`/`Initialization` `sourceURL` and
 * `media`, `index`, and `<BaseURL>` text. `rewrite` gets and returns raw URLs; XML escaping is
 * handled here. Absolute references and everything else stay byte for byte.
 */
export async function rewriteDashManifest(
  content: string,
  rewrite: (uri: string) => string | Promise<string>,
): Promise<string> {
  const apply = async (escaped: string): Promise<string> => {
    const uri = unescapeXml(escaped);
    if (uri === '' || !isRelativeUri(uri)) return escaped;
    return escapeXml(await rewrite(uri));
  };
  let output = await replaceAsync(content, DASH_URL_ATTRIBUTE, async (match) => {
    const [, name, value] = match as unknown as [string, string, string];
    return `${name}="${await apply(value)}"`;
  });
  output = await replaceAsync(output, DASH_BASE_URL, async (match) => {
    const [, attributes, value] = match as unknown as [string, string, string];
    return `<BaseURL${attributes}>${await apply(value.trim())}</BaseURL>`;
  });
  return output;
}

/**
 * Add `query` to every relative reference of a manifest (`.m3u8` or `.mpd`) — how a signature
 * travels from the manifest request to the segment requests it leads to.
 */
export async function signManifest(file: string, content: string, query: string): Promise<string> {
  if (query === '') return content;
  const format = streamFormatOf(file);
  if (format === 'hls') return rewriteHlsPlaylist(content, (ref) => withQuery(ref.uri, query));
  if (format === 'dash') return rewriteDashManifest(content, (uri) => withQuery(uri, query));
  return content;
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (match: RegExpMatchArray) => Promise<string>,
): Promise<string> {
  let output = '';
  let consumed = 0;
  for (const match of input.matchAll(pattern)) {
    output += input.slice(consumed, match.index) + (await replacer(match));
    consumed = (match.index ?? 0) + match[0].length;
  }
  return output + input.slice(consumed);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function unescapeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
