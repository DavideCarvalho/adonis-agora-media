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
}

/** The blur-up preview alone — the `placeholder` of {@link MediaImageData}. */
export type MediaImagePlaceholder = NonNullable<MediaImageData['placeholder']>;

export interface MediaImageProps
  extends Omit<
    ImgHTMLAttributes<HTMLImageElement>,
    'src' | 'srcSet' | 'width' | 'height' | 'placeholder' | 'alt'
  > {
  /** The descriptor from `media.library.image(id)`. */
  image: MediaImageData;
  /** Required, like `next/image`: describe the picture, or `""` when it is decorative. */
  alt: string;
  /**
   * Which `srcSet` width the browser should pick, e.g. `"(max-width: 768px) 100vw, 50vw"`. Without
   * it the browser assumes the image spans the whole viewport and downloads accordingly.
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
   * `'color'` (the dominant colour only) or `'empty'`.
   */
  placeholder?: 'blur' | 'color' | 'empty';
  /** Override the intrinsic width (attribute). Defaults to `image.width`. */
  width?: number;
  /** Override the intrinsic height (attribute). Defaults to `image.height`. */
  height?: number;
}

/**
 * A stored image rendered the way `next/image` does it: one `<img>` with the collection's sizes as
 * `srcSet`, its intrinsic `width`/`height` (so the page does not jump when it arrives), lazy
 * loading, and a blurred preview painted behind it until it loads.
 *
 * ```tsx
 * // server: return { banner: await media.library.image(course.bannerMediaId) }
 * <MediaImage image={banner} alt={course.title} sizes="(max-width: 768px) 100vw, 768px" priority />
 *
 * <div style={{ position: 'relative', aspectRatio: '16 / 9' }}>
 *   <MediaImage image={cover} alt="" fill style={{ objectFit: 'cover' }} />
 * </div>
 * ```
 *
 * The preview is the image's own background (a blurred SVG over the dominant colour), removed on
 * `load` — no wrapper element, so it styles like any `<img>`. If the image fails, the preview
 * stays instead of the broken-image icon. Server-rendered markup already shows the preview, and an
 * image that finished loading before hydration is detected (it never fires `load` again).
 */
export const MediaImage = forwardRef<HTMLImageElement, MediaImageProps>(function MediaImage(
  {
    image,
    alt,
    sizes,
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
  },
  ref,
) {
  const [loaded, setLoaded] = useState(false);

  const imgRef = useCallback(
    (node: HTMLImageElement | null) => {
      if (node?.complete && node.naturalWidth > 0) setLoaded(true);
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const mode = placeholder ?? (image.placeholder ? 'blur' : 'empty');
  const showPlaceholder = !loaded && mode !== 'empty' && image.placeholder !== undefined;
  const objectFit = style?.objectFit;

  const resolvedWidth = fill ? undefined : (width ?? image.width);
  const resolvedHeight = fill ? undefined : (height ?? image.height);

  return (
    <img
      {...rest}
      {...fetchPriorityProp(priority ? 'high' : fetchPriority)}
      ref={imgRef}
      src={image.src}
      srcSet={image.srcSet}
      sizes={image.srcSet ? sizes : undefined}
      width={resolvedWidth}
      height={resolvedHeight}
      alt={alt}
      loading={priority ? 'eager' : (loading ?? 'lazy')}
      decoding={decoding ?? 'async'}
      data-media-image=""
      onLoad={(event) => {
        setLoaded(true);
        onLoad?.(event);
      }}
      style={{
        ...(fill ? FILL_STYLE : {}),
        ...(showPlaceholder
          ? mode === 'blur'
            ? placeholderStyle(image.placeholder!, {
                objectFit,
                width: image.width,
                height: image.height,
              })
            : { backgroundColor: image.placeholder!.color }
          : {}),
        // While the preview shows, the alt text would print over it in some browsers.
        ...(showPlaceholder ? { color: 'transparent' } : {}),
        ...style,
      }}
    />
  );
});

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
  placeholder: MediaImagePlaceholder,
  options: {
    objectFit?: CSSProperties['objectFit'] | undefined;
    width?: number | undefined;
    height?: number | undefined;
  } = {},
): CSSProperties {
  const fit = options.objectFit ?? 'cover';
  return {
    backgroundColor: placeholder.color,
    backgroundImage: `url("data:image/svg+xml;charset=utf-8,${blurSvg(placeholder.dataUrl, options.width, options.height, fit)}")`,
    backgroundSize: fit === 'contain' ? 'contain' : fit === 'fill' ? '100% 100%' : 'cover',
    backgroundPosition: '50% 50%',
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
