import { describe, expect, it } from 'vitest';
import { buildDashManifest, parseMasterPlaylist, parseMediaPlaylist } from '../src/hls/to_dash.js';

describe('HLS → DASH', () => {
  it('reads a media playlist: init section and segment durations', () => {
    const playlist = parseMediaPlaylist(
      [
        '#EXTM3U',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MAP:URI="init-1.m4s"',
        '#EXTINF:3.999,',
        'segment-1-1.m4s',
        '#EXTINF:1.5,title',
        'segment-1-2.m4s',
        '#EXT-X-ENDLIST',
      ].join('\r\n'),
    );
    expect(playlist).toEqual({
      init: 'init-1.m4s',
      segments: [
        { uri: 'segment-1-1.m4s', duration: 3.999 },
        { uri: 'segment-1-2.m4s', duration: 1.5 },
      ],
    });
  });

  it('reads a master playlist: bandwidth, codecs and resolution per variant', () => {
    expect(
      parseMasterPlaylist(
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=46834,AVERAGE-BANDWIDTH=46000,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360\nplaylist-1.m3u8\n',
      ),
    ).toEqual([
      {
        uri: 'playlist-1.m3u8',
        bandwidth: 46834,
        codecs: 'avc1.64001e,mp4a.40.2',
        width: 640,
        height: 360,
      },
    ]);
  });

  it('builds a static MPD with one adaptation set per track type and a drift-free timeline', () => {
    const third = 1 / 3;
    const mpd = buildDashManifest({
      durationSeconds: 1,
      targetDuration: 4,
      representations: [
        {
          type: 'audio',
          base: 'audio/',
          codecs: 'mp4a.40.2',
          bandwidth: 64_000,
          playlist: {
            init: 'init-1.m4s',
            segments: [
              { uri: 'a1.m4s', duration: third },
              { uri: 'a2.m4s', duration: third },
              { uri: 'a3.m4s', duration: third },
            ],
          },
        },
        {
          type: 'video',
          base: 'video/',
          codecs: 'avc1.64001e',
          bandwidth: 800_000,
          width: 640,
          height: 360,
          playlist: { init: 'init-1.m4s', segments: [{ uri: 'v1.m4s', duration: 1 }] },
        },
      ],
    });
    expect(mpd).toContain('type="static" mediaPresentationDuration="PT1S" minBufferTime="PT4S"');
    // video first, whatever the input order
    expect(mpd.indexOf('contentType="video"')).toBeLessThan(mpd.indexOf('contentType="audio"'));
    expect(mpd).toContain(
      '<Representation id="video-0" codecs="avc1.64001e" bandwidth="800000" width="640" height="360">',
    );
    expect(mpd).toContain('<Initialization sourceURL="audio/init-1.m4s"/>');
    expect(mpd).toContain('<SegmentURL media="audio/a3.m4s"/>');
    // 333 + 334 + 333: the timeline ends exactly at 1000ms instead of drifting to 999
    expect(mpd).toContain('<S t="0" d="333"/>');
    expect(mpd).toContain('<S t="333" d="334"/>');
    expect(mpd).toContain('<S t="667" d="333"/>');
  });
});
