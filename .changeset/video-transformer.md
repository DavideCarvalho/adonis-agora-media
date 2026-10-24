---
'@adonis-agora/media': minor
---

**Breaking (beta):** one video transformer replaces `transformers.hls()` and `transformers.dash()`.

- `transformers.video({ formats, segments, engine })`, with default conversion name `'video'`.
  - **Default:** CMAF segments described by both an HLS master (`index.m3u8`) and a DASH manifest (`manifest.mpd`). The video is stored once and plays everywhere.
  - **`segments: 'ts'`:** HLS over MPEG-TS, for players older than fMP4 HLS. Asking for DASH over TS throws at boot.
  - **`formats: ['hls']` or `['dash']`:** writes only that manifest.
- **Pure JS by default.** mediabunny writes the CMAF package in two passes (video and audio in their own playlists, because dash.js does not play muxed segments), and the library builds the MPD from those playlists. No ffmpeg is needed on the host for either format.
- **`engines.ffmpeg({ ladder })` replaces `engines.ffmpegHls` and `engines.ffmpegDash`.** CMAF goes through ffmpeg's DASH muxer, TS through its HLS muxer.
- **Persisted meta:** `meta.hlsEntry`, `meta.dashManifest` and `meta.segments` record what was written, and `media.library.stream()` reads them.
- **`HlsDeliveryHandler`** now defaults to the `'video'` conversion.
- **New exports:** `buildDashManifest`, `parseMasterPlaylist` and `parseMediaPlaylist`, for packages from other HLS-only muxers.

Migration:
- `transformers.hls()` becomes `transformers.video()`, or `transformers.video({ segments: 'ts', formats: ['hls'] })` to keep TS segments.
- `transformers.dash()` becomes `transformers.video()`.
- `engines.ffmpegHls(o)` and `engines.ffmpegDash(o)` become `engines.ffmpeg(o)`.
- `transform(id, 'hls')` and `transform(id, 'dash')` become `transform(id, 'video')`, unless you keep the old name with `name: 'hls'`.
