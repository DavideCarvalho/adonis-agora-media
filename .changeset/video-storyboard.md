---
'@adonis-agora/media': minor
---

`transformers.video({ storyboard })` writes timeline thumbnails — the preview a player shows over the progress bar while scrubbing — next to the streaming package: JPEG sprite sheets (`storyboard-001.jpg`…, a frame every `interval` seconds, `width` px wide, `columns` × `rows` per sheet; defaults 5 s, 160 px, 10 × 10) and a WebVTT (`storyboard.vtt`, `VIDEO_STORYBOARD`) mapping each interval to its tile with `#xywh=`. The stream route serves the sheets as `image/jpeg`, and the conversion `meta.storyboard` names the WebVTT. `engines.ffmpeg()` runs the storyboard decode alongside the encode, from the same local source; the default mediabunny engine cannot decode frames in Node, so `storyboard` without an engine is refused at config time. Also exported: `buildStoryboardArgs`, `buildStoryboardVtt`, `storyboardTileHeight`, `VIDEO_STORYBOARD_DEFAULTS`.
