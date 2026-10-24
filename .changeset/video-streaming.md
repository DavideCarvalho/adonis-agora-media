---
'@adonis-agora/media': minor
'@adonis-agora/media-react': minor
---

Video streaming, HLS and DASH:

- `transformers.dash()` packages CMAF with the system ffmpeg: a DASH manifest and an HLS master playlist over the same fragmented-MP4 segments (`hls: false` for DASH only). `engines.ffmpegDash({ ladder })` encodes an ABR ladder.
- `media.access.streamRoute()` serves HLS/DASH packages at `/media/:id/stream/:conversion/*`. It authorizes every request with the collection's `access.read`, checks the file against the package, and redirects or streams segments per `delivery.mode`. `serveStream()` is the same for your own controller.
- `media.library.stream(id)` / `media.access.stream(ctx, id)` return the manifest URLs for a player, HLS first. With `delivery.signing` they are signed for the whole package, the route carries the signature onto every manifest reference, and it never expires before the video plus an hour.
- `delivery.streamPath` sets where those URLs point.
- `useMediaStream(ref, stream, { hls, dash })` in `@adonis-agora/media-react` plays HLS/DASH in your own `<video>`, headless. hls.js and dash.js are loaded on demand, iOS falls back to native HLS, and the hook exposes quality levels, `setLevel`, errors and the player instance.
