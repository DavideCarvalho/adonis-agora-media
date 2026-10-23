import { forwardRef } from 'react';
import { MediaImage, type MediaImageData, type MediaImageProps } from './media-image.js';

/** One `<source>` of a {@link MediaPicture}: another crop (or format) for some screens. */
export interface MediaPictureSource {
  /** When this source applies, e.g. `"(max-width: 640px)"`. */
  media?: string;
  /** MIME type, when the source is another format (`"image/avif"`). */
  type?: string;
  /**
   * The group's descriptor — `media.library.image(id, { conversions: ['square-sm', 'square-lg'] })`
   * for a crop the default image does not share.
   */
  image: MediaImageData;
  /** `sizes` for this source. Default: the `<img>`'s. */
  sizes?: string;
}

export type MediaPictureProps = MediaImageProps & {
  /** Checked in order; the first that matches wins, otherwise the `<img>` (`image`/`src`). */
  sources: readonly MediaPictureSource[];
};

/**
 * Art direction: a `<picture>` whose `<source>`s swap in another crop on some screens — a square
 * banner on phones, the wide one on desktop — falling back to a {@link MediaImage} (blur-up,
 * lazy loading, `priority`, `layout`… all apply to it). Each source carries its own `width`/
 * `height`, so the browser reserves the right box for whichever crop it picks.
 *
 * ```tsx
 * // server
 * const banner = await media.library.image(id)
 * const bannerSquare = await media.library.image(id, { conversions: ['square-sm', 'square-lg'] })
 *
 * <MediaPicture
 *   image={banner}
 *   sources={[{ media: '(max-width: 640px)', image: bannerSquare }]}
 *   alt={course.title}
 *   sizes="100vw"
 * />
 * ```
 */
export const MediaPicture = forwardRef<HTMLImageElement, MediaPictureProps>(function MediaPicture(
  { sources, ...props },
  ref,
) {
  const lazy = !props.priority && (props.loading ?? 'lazy') === 'lazy';
  return (
    <picture>
      {sources.map((source, index) => {
        const srcSet = source.image.srcSet ?? source.image.src;
        // `sizes` only means something for a `w`-descriptor srcset.
        const sizes = source.image.srcSet
          ? (source.sizes ?? props.sizes ?? (lazy ? 'auto, 100vw' : undefined))
          : undefined;
        return (
          <source
            // Sources are positional by nature; their order is their meaning.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={index}
            {...(source.media ? { media: source.media } : {})}
            {...(source.type ? { type: source.type } : {})}
            srcSet={srcSet}
            {...(sizes ? { sizes } : {})}
            {...(source.image.width ? { width: source.image.width } : {})}
            {...(source.image.height ? { height: source.image.height } : {})}
          />
        );
      })}
      <MediaImage ref={ref} {...(props as MediaImageProps)} />
    </picture>
  );
});
