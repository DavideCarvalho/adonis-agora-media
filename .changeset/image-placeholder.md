---
'@adonis-agora/media': minor
---

**Image placeholders and blur.**

- New `transformers.placeholder()` — a metadata-only transformer that persists, on `record.conversions.placeholder.meta`, a tiny WebP preview as a `data:` URL, the original's dimensions (after EXIF orientation) and its dominant colour. Enough to render a blur-up placeholder with the right aspect ratio in the same response as the image URL, with no extra request or client decoder. Eager by default; skips non-`image/*` and SVG records with `meta: {}`. Needs the `sharp` peer (loaded lazily). Exported as `PlaceholderTransformer` with its `ImagePlaceholder` / `PlaceholderEngine` types.
- `placeholderOf(record)` reads that placeholder off any `MediaRecord` (whatever the transformer's name), and `storeSingleFile` / `storeSingleFileWith` now also return the record `id` and its `placeholder` (or `null`).
- `ConversionPreset.blur` — gaussian blur sigma applied after the resize, for blurred variants served as files.
- **Fix:** the sharp processor now auto-orients from EXIF before resizing. Phone photos taken in portrait used to come out sideways in every conversion, because the output drops the EXIF orientation tag that made the original display upright. Existing conversions are not regenerated.
