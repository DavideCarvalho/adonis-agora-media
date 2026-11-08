---
'@adonis-agora/media': minor
---

`engines.mediabunny({ ladder })` encodes an adaptive-bitrate ladder without spawning ffmpeg, through the optional peer `@mediabunny/server` (mediabunny's Node decoders/encoders over NodeAV; its native binary needs glibc). Every rung is encoded from one decode of the video, with a keyframe every `targetDuration` seconds, and the audio once to aac as the shared group; both manifests are written over the CMAF playlists. Without `ladder` it is the default remux engine. A missing `@mediabunny/server` throws `TransformerRuntimeMissingError`. The audio is muxed in its own pass because mediabunny 1.65.2's HLS muxer fails an assertion — as an unhandled rejection — when several video variants share an audio group in one output.

`VideoPackagingEngine` gains an optional `storyboard` flag: `transformers.video({ storyboard })` now refuses, at config time, any engine that does not declare it (`engines.ffmpeg()` does). The HLS master of the mediabunny engines lists every video rendition.
