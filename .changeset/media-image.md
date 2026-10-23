---
'@adonis-agora/media': minor
'@adonis-agora/media-react': minor
---

`next/image` for stored images. `media.library.image(id)` builds what an `<img>` needs as plain JSON: `src`, a `srcSet` from the collection's presets, the intrinsic `width`/`height` and the blur-up placeholder. `<MediaImage>` in `@adonis-agora/media-react` renders it as one `<img>`: lazy by default, `priority` for the LCP image, `fill` for layout-sized boxes, and the blurred preview painted behind it until it loads (SSR-safe, survives hydration, kept on error). `placeholderStyle()` paints the same preview on other components.

Only same-picture presets become `srcset` candidates: `blur` presets, and `width`×`height` presets that crop or pad to another aspect ratio, are left out. Generated image conversions now record their output size in `conversions[name].meta` (`{ width, height }`). For conversions generated earlier, the width is derived from the preset.
