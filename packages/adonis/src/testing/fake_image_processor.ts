import type { ConversionPreset, ConversionResult, ImageProcessor } from '../image_processor.js';

const CONTENT_TYPE: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

/**
 * Deterministic {@link ImageProcessor} for tests — never touches sharp. It records every call and
 * returns a tiny synthetic buffer tagged with the preset, so conversion paths and lazy/eager
 * behaviour can be asserted without real image decoding.
 */
export class FakeImageProcessor implements ImageProcessor {
  readonly calls: Array<{ inputSize: number; preset: ConversionPreset }> = [];

  async convert(input: Buffer, preset: ConversionPreset): Promise<ConversionResult> {
    this.calls.push({ inputSize: input.byteLength, preset });
    const format = preset.format ?? 'webp';
    const data = Buffer.from(`fake:${preset.name}:${preset.width ?? ''}x${preset.height ?? ''}`);
    return { data, format, contentType: CONTENT_TYPE[format] ?? 'application/octet-stream' };
  }
}
