import { describe, expect, it } from 'vitest';
import {
  classifyUri,
  isRelativeUri,
  resolvePackagePath,
  rewriteHlsPlaylist,
} from '../src/hls/playlist.js';
import type { HlsUriRef } from '../src/hls/playlist.js';

/** Rewriter that records every ref it saw and tags the output so replacements are visible. */
function recordingRewriter() {
  const refs: HlsUriRef[] = [];
  const rewrite = (ref: HlsUriRef) => {
    refs.push(ref);
    return `rewritten:${ref.kind}:${ref.uri}`;
  };
  return { refs, rewrite };
}

describe('rewriteHlsPlaylist: URI lines', () => {
  it('rewrites relative segment and playlist lines, leaving tags and comments untouched', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '# a hand-written comment with a.ts inside',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
      'playlist-1.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=1280x720',
      'video/720/playlist.m3u8',
      '',
    ].join('\n');

    const { refs, rewrite } = recordingRewriter();
    const result = await rewriteHlsPlaylist(master, rewrite);

    expect(result).toContain('rewritten:playlist:playlist-1.m3u8');
    expect(result).toContain('rewritten:playlist:video/720/playlist.m3u8');
    // tags and comments byte-identical
    expect(result).toContain('#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360');
    expect(result).toContain('# a hand-written comment with a.ts inside');
    expect(refs).toEqual([
      { uri: 'playlist-1.m3u8', kind: 'playlist' },
      { uri: 'video/720/playlist.m3u8', kind: 'playlist' },
    ]);
  });

  it('rewrites media playlist segment lines and classifies them as media', async () => {
    const media = [
      '#EXTM3U',
      '#EXTINF:4.000,',
      'segment-1-0.ts',
      '#EXTINF:1.417,',
      'segment-1-1.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const { refs, rewrite } = recordingRewriter();
    const result = await rewriteHlsPlaylist(media, rewrite);

    expect(result).toContain('rewritten:media:segment-1-0.ts');
    expect(result).toContain('rewritten:media:segment-1-1.ts');
    expect(result).toContain('#EXTINF:4.000,');
    expect(refs.map((r) => r.kind)).toEqual(['media', 'media']);
  });

  it('leaves absolute, protocol-relative and root-relative references untouched', async () => {
    const playlist = [
      '#EXTM3U',
      'https://cdn.example.com/abs.ts',
      '//cdn.example.com/proto.ts',
      '/api/v1/already/routed.ts',
      'relative.ts',
    ].join('\n');
    const { refs, rewrite } = recordingRewriter();
    const result = await rewriteHlsPlaylist(playlist, rewrite);

    expect(result).toContain('https://cdn.example.com/abs.ts');
    expect(result).toContain('//cdn.example.com/proto.ts');
    expect(result).toContain('/api/v1/already/routed.ts');
    expect(result).toContain('rewritten:media:relative.ts');
    expect(refs).toHaveLength(1);
  });

  it('keeps a query string on the reference visible to the rewriter and classifies by the path only', async () => {
    const playlist = ['#EXTM3U', 'seg.ts?token=abc', 'low.m3u8?v=2'].join('\n');
    const { refs, rewrite } = recordingRewriter();
    await rewriteHlsPlaylist(playlist, rewrite);
    expect(refs).toEqual([
      { uri: 'seg.ts?token=abc', kind: 'media' },
      { uri: 'low.m3u8?v=2', kind: 'playlist' },
    ]);
  });

  it('preserves CRLF line endings and trailing newlines byte for byte', async () => {
    const playlist = '#EXTM3U\r\nseg.ts\r\n\r\n';
    const result = await rewriteHlsPlaylist(playlist, () => 'X');
    expect(result).toBe('#EXTM3U\r\nX\r\n\r\n');
  });

  it('supports an async rewriter', async () => {
    const playlist = 'seg.ts';
    const result = await rewriteHlsPlaylist(playlist, async (ref) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return `async:${ref.uri}`;
    });
    expect(result).toBe('async:seg.ts');
  });
});

describe('rewriteHlsPlaylist: URI="…" attributes', () => {
  it('rewrites audio rendition URIs on #EXT-X-MEDIA with the tag name attached', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,URI="audio-en.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aac"',
      'video.m3u8',
    ].join('\n');
    const { refs, rewrite } = recordingRewriter();
    const result = await rewriteHlsPlaylist(master, rewrite);

    expect(result).toContain('URI="rewritten:playlist:audio-en.m3u8"');
    // the rest of the attribute list is untouched
    expect(result).toContain('TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,');
    expect(refs[0]).toEqual({ uri: 'audio-en.m3u8', kind: 'playlist', tag: 'EXT-X-MEDIA' });
  });

  it('rewrites #EXT-X-MAP init-section URIs as media', async () => {
    const media = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:4,', 'seg-0.m4s'].join('\n');
    const { refs, rewrite } = recordingRewriter();
    const result = await rewriteHlsPlaylist(media, rewrite);

    expect(result).toContain('#EXT-X-MAP:URI="rewritten:media:init.mp4"');
    expect(refs[0]).toEqual({ uri: 'init.mp4', kind: 'media', tag: 'EXT-X-MAP' });
  });

  it('rewrites #EXT-X-I-FRAME-STREAM-INF playlist URIs', async () => {
    const master = '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframes.m3u8"';
    const { refs, rewrite } = recordingRewriter();
    const result = await rewriteHlsPlaylist(master, rewrite);
    expect(result).toBe(
      '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="rewritten:playlist:iframes.m3u8"',
    );
    expect(refs[0]?.tag).toBe('EXT-X-I-FRAME-STREAM-INF');
  });

  it('leaves absolute URI attributes untouched (a license-server EXT-X-KEY, a CDN rendition)', async () => {
    const media = [
      '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example.com/key?id=1"',
      '#EXT-X-MEDIA:TYPE=AUDIO,URI="//cdn.example.com/audio.m3u8"',
    ].join('\n');
    const { refs, rewrite } = recordingRewriter();
    const result = await rewriteHlsPlaylist(media, rewrite);
    expect(result).toBe(media);
    expect(refs).toHaveLength(0);
  });

  it('handles multiple URI attributes across one line and empty URIs', async () => {
    const line = '#EXT-X-CUSTOM:URI="a.ts",OTHER=1,URI="",MORE=2,URI="b.m3u8"';
    const { refs, rewrite } = recordingRewriter();
    const result = await rewriteHlsPlaylist(line, rewrite);
    expect(result).toBe(
      '#EXT-X-CUSTOM:URI="rewritten:media:a.ts",OTHER=1,URI="",MORE=2,URI="rewritten:playlist:b.m3u8"',
    );
    expect(refs).toHaveLength(2);
  });
});

describe('classifyUri / isRelativeUri / resolvePackagePath', () => {
  it('classifies by extension ignoring query and fragment', () => {
    expect(classifyUri('a.m3u8')).toBe('playlist');
    expect(classifyUri('A.M3U8?x=1')).toBe('playlist');
    expect(classifyUri('a.ts')).toBe('media');
    expect(classifyUri('init.mp4#frag')).toBe('media');
  });

  it('detects relativeness', () => {
    expect(isRelativeUri('seg.ts')).toBe(true);
    expect(isRelativeUri('dir/seg.ts')).toBe(true);
    expect(isRelativeUri('/rooted.ts')).toBe(false);
    expect(isRelativeUri('//host/x.ts')).toBe(false);
    expect(isRelativeUri('https://x/y.ts')).toBe(false);
    expect(isRelativeUri('data:text/plain,hi')).toBe(false);
  });

  it('resolves references relative to the referencing playlist', () => {
    expect(resolvePackagePath('index.m3u8', 'playlist-1.m3u8')).toBe('playlist-1.m3u8');
    expect(resolvePackagePath('video/720/playlist.m3u8', 'seg-1.ts')).toBe('video/720/seg-1.ts');
    expect(resolvePackagePath('video/720/playlist.m3u8', '../480/seg.ts')).toBe('video/480/seg.ts');
    expect(resolvePackagePath('a/b.m3u8', './c.ts')).toBe('a/c.ts');
    expect(resolvePackagePath('index.m3u8', 'seg.ts?token=1')).toBe('seg.ts');
  });

  it('returns null when a reference escapes the package', () => {
    expect(resolvePackagePath('index.m3u8', '../outside.ts')).toBeNull();
    expect(resolvePackagePath('a/b.m3u8', '../../../etc/passwd')).toBeNull();
  });
});
