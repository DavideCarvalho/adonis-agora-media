/**
 * The part of an image that must survive a crop, as fractions of the displayed image (EXIF
 * orientation applied): `{ x: 0, y: 0 }` is the top-left corner, `{ x: 0.5, y: 0.5 }` the centre.
 * Stored per record in `customProperties.focalPoint` (`media.library.setFocalPoint()`).
 */
export interface FocalPoint {
  x: number;
  y: number;
}

/**
 * Where a cropping preset keeps the image: a gravity (`'top'`, `'left bottom'`, …), or a content
 * strategy — `'attention'` keeps the most salient region (skin tones, saturation, luminance),
 * `'entropy'` the most detailed one. A record's focal point, when set, wins over all of these.
 */
export type CropPosition =
  | 'centre'
  | 'center'
  | 'top'
  | 'right top'
  | 'right'
  | 'right bottom'
  | 'bottom'
  | 'left bottom'
  | 'left'
  | 'left top'
  | 'attention'
  | 'entropy';

export interface ConversionPreset {
  name: string;
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  format?: 'jpeg' | 'png' | 'webp' | 'avif';
  quality?: number;
  /**
   * Gaussian blur sigma (sharp's `blur(sigma)`, 0.3–1000), applied after the resize. Pair it with a
   * small `width` for a blurred low-res variant served as a file.
   */
  blur?: number;
  /** Never enlarge: an original narrower than `width` keeps its own size. */
  withoutEnlargement?: boolean;
  /**
   * Skip this conversion when it would not be narrower than the original — no same-size copy is
   * stored; the conversion is recorded with `meta.skipped` and no artifact. What `responsive`
   * collections use, so a 600px upload does not get 960/1280/1920 "versions" of itself. Needs a
   * processor that implements {@link ImageProcessor.dimensions} (sharp does); otherwise ignored.
   */
  onlyDownscale?: boolean;
  /**
   * What a crop (`fit: 'cover'` with `width` and `height`) keeps. Default `'centre'`. A record's
   * focal point overrides it.
   */
  position?: CropPosition;
  /** Generate eagerly on attach instead of lazily on first access. */
  eager?: boolean;
}

export interface ConversionResult {
  data: Buffer;
  /** Actual output format/extension (e.g. `webp`). */
  format: string;
  contentType: string;
  /**
   * Output dimensions in px, when the processor knows them. Persisted as the conversion's
   * `meta.width`/`meta.height`, which is what lets {@link MediaLibrary.image} build a `srcset`.
   */
  width?: number;
  height?: number;
}

/** Per-record context for a conversion. */
export interface ConvertOptions {
  /** The record's focal point: a crop keeps it as close to the centre as the image allows. */
  focalPoint?: FocalPoint | undefined;
}

/** Pluggable image transform engine (default impl: `@adonis-agora/media/processors/sharp`). */
export interface ImageProcessor {
  convert(
    input: Buffer,
    preset: ConversionPreset,
    options?: ConvertOptions,
  ): Promise<ConversionResult>;
  /** Displayed size of an image (EXIF orientation applied), if it can be read. Optional. */
  dimensions?(input: Buffer): Promise<{ width: number; height: number } | undefined>;
}

/** Does this preset crop (and so care about a focal point / position)? */
export function presetCrops(preset: ConversionPreset): boolean {
  return Boolean(preset.width && preset.height && (preset.fit ?? 'cover') === 'cover');
}

/** The record's focal point, if `customProperties.focalPoint` holds a valid one. */
export function focalPointOf(customProperties: Record<string, unknown>): FocalPoint | undefined {
  const point = customProperties.focalPoint as { x?: unknown; y?: unknown } | undefined;
  if (!point || typeof point !== 'object') return undefined;
  const { x, y } = point;
  if (typeof x !== 'number' || typeof y !== 'number') return undefined;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return undefined;
  return { x, y };
}
