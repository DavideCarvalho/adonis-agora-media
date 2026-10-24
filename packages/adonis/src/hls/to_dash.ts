/**
 * Describe CMAF HLS media playlists as a DASH manifest — how a package muxed by an engine that
 * only writes HLS (mediabunny) also plays over DASH. The segments are the same files; only the
 * description changes, so this is text in, text out.
 */

/** One media segment of a playlist. */
export interface PlaylistSegment {
  uri: string;
  /** Seconds (`#EXTINF`). */
  duration: number;
}

/** What a media playlist says about its segments. */
export interface ParsedMediaPlaylist {
  /** `#EXT-X-MAP` init section, when the segments are fragmented MP4. */
  init?: string;
  segments: PlaylistSegment[];
}

/** One `#EXT-X-STREAM-INF` of a master playlist. */
export interface ParsedVariant {
  uri: string;
  bandwidth?: number;
  codecs?: string;
  width?: number;
  height?: number;
}

/** Read the segments (and init section) of an HLS media playlist. */
export function parseMediaPlaylist(content: string): ParsedMediaPlaylist {
  const result: ParsedMediaPlaylist = { segments: [] };
  let duration: number | undefined;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const uri = attribute(line, 'URI');
      if (uri) result.init = uri;
    } else if (line.startsWith('#EXTINF:')) {
      const parsed = Number.parseFloat(line.slice('#EXTINF:'.length));
      // An unreadable duration is no duration: its segment is skipped, never timed as NaN.
      duration = Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
    } else if (!line.startsWith('#') && duration !== undefined) {
      result.segments.push({ uri: line, duration });
      duration = undefined;
    }
  }
  return result;
}

/** Read the variants of an HLS master playlist. */
export function parseMasterPlaylist(content: string): ParsedVariant[] {
  const variants: ParsedVariant[] = [];
  let pending: Omit<ParsedVariant, 'uri'> | undefined;
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const bandwidth = Number(attribute(line, 'BANDWIDTH'));
      const codecs = attribute(line, 'CODECS');
      const [width, height] = (attribute(line, 'RESOLUTION') ?? '').split('x').map(Number);
      pending = {
        ...(Number.isFinite(bandwidth) && bandwidth > 0 ? { bandwidth } : {}),
        ...(codecs ? { codecs } : {}),
        ...(width && height ? { width, height } : {}),
      };
    } else if (!line.startsWith('#') && pending) {
      variants.push({ uri: line, ...pending });
      pending = undefined;
    }
  }
  return variants;
}

/** One track of the DASH manifest: a media playlist, re-described. */
export interface DashRepresentationInput {
  type: 'video' | 'audio';
  /** Package-relative path prefix of the playlist's files (`'video/'`), prepended to its URIs. */
  base: string;
  playlist: ParsedMediaPlaylist;
  codecs?: string | undefined;
  bandwidth?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

/**
 * Build a static DASH manifest (`SegmentList` + `SegmentTimeline`, one adaptation set per track
 * type) over the segments of CMAF media playlists. Durations go through a millisecond timeline
 * computed from the running total, so rounding never drifts across a long video.
 */
export function buildDashManifest(input: {
  durationSeconds: number;
  targetDuration: number;
  representations: readonly DashRepresentationInput[];
}): string {
  const sets = (['video', 'audio'] as const)
    .map((type, setIndex) => {
      const representations = input.representations.filter((r) => r.type === type);
      if (representations.length === 0) return '';
      const items = representations.map((r, index) => representation(r, `${type}-${index}`));
      return [
        `    <AdaptationSet id="${setIndex}" contentType="${type}" mimeType="${type}/mp4" segmentAlignment="true" startWithSAP="1">`,
        ...items,
        '    </AdaptationSet>',
      ].join('\n');
    })
    .filter(Boolean);

  return `${[
    '<?xml version="1.0" encoding="utf-8"?>',
    '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:full:2011" type="static"' +
      ` mediaPresentationDuration="${isoDuration(input.durationSeconds)}"` +
      ` minBufferTime="${isoDuration(input.targetDuration)}">`,
    '  <Period id="0" start="PT0S">',
    ...sets,
    '  </Period>',
    '</MPD>',
  ].join('\n')}\n`;
}

function representation(r: DashRepresentationInput, id: string): string {
  const attributes = [
    `id="${id}"`,
    r.codecs ? `codecs="${xml(r.codecs)}"` : '',
    `bandwidth="${Math.max(1, Math.round(r.bandwidth ?? 1))}"`,
    r.width ? `width="${r.width}"` : '',
    r.height ? `height="${r.height}"` : '',
  ].filter(Boolean);

  const timeline: string[] = [];
  let elapsed = 0;
  for (const segment of r.playlist.segments) {
    const start = Math.round(elapsed * 1000);
    elapsed += segment.duration;
    timeline.push(`            <S t="${start}" d="${Math.round(elapsed * 1000) - start}"/>`);
  }

  return [
    `      <Representation ${attributes.join(' ')}>`,
    '        <SegmentList timescale="1000">',
    ...(r.playlist.init
      ? [`          <Initialization sourceURL="${xml(r.base + r.playlist.init)}"/>`]
      : []),
    '          <SegmentTimeline>',
    ...timeline,
    '          </SegmentTimeline>',
    ...r.playlist.segments.map((s) => `          <SegmentURL media="${xml(r.base + s.uri)}"/>`),
    '        </SegmentList>',
    '      </Representation>',
  ].join('\n');
}

/** `PT12.345S` — the xs:duration DASH wants. */
function isoDuration(seconds: number): string {
  return `PT${Number(Math.max(0, seconds).toFixed(3))}S`;
}

function attribute(line: string, name: string): string | undefined {
  const match = new RegExp(`(?:[:,])${name}=(?:"([^"]*)"|([^,]*))`).exec(line);
  return match ? (match[1] ?? match[2]) : undefined;
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
