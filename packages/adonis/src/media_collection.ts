import { TransformerConflictError } from './errors.js';
import type { ConversionPreset } from './image_processor.js';
import type { Transformer } from './transformer.js';
import { PlaceholderTransformer } from './transformers/placeholder.js';

/** Widths a `responsive: true` collection generates (those below the original's width). */
export const DEFAULT_RESPONSIVE_WIDTHS: readonly number[] = [320, 640, 960, 1280, 1920, 2560];

/** `responsive` options. */
export interface ResponsiveImagesConfig {
  /** Widths to generate. Default {@link DEFAULT_RESPONSIVE_WIDTHS}. */
  widths?: readonly number[];
  /** Output format. Default `webp`. */
  format?: ConversionPreset['format'];
  /** Output quality. */
  quality?: number;
}

export interface MediaCollectionConfig {
  name: string;
  /** Single-file collection: attaching replaces any existing media. */
  single?: boolean;
  /** Target disk for this collection (defaults to the storage default disk). */
  disk?: string;
  /** Allowed MIME types; when set, other types are rejected on attach. */
  acceptsMimeTypes?: string[];
  /** Image conversion presets available for this collection. */
  conversions?: ConversionPreset[];
  /**
   * Content transformers available for this collection (e.g. `transformers.hls()`). Each produces
   * a named entry in `record.conversions`, so transformer names and preset names share one
   * namespace — a collision throws {@link TransformerConflictError} at construction.
   */
  transformers?: Transformer[];
  /**
   * Responsive images without hand-written presets (spatie's `withResponsiveImages()`): eager
   * presets `responsive-<width>` at each width below the original's (wider ones are skipped, not
   * stored as same-size copies), plus `transformers.placeholder()` if the collection has none —
   * everything `media.library.image(id)` needs for a `srcset`, the intrinsic size and the blur-up.
   */
  responsive?: boolean | ResponsiveImagesConfig;
  /**
   * Strip the original's metadata on attach — EXIF (a phone photo carries the GPS position where
   * it was taken, the device, the time), XMP and IPTC — keeping its format, colour profile and
   * orientation (baked into the pixels). Conversions never carry metadata; this covers the
   * original, which is otherwise served exactly as uploaded. The original is downloaded and
   * rewritten (lossy formats re-encoded at high quality), so it costs a round trip per attach —
   * also on `attachExisting`. Only images with something to strip are rewritten.
   */
  stripMetadata?: boolean;
}

export class MediaCollectionRegistry {
  private readonly map = new Map<string, MediaCollectionConfig>();

  constructor(collections: readonly MediaCollectionConfig[] = []) {
    for (const config of collections) {
      const c = withResponsive(config);
      assertDistinctDerivativeNames(c);
      this.map.set(c.name, c);
    }
  }

  /** Registered config for a collection, or a permissive default. */
  get(name: string): MediaCollectionConfig {
    return this.map.get(name) ?? { name };
  }
}

/**
 * Presets and transformers both persist under `record.conversions[name]`, so within one collection
 * every derivative name must be unique across BOTH lists. Checked eagerly at registry construction
 * — a collision is a config bug, and failing at boot beats failing on the first attach.
 */
function assertDistinctDerivativeNames(collection: MediaCollectionConfig): void {
  const seen = new Set<string>();
  for (const preset of collection.conversions ?? []) {
    if (seen.has(preset.name)) throw new TransformerConflictError(collection.name, preset.name);
    seen.add(preset.name);
  }
  for (const transformer of collection.transformers ?? []) {
    if (seen.has(transformer.name)) {
      throw new TransformerConflictError(collection.name, transformer.name);
    }
    seen.add(transformer.name);
  }
}

/** Expand `responsive` into its presets (and the placeholder, when missing). */
function withResponsive(collection: MediaCollectionConfig): MediaCollectionConfig {
  if (!collection.responsive) return collection;
  const options = collection.responsive === true ? {} : collection.responsive;
  const presets: ConversionPreset[] = [...(options.widths ?? DEFAULT_RESPONSIVE_WIDTHS)].map(
    (width) => ({
      name: `responsive-${width}`,
      width,
      eager: true,
      onlyDownscale: true,
      ...(options.format ? { format: options.format } : {}),
      ...(options.quality !== undefined ? { quality: options.quality } : {}),
    }),
  );
  const transformers = collection.transformers ?? [];
  const hasPlaceholder = transformers.some((t) => t instanceof PlaceholderTransformer);
  return {
    ...collection,
    conversions: [...(collection.conversions ?? []), ...presets],
    transformers: hasPlaceholder ? transformers : [...transformers, new PlaceholderTransformer()],
  };
}
