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

/** Pluggable image transform engine (default impl: `@adonis-agora/media/processors/sharp`). */
export interface ImageProcessor {
  convert(input: Buffer, preset: ConversionPreset): Promise<ConversionResult>;
}
