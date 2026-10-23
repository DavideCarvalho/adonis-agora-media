---
'@adonis-agora/media': minor
'@adonis-agora/media-react': minor
---

`next/image` for stored images. `<MediaImage>` in `@adonis-agora/media-react` renders one `<img>`. It loads lazily by default, `priority` marks the LCP image, and `fill` sizes it to the parent box. A blurred preview is painted behind it until it loads; this works with SSR, survives hydration, and stays in place if the image fails. Three ways to feed it:

- `image={await media.library.image(id)}`: the server builds `src`, a `srcSet` from the collection's presets, the intrinsic size and the placeholder, as plain JSON. Only presets that are the same picture at another size are offered: `blur` presets and width×height presets that crop or pad to another aspect ratio are left out.
- `src="/a.jpg"`: a plain URL, with your own `srcSet`, `blurDataURL` and `placeholderColor`.
- `src={mediaId} loader={mediaImageLoader()}`: the component builds the `srcSet` with `next/image`'s algorithm and widths. The server resizes each width on demand: `MediaDeliveryHandler.handle({ width, quality })` (the route's `?w=`/`?q=`) resizes once and caches the result as a conversion, never enlarges, and only serves the widths and qualities whitelisted in `delivery.images` (by default the same values as `next/image`). It throws `ImageSizeNotAllowedError` / `NotAnImageError` otherwise.

`placeholderStyle()` paints the preview on components that own their `<img>`. Generated image conversions now record their output size in `conversions[name].meta`. Conversion presets accept `withoutEnlargement`.
