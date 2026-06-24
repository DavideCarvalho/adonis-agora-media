export interface ConversionPreset {
  name: string;
  width?: number;
  height?: number;
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  format?: 'jpeg' | 'png' | 'webp' | 'avif';
  quality?: number;
  /** Generate eagerly on attach instead of lazily on first access. */
  eager?: boolean;
}

export interface ConversionResult {
  data: Buffer;
  /** Actual output format/extension (e.g. `webp`). */
  format: string;
  contentType: string;
}

/** Pluggable image transform engine (default impl: `@adonis-agora/media/processors/sharp`). */
export interface ImageProcessor {
  convert(input: Buffer, preset: ConversionPreset): Promise<ConversionResult>;
}
