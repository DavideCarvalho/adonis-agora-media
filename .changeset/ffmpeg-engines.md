---
'@adonis-agora/media': minor
---

**ffmpeg engines for the HLS and probe transformers.** `engines.ffmpegHls()` and `engines.ffprobe()` plug into the existing `engine` option of `transformers.hls()` / `transformers.probe()` and spawn the system `ffmpeg` / `ffprobe` binaries. There is no npm dependency, and nothing is bundled.

- **Remux by default.** Without a ladder, `ffmpegHls()` does a stream copy, the same contract as the mediabunny engine.
- **`ladder` transcodes.** With `ladder: [{ height, videoBitrate, audioBitrate? }]` it encodes an h264/aac adaptive-bitrate ladder into one master playlist.
  - Keyframes are forced on segment boundaries.
  - Rungs taller than the source are dropped, so it never upscales.
  - Ready-made ladders: `engines.ladders.standard` (360/720/1080p) and `engines.ladders.compact` (360/720p).
  - This is the transcoding mediabunny can't do in Node without WebCodecs.
- **Same package shape.** The output is the shape the mediabunny engine writes (`index.m3u8` master, per-rendition playlists, MPEG-TS segments), so HLS delivery and playlist rewriting work unchanged.
- **Errors.** A missing binary throws `TransformerRuntimeMissingError`. A failed run throws the new `FfmpegFailedError` (`E_MEDIA_FFMPEG_FAILED`), carrying `exitCode` and the tail of `stderr`.
- **Also exported:** `ffmpegHlsEngine`, `ffprobeEngine`, `buildHlsArgs` and `effectiveLadder`, plus the `FfmpegRendition` / `FfmpegHlsEngineOptions` / `FfmpegBinaryOptions` types.
