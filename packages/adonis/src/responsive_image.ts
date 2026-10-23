import type { ConversionPreset } from './image_processor.js';
import type { MediaRecord } from './media_record.js';
import { placeholderOf } from './transformers/placeholder.js';

/**
 * Everything an `<img>` needs to render a stored image the way `next/image` does — a `srcset` of
 * the collection's sizes, the intrinsic dimensions to reserve layout, and the blur-up preview.
 * Plain JSON: hand it to the page as a prop (Inertia, a JSON API) and render it with
 * `<MediaImage image={...} />` from `@adonis-agora/media-react`, or spread it on an `<img>`.
 */
export interface ResponsiveImage {
  /** The widest candidate (or the original when there are none) — the `src` fallback. */
  src: string;
  /** `"<url> 320w, <url> 960w"`. Absent when no candidate has a known width. */
  srcSet?: string;
  /** Intrinsic width of the image as displayed (EXIF orientation applied). */
  width?: number;
  /** Intrinsic height of the image as displayed. */
  height?: number;
  /** Blur-up preview, when the collection declares `transformers.placeholder()`. */
  placeholder?: { dataUrl: string; color: string };
}

export interface ResponsiveImageOptions {
  /**
   * Presets to offer as `srcset` candidates. Default: every preset of the collection. Presets that
   * would not be the same picture at another resolution are always left out — a `blur` preset, or
   * one whose fixed `width`×`height` crops to a different aspect ratio than the original.
   */
  conversions?: string[];
  /**
   * Generate a candidate preset that has not been generated yet (cached afterwards, like `url()`).
   * Default `false`: missing ones are skipped, so building the props never resizes on the request
   * path — declare the presets you list here `eager: true` so they exist from the attach on.
   */
  generate?: boolean;
  /**
   * Sign every URL for this long (seconds or a duration string) instead of using the public URL —
   * for a private bucket. For the app's own delivery route, use {@link url}.
   */
  expiresIn?: string | number;
  /**
   * Build each URL yourself (`conversion` is `undefined` for the original), e.g. to point at the
   * app's delivery route. Takes precedence over {@link expiresIn}.
   */
  url?: (conversion: string | undefined) => string | Promise<string>;
}

/** Formats every current browser decodes; anything else (HEIC, TIFF) is never a candidate. */
const BROWSER_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
]);

/** A `srcset` candidate before its URL is resolved; `conversion` is `undefined` for the original. */
export interface ImageCandidate {
  conversion: string | undefined;
  width: number;
}

/**
 * Pick the `srcset` candidates of a record: the generated presets that are the same picture at
 * another width, plus the original when it is a browser-decodable image of known width. Sorted
 * narrowest first, one per width. Pure — {@link MediaLibrary.image} resolves the URLs.
 *
 * @internal exported for tests.
 */
export function imageCandidates(
  record: MediaRecord,
  presets: ConversionPreset[],
  include?: string[],
): ImageCandidate[] {
  const placeholder = placeholderOf(record);
  const aspect = placeholder ? placeholder.width / placeholder.height : undefined;

  const candidates: ImageCandidate[] = [];
  for (const preset of presets) {
    if (include && !include.includes(preset.name)) continue;
    if (preset.blur) continue;
    const conversion = record.conversions[preset.name];
    if (!conversion?.path) continue;
    const size = conversionSize(preset, conversion.meta);
    if (!size) continue;
    if (!size.keepsAspect && !sameAspect(size.width, size.height, aspect)) continue;
    candidates.push({ conversion: preset.name, width: size.width });
  }
  if (placeholder && BROWSER_IMAGE_TYPES.has(record.mimeType)) {
    candidates.push({ conversion: undefined, width: placeholder.width });
  }

  candidates.sort((a, b) => a.width - b.width);
  return candidates.filter((c, i) => i === 0 || c.width !== candidates[i - 1]!.width);
}

/**
 * Output size of a generated preset. The processor records it in `meta` (since 0.22); for a
 * conversion generated before that, it is derived from the preset when the preset pins it down:
 * a lone `width` keeps the aspect ratio, and `cover`/`fill`/`contain` output exactly
 * `width`×`height`. `keepsAspect` says whether the preset can change the aspect ratio at all —
 * only one that can (`width` AND `height`, cropped or padded) needs the comparison.
 */
function conversionSize(
  preset: ConversionPreset,
  meta: Record<string, unknown> | undefined,
): { width: number; height?: number; keepsAspect: boolean } | undefined {
  const fit = preset.fit ?? 'cover';
  const keepsAspect = !(preset.width && preset.height) || fit === 'inside' || fit === 'outside';
  if (meta && isDimension(meta.width) && isDimension(meta.height)) {
    return { width: meta.width, height: meta.height, keepsAspect };
  }
  if (!preset.width) return undefined;
  if (!preset.height) return { width: preset.width, keepsAspect: true };
  if (fit === 'cover' || fit === 'fill' || fit === 'contain') {
    return { width: preset.width, height: preset.height, keepsAspect: false };
  }
  return undefined;
}

function isDimension(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Same picture at another size? Whole-pixel rounding skews tiny outputs, hence the tolerance.
 * Without the original's aspect ratio (no placeholder) there is nothing to compare against.
 */
function sameAspect(
  width: number,
  height: number | undefined,
  original: number | undefined,
): boolean {
  if (height === undefined || original === undefined) return false;
  return Math.abs(width / height - original) / original < 0.02;
}
