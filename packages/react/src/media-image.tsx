import {
  type CSSProperties,
  forwardRef,
  type ImgHTMLAttributes,
  version as reactVersion,
  useCallback,
  useState,
} from 'react';

/**
 * What `media.library.image(id)` returns on the server (`ResponsiveImage` in
 * `@adonis-agora/media`) — restated here so the browser bundle does not depend on the server
 * package. Plain JSON: it arrives as a page prop.
 */
export interface MediaImageData {
  /** Fallback `src` — the widest candidate. */
  src: string;
  /** `"<url> 320w, <url> 960w"` built from the collection's presets. */
  srcSet?: string;
  /** Intrinsic width (EXIF orientation applied). */
  width?: number;
  /** Intrinsic height. */
  height?: number;
  /** Blur-up preview: a tiny WebP `data:` URL and the dominant colour. */
  placeholder?: { dataUrl: string; color: string };
  /** The record's focal point (fractions, top-left origin): becomes `object-position`. */
  focalPoint?: { x: number; y: number };
}

/** The blur-up preview alone — the `placeholder` of {@link MediaImageData}. */
export type MediaImagePlaceholder = NonNullable<MediaImageData['placeholder']>;

/**
 * `next/image`'s loader contract: the URL of `src` at `width` px (and `quality`). With one,
 * {@link MediaImage} builds the `srcSet` itself. See {@link mediaImageLoader} for the server's
 * on-demand resize route.
 */
export type MediaImageLoader = (params: {
  src: string;
  width: number;
  quality?: number | undefined;
}) => string;

/** `next/image`'s default `deviceSizes`: the widths a full-width image is offered at. */
export const DEFAULT_DEVICE_SIZES: readonly number[] = [
  640, 750, 828, 1080, 1200, 1920, 2048, 3840,
];
/** `next/image`'s default `imageSizes`: extra widths for images narrower than the screen. */
export const DEFAULT_IMAGE_SIZES: readonly number[] = [16, 32, 48, 64, 96, 128, 256, 384];

interface MediaImageCommonProps
  extends Omit<
    ImgHTMLAttributes<HTMLImageElement>,
    'src' | 'srcSet' | 'width' | 'height' | 'placeholder' | 'alt'
  > {
  /** Required, like `next/image`: describe the picture, or `""` when it is decorative. */
  alt: string;
  /**
   * How wide the image renders, so the browser picks from `srcSet` — e.g.
   * `"(max-width: 768px) 100vw, 50vw"`. Without it the browser assumes the full viewport width.
   */
  sizes?: string;
  /**
   * The image is above the fold (the LCP element): load it eagerly with high fetch priority
   * instead of lazily.
   */
  priority?: boolean;
  /**
   * Fill the parent (which must be positioned) instead of sizing from `width`/`height` — for
   * boxes whose size the layout decides (a banner area, a card cover). Set `objectFit` in `style`.
   */
  fill?: boolean;
  /**
   * What shows until the image loads: `'blur'` (the preview, default when there is one),
   * `'color'` (the flat colour only) or `'empty'`.
   */
  placeholder?: 'blur' | 'color' | 'empty';
  /**
   * How the image sizes itself, Unpic/Gatsby-style — and, from that, the `sizes` the browser needs,
   * so you do not write one by hand:
   * - `'constrained'`: up to its `width`, shrinking on narrower screens
   *   (`sizes="(min-width: Wpx) Wpx, 100vw"`);
   * - `'fullWidth'`: always the full width (`sizes="100vw"`);
   * - `'fixed'`: exactly `width`×`height` (`sizes="Wpx"`; 1x/2x with a loader).
   * An explicit `sizes` wins. Without either, a lazy image gets `sizes="auto, 100vw"`: browsers
   * that support `auto` pick from the size it is actually laid out at.
   */
  layout?: 'constrained' | 'fullWidth' | 'fixed';
  /** Intrinsic width (attribute). With `image`, overrides `image.width`. */
  width?: number;
  /** Intrinsic height (attribute). With `image`, overrides `image.height`. */
  height?: number;
}

/** Render the descriptor `media.library.image(id)` built on the server. */
export interface MediaImageFromDataProps extends MediaImageCommonProps {
  /** The descriptor from `media.library.image(id)`. */
  image: MediaImageData;
  src?: never;
  loader?: never;
}

/** Render a URL — or, with a `loader`, whatever the loader understands (a media id). */
export interface MediaImageFromSrcProps extends MediaImageCommonProps {
  image?: never;
  /** A URL, like `<img src>`. With a `loader`, the value the loader turns into URLs. */
  src: string;
  /** Your own `srcset`. Ignored with a `loader`, which builds it. */
  srcSet?: string;
  /** Build each candidate's URL — `next/image`'s `loader`. */
  loader?: MediaImageLoader;
  /** Quality handed to the `loader`. Default: the server's. */
  quality?: number;
  /** The tiny preview as a `data:` URL — `next/image`'s `blurDataURL`. */
  blurDataURL?: string;
  /** Flat colour under the preview, or alone with `placeholder="color"`. */
  placeholderColor?: string;
  /** The part to keep when CSS crops the image (`object-fit: cover`): becomes `object-position`. */
  focalPoint?: { x: number; y: number };
  /** Widths for full-width images; must be allowed by the server (`delivery.images.widths`). */
  deviceSizes?: readonly number[];
  /** Widths for smaller images; same caveat. */
  imageSizes?: readonly number[];
}

export type MediaImageProps = MediaImageFromDataProps | MediaImageFromSrcProps;

/** Both modes' props at once, for destructuring (the `never`s of the union cancel out otherwise). */
type AnyMediaImageProps = MediaImageCommonProps & {
  image?: MediaImageData;
} & Partial<Omit<MediaImageFromSrcProps, keyof MediaImageCommonProps | 'image'>>;

/** What every mode resolves to before rendering. */
interface ResolvedImage {
  src: string;
  srcSet: string | undefined;
  /** `srcSet` uses `w` descriptors, so `sizes` applies. */
  sizesApply: boolean;
  width: number | undefined;
  height: number | undefined;
  preview: { dataUrl?: string | undefined; color?: string | undefined } | undefined;
}

/**
 * A stored image rendered the way `next/image` does it: one `<img>` with a `srcSet`, its intrinsic
 * `width`/`height` (so the page does not jump when it arrives), lazy loading, and a blurred preview
 * painted behind it until it loads. Three ways to feed it:
 *
 * ```tsx
 * // 1. the server builds it: return { banner: await media.library.image(course.bannerMediaId) }
 * <MediaImage image={banner} alt={course.title} sizes="(max-width: 768px) 100vw, 768px" priority />
 *
 * // 2. a plain URL, like <img src> (+ the preview if you have one)
 * <MediaImage src="/hero.jpg" width={1600} height={900} blurDataURL={hero.dataUrl} alt="" />
 *
 * // 3. a loader, like next/image: srcSet built here, each width resized on demand by the server
 * <MediaImage src={course.bannerMediaId} loader={mediaImageLoader()} width={1600} height={900}
 *   sizes="100vw" alt="" />
 * ```
 *
 * The preview is the image's own background (a blurred SVG over the dominant colour), removed on
 * `load` — no wrapper element, so it styles like any `<img>`. If the image fails, the preview
 * stays instead of the broken-image icon. Server-rendered markup already shows the preview, and an
 * image that finished loading before hydration is detected (it never fires `load` again).
 */
export const MediaImage = forwardRef<HTMLImageElement, MediaImageProps>(
  function MediaImage(props, ref) {
    const {
      image,
      src,
      srcSet,
      loader,
      quality,
      blurDataURL,
      placeholderColor,
      focalPoint,
      deviceSizes,
      imageSizes,
      alt,
      sizes,
      layout,
      priority = false,
      fill = false,
      placeholder,
      width,
      height,
      loading,
      decoding,
      fetchPriority,
      style,
      onLoad,
      ...rest
    } = props as AnyMediaImageProps;
    const [loaded, setLoaded] = useState(false);

    const imgRef = useCallback(
      (node: HTMLImageElement | null) => {
        if (node?.complete && node.naturalWidth > 0) setLoaded(true);
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );

    const displayWidth = fill ? undefined : (width ?? image?.width);
    const displayHeight = fill ? undefined : (height ?? image?.height);
    const derivedSizes = layoutSizes(layout, displayWidth);

    const resolved = resolveImage({
      image,
      src,
      srcSet,
      loader,
      quality,
      blurDataURL,
      placeholderColor,
      deviceSizes,
      imageSizes,
      // A fixed image needs 1x/2x, not a `w` list: keep `sizes` out of the loader's choice.
      sizes: sizes ?? (layout === 'fixed' ? undefined : derivedSizes),
      width: fill ? undefined : width,
      height,
    });

    const lazy = !priority && (loading ?? 'lazy') === 'lazy';
    const sizesAttr = !resolved.sizesApply
      ? undefined
      : sizes !== undefined
        ? sizes
        : lazy
          ? `auto, ${derivedSizes ?? '100vw'}`
          : derivedSizes;

    const preview = resolved.preview;
    const mode = placeholder ?? (preview?.dataUrl ? 'blur' : preview?.color ? 'color' : 'empty');
    const showPlaceholder =
      !loaded &&
      ((mode === 'blur' && preview?.dataUrl !== undefined) ||
        (mode === 'color' && preview?.color !== undefined));
    const objectFit = style?.objectFit;
    const focus = focalPoint ?? image?.focalPoint;
    const objectPosition =
      style?.objectPosition ??
      (focus ? `${round(focus.x * 100)}% ${round(focus.y * 100)}%` : undefined);

    return (
      <img
        {...rest}
        {...fetchPriorityProp(priority ? 'high' : fetchPriority)}
        ref={imgRef}
        src={resolved.src}
        srcSet={resolved.srcSet}
        sizes={sizesAttr}
        width={fill ? undefined : resolved.width}
        height={fill ? undefined : resolved.height}
        alt={alt}
        loading={priority ? 'eager' : (loading ?? 'lazy')}
        decoding={decoding ?? 'async'}
        data-media-image=""
        onLoad={(event) => {
          setLoaded(true);
          onLoad?.(event);
        }}
        style={{
          ...(fill ? FILL_STYLE : layoutStyle(layout, displayWidth, displayHeight)),
          ...(showPlaceholder
            ? mode === 'blur'
              ? placeholderStyle(
                  { dataUrl: preview!.dataUrl!, color: preview!.color },
                  { objectFit, objectPosition, width: resolved.width, height: resolved.height },
                )
              : { backgroundColor: preview!.color }
            : {}),
          ...(objectPosition !== undefined ? { objectPosition } : {}),
          // While the preview shows, the alt text would print over it in some browsers.
          ...(showPlaceholder ? { color: 'transparent' } : {}),
          ...style,
        }}
      />
    );
  },
);

function resolveImage(input: {
  image: MediaImageData | undefined;
  src: string | undefined;
  srcSet: string | undefined;
  loader: MediaImageLoader | undefined;
  quality: number | undefined;
  blurDataURL: string | undefined;
  placeholderColor: string | undefined;
  deviceSizes: readonly number[] | undefined;
  imageSizes: readonly number[] | undefined;
  sizes: string | undefined;
  width: number | undefined;
  height: number | undefined;
}): ResolvedImage {
  const { image } = input;
  if (image) {
    return {
      src: image.src,
      srcSet: image.srcSet,
      sizesApply: image.srcSet !== undefined,
      width: input.width ?? image.width,
      height: input.height ?? image.height,
      preview: image.placeholder,
    };
  }

  const src = input.src ?? '';
  const preview =
    input.blurDataURL !== undefined || input.placeholderColor !== undefined
      ? { dataUrl: input.blurDataURL, color: input.placeholderColor }
      : undefined;

  if (!input.loader) {
    return {
      src,
      srcSet: input.srcSet,
      sizesApply: input.srcSet !== undefined,
      width: input.width,
      height: input.height,
      preview,
    };
  }

  const { widths, kind } = loaderWidths(
    input.width,
    input.sizes,
    input.deviceSizes ?? DEFAULT_DEVICE_SIZES,
    input.imageSizes ?? DEFAULT_IMAGE_SIZES,
  );
  const loader = input.loader;
  const url = (width: number) => loader({ src, width, quality: input.quality });
  return {
    src: url(widths.at(-1)!),
    srcSet: widths.map((w, i) => `${url(w)} ${kind === 'w' ? w : i + 1}${kind}`).join(', '),
    sizesApply: kind === 'w',
    width: input.width,
    height: input.height,
    preview,
  };
}

/**
 * Which widths a loader is asked for — `next/image`'s algorithm, so the same `sizes`/`width`
 * produce the same requests:
 *
 * - with `sizes`: every configured width (`w` descriptors), dropping those below what the smallest
 *   `vw` in `sizes` could ever need on the narrowest device;
 * - without `sizes` but with `width`: the width at 1x and 2x, rounded up to configured widths
 *   (`x` descriptors) — a fixed-size image;
 * - with neither (`fill`): every device width.
 *
 * @internal exported for tests.
 */
export function loaderWidths(
  width: number | undefined,
  sizes: string | undefined,
  deviceSizes: readonly number[],
  imageSizes: readonly number[],
): { widths: number[]; kind: 'w' | 'x' } {
  const all = [...deviceSizes, ...imageSizes].sort((a, b) => a - b);
  if (sizes) {
    const percents = [...sizes.matchAll(/(^|\s)(1?\d?\d)vw/g)].map((m) => Number(m[2]));
    if (percents.length > 0) {
      const smallest = Math.min(...percents) * 0.01;
      const narrowestDevice = Math.min(...deviceSizes);
      return { widths: all.filter((s) => s >= narrowestDevice * smallest), kind: 'w' };
    }
    return { widths: all, kind: 'w' };
  }
  if (width === undefined) return { widths: [...deviceSizes].sort((a, b) => a - b), kind: 'w' };
  const widths = [width, width * 2].map((w) => all.find((s) => s >= w) ?? all.at(-1)!);
  return { widths: [...new Set(widths)], kind: 'x' };
}

/**
 * Loader for the server's on-demand resize: `MediaDeliveryHandler` mounted on a route that passes
 * `?w=`/`?q=` through (see the docs). `path` maps the `src` (a media id) to that route; default
 * `/media/<id>`.
 *
 * ```ts
 * // routes: router.get('/media/:id', ({ params, request }) =>
 * //   delivery.handle({ mediaId: params.id, width: request.qs().w, quality: request.qs().q }))
 * <MediaImage src={mediaId} loader={mediaImageLoader()} width={800} height={400} alt="" />
 * ```
 */
export function mediaImageLoader(
  options: { path?: (src: string) => string } = {},
): MediaImageLoader {
  const path = options.path ?? ((src: string) => `/media/${encodeURIComponent(src)}`);
  return ({ src, width, quality }) => {
    const base = path(src);
    const join = base.includes('?') ? '&' : '?';
    return `${base}${join}w=${width}${quality !== undefined ? `&q=${quality}` : ''}`;
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The `sizes` a layout implies at a given display width (`undefined` when it cannot tell). */
function layoutSizes(
  layout: MediaImageCommonProps['layout'],
  width: number | undefined,
): string | undefined {
  if (layout === 'fullWidth') return '100vw';
  if (width === undefined) return undefined;
  if (layout === 'fixed') return `${width}px`;
  if (layout === 'constrained') return `(min-width: ${width}px) ${width}px, 100vw`;
  return undefined;
}

/** The box a layout implies; the caller's `style` still wins. */
function layoutStyle(
  layout: MediaImageCommonProps['layout'],
  width: number | undefined,
  height: number | undefined,
): CSSProperties {
  if (layout === 'fullWidth') return { width: '100%', height: 'auto' };
  if (layout === 'constrained') {
    return { width: '100%', height: 'auto', ...(width !== undefined ? { maxWidth: width } : {}) };
  }
  if (layout === 'fixed') {
    return {
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
    };
  }
  return {};
}

const FILL_STYLE: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
};

/**
 * Inline style that paints a blur-up preview as an element's background: the dominant colour,
 * with the tiny preview blurred on top (through an SVG filter, so the element's own content is
 * not blurred). For when the `<img>` belongs to another component — a Radix `Avatar` fallback, a
 * CSS background hero:
 *
 * ```tsx
 * <AvatarFallback style={placeholderStyle(user.avatar.placeholder)}>…</AvatarFallback>
 * ```
 *
 * Pass `width`/`height` (the intrinsic size) for the blur to keep the picture's proportions;
 * `objectFit` mirrors the image's (`cover` by default).
 */
export function placeholderStyle(
  placeholder: { dataUrl: string; color?: string | undefined },
  options: {
    objectFit?: CSSProperties['objectFit'] | undefined;
    /** Mirrors the image's `object-position` (a focal point), so the preview crops the same way. */
    objectPosition?: CSSProperties['objectPosition'] | undefined;
    width?: number | undefined;
    height?: number | undefined;
  } = {},
): CSSProperties {
  const fit = options.objectFit ?? 'cover';
  return {
    backgroundColor: placeholder.color,
    backgroundImage: `url("data:image/svg+xml;charset=utf-8,${blurSvg(placeholder.dataUrl, options.width, options.height, fit)}")`,
    backgroundSize: fit === 'contain' ? 'contain' : fit === 'fill' ? '100% 100%' : 'cover',
    backgroundPosition: options.objectPosition ?? '50% 50%',
    backgroundRepeat: 'no-repeat',
  };
}

/**
 * The preview inside an SVG with a Gaussian blur — the technique `next/image` uses. With the
 * intrinsic size, the viewBox fixes the blur radius relative to the picture (long edge 640 units)
 * and the SVG stretches to the element; without it, the preview is cropped like `object-fit`.
 * The colour matrix + composite keep the edges opaque (a plain blur fades them to transparent).
 */
function blurSvg(
  dataUrl: string,
  width: number | undefined,
  height: number | undefined,
  fit: string,
) {
  const sized = width && height && width > 0 && height > 0;
  const scale = sized ? 640 / Math.max(width, height) : 1;
  const viewBox = sized
    ? `viewBox='0 0 ${Math.round(width * scale)} ${Math.round(height * scale)}'`
    : '';
  const aspect = sized
    ? 'none'
    : fit === 'contain'
      ? 'xMidYMid'
      : fit === 'fill'
        ? 'none'
        : 'xMidYMid slice';
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' ${viewBox}>` +
    `<filter id='b' color-interpolation-filters='sRGB'>` +
    `<feGaussianBlur stdDeviation='20'/>` +
    `<feColorMatrix values='1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 100 -1' result='s'/>` +
    `<feFlood x='0' y='0' width='100%' height='100%'/>` +
    `<feComposite operator='out' in='s'/>` +
    `<feComposite in2='SourceGraphic'/>` +
    `<feGaussianBlur stdDeviation='20'/>` +
    `</filter>` +
    `<image width='100%' height='100%' x='0' y='0' preserveAspectRatio='${aspect}' style='filter: url(#b);' href='${dataUrl}'/>` +
    `</svg>`;
  // Inside a data: URL `%` and `#` are syntax: escape `%` first, so the other escapes survive.
  return svg.replace(/%/g, '%25').replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E');
}

/**
 * React 19 knows `fetchPriority`; React 18 warns about it and only passes the lowercase DOM
 * attribute through.
 */
function fetchPriorityProp(value: ImgHTMLAttributes<HTMLImageElement>['fetchPriority']) {
  if (value === undefined) return {};
  return Number.parseInt(reactVersion, 10) >= 19
    ? { fetchPriority: value }
    : ({ fetchpriority: value } as Record<string, string>);
}
