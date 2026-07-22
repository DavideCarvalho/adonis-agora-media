---
'@adonis-agora/media': minor
---

Magic-byte signatures for the common video containers — and with them, video collections finally get a real whitelist

The signature table covered PNG/JPEG/GIF/WEBP/PDF and **no video format**. That had two concrete consequences for any collection gating video:

- No video was ever *detectable*, so a whitelist like `['video/mp4']` could never be **closed** (see 0.8.0): the closed-whitelist rejection for unrecognisable content simply never activated, and anything without a known signature — a `.txt`, an executable, random bytes — sailed through `attach`/`attachExisting`/TUS as long as the caller declared `video/mp4`.
- `attachExisting` could not catch content disguised as a video: a PNG uploaded as `clip.mp4` produced no `ContentTypeMismatchError`, because the detector had no idea what an MP4 looks like.

The table now recognises:

- **`video/mp4`** — ISO-BMFF `ftyp` box (bytes 4–7; the first 4 bytes are the box *size* and vary per file, so they are skipped — the existing `[offset, hex]` parts mechanism already expresses this) with a major brand from the recognised set: `isom`, `iso2`–`iso6`, `mp41`, `mp42`, `avc1`, `av01`, `dash`. One table entry per brand, the GIF87a/GIF89a pattern.
- **`video/quicktime`** — the same `ftyp` box with major brand `qt  `. Same container, different type: a `.mov` relabeled `video/mp4` is now a positive **mismatch**, not a pass.
- **`video/webm`** / **`video/x-matroska`** — EBML magic `1A45DFA3` at offset 0, discriminated by the `DocType` element (`webm` vs `matroska`). DocType sits inside a variable-length EBML header, so its offset depends on the muxer — the one thing fixed offsets cannot express. The signature mechanism gained a minimal `scan` field: a byte run (element id + size + doc type string, so it cannot fire on stray text) that must appear *anywhere* in the head, checked only **after** the fixed parts already identified the container. No EBML parser, no new dependency.
- **`video/x-msvideo`** — `RIFF` + `AVI ` form type (bytes 4–7 are the chunk size and skipped, exactly like WEBP).
- **`video/mp2t`** — MPEG transport stream. There is no magic number, only the `0x47` sync byte opening every 188-byte packet; one byte would collide with anything starting with `G`, so the sync byte is required at the start of the first **two** packets (offsets 0 and 188). It is the weakest signature and sits last in the table, so it can never shadow a stronger match.

`SIGNATURE_HEAD_BYTES` grows from 16 to **189** (the second TS sync byte). All the sniffing paths already read exactly this constant and handle short payloads: `attach` still peeks and replays the head without buffering the payload, `attachExisting` still tears the disk stream down after one short read, and a head shorter than a signature's deepest offset degrades to *unrecognised*, never to a false positive.

Deliberate non-guesses, so a legitimate file never turns into a false mismatch: an `ftyp` brand outside the set above (3GPP's `3gp*`, Apple's `M4A `/`M4V `) and an EBML DocType that is neither `webm` nor `matroska` stay **unrecognised** — under an open whitelist they fall back to the declared type exactly as before.

**Behaviour change to review if you gate video:** a whitelist made up entirely of the types above — `['video/mp4']` being the canonical case — was open and is now **closed**. Three things follow:

1. Content whose signature contradicts the declared type is rejected with `ContentTypeMismatchError` (`E_MEDIA_CONTENT_TYPE_MISMATCH`) — the PNG-disguised-as-MP4 case, previously accepted.
2. Content matching *no* signature is rejected with `ContentSignatureUnrecognizedError` (`E_MEDIA_CONTENT_SIGNATURE_UNRECOGNIZED`), per the 0.8.0 closed-whitelist rule that never activated for video before.
3. Legitimate videos whose real container differs from the declared type — `.mov`/`.mkv`/`.avi` files uploaded under a blanket `video/mp4` — now fail instead of slipping through. If your collection genuinely accepts them, list what you accept: `acceptsMimeTypes: ['video/mp4', 'video/quicktime', 'video/webm']`.

Applies uniformly to `attach`, `attachExisting` and the TUS first-chunk check, which all share `verifyContentAgainstWhitelist`.
