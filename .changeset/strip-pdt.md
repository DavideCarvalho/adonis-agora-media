---
'@adonis-agora/media': patch
---

`engines.ffmpeg()` removes `#EXT-X-PROGRAM-DATE-TIME` from the HLS playlists of a CMAF package. ffmpeg's DASH muxer writes the wall-clock time of the transcode there. That means nothing for a VOD, and a player that maps the timeline to it reports a duration of decades and seeks wrong.
