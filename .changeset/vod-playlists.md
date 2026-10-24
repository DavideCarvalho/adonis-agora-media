---
'@adonis-agora/media': patch
---

`engines.ffmpeg()` also removes `#EXT-X-MEDIA-SEQUENCE` from the HLS playlists of a CMAF package. ffmpeg numbers them from 1, like the MPD's `startNumber`, and a player that reads the sequence as elapsed segments (mediabunny) started the video one segment late, reporting a 10s video as 14s. Without the tag, the sequence is 0 for every player.
