---
'@adonis-agora/media': minor
'@adonis-agora/media-react': minor
---

`next/image` for stored images, and the features of other image libraries (Nuxt Image/IPX, Astro, Unpic, spatie, imgproxy) that were worth having.

**Rendering (`@adonis-agora/media-react`)**
- `<MediaImage>` renders one `<img>`. It loads lazily by default, `priority` marks the LCP image (React 19 also preloads it), and `fill` sizes it to the parent box. A blurred preview is painted behind it until it loads; this works with SSR, survives hydration, and stays in place if the image fails. Three ways to feed it:
  - `image={await media.library.image(id)}`: a descriptor built on the server.
  - `src="/a.jpg"`: a plain URL, with your own `srcSet`, `blurDataURL` and `placeholderColor`.
  - `src={mediaId} loader={mediaImageLoader()}`: a loader, with `next/image`'s algorithm and widths.
- `layout` (`constrained` / `fullWidth` / `fixed`) derives the box style and `sizes`. A lazy image gets `sizes="auto, …"`.
- `focalPoint` becomes `object-position`.
- `<MediaPicture>` does art direction with `<source>`s, each with its own size.
- `placeholderStyle()` paints the preview on other components.

**Server (`@adonis-agora/media`)**
- `media.library.image(id)` returns `src`, a `srcSet` of same-picture presets, the intrinsic size, the placeholder and the focal point. An explicit `conversions` list forms its own art-directed group, and `onDemand` switches to resize URLs.
- On-demand resize through `MediaDeliveryHandler` (`?w=`/`?q=`): each size is resized once and cached as a conversion, never enlarged, and limited to the `delivery.images` whitelist. The format (AVIF/WebP) is negotiated from `Accept`, and the result carries `vary: 'Accept'`.
- Signed delivery URLs (`delivery.signing`, `media.library.deliveryUrl()`): an HMAC over the record, the conversion, the size and the expiry. Expiries are rounded so URLs stay cacheable. Unsigned requests are refused by default. With signing configured, `image()` only hands out signed route URLs.
- Focal points (`media.library.setFocalPoint()`) and preset `position` (`'attention'`/`'entropy'`) for content-aware crops.
- `responsive: true` collections: presets at standard widths (skipping those wider than the original) and the placeholder, from one flag.
- `stripMetadata: true` collections: the original is rewritten without EXIF/GPS/XMP/IPTC, with the orientation baked in and the colour profile kept.
- Generated image conversions record their output size in `meta`. Presets gain `withoutEnlargement`, `onlyDownscale` and `position`. `ImageProcessor` gains optional `dimensions()`/`stripMetadata()` and a `focalPoint` convert option.
- Fixes: animated GIF/WebP keep their frames when converted to WebP. Concurrent conversions of one record no longer drop each other.
- New errors: `ImageSizeNotAllowedError`, `NotAnImageError`, `DeliverySignatureError`.
