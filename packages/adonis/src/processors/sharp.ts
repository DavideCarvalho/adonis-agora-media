import sharp from 'sharp';
import type { ConversionPreset, ConversionResult, ImageProcessor } from '../image_processor.js';

const CONTENT_TYPE: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

/**
 * `ImageProcessor` backed by [sharp](https://sharp.pixelplumbing.com). Resize/crop via `fit`,
 * convert format, and apply quality. The default output format is `webp`. Import this directly
 * (`@adonis-agora/media/processors/sharp`) or select it lazily with `processors.sharp()` in config.
 */
export class SharpImageProcessor implements ImageProcessor {
  async convert(input: Buffer, preset: ConversionPreset): Promise<ConversionResult> {
    let pipeline = sharp(input);

    if (preset.width || preset.height) {
      pipeline = pipeline.resize({
        ...(preset.width ? { width: preset.width } : {}),
        ...(preset.height ? { height: preset.height } : {}),
        fit: preset.fit ?? 'cover',
      });
    }

    const format = preset.format ?? 'webp';
    pipeline = pipeline.toFormat(format, preset.quality ? { quality: preset.quality } : {});

    const data = await pipeline.toBuffer();
    return { data, format, contentType: CONTENT_TYPE[format] ?? 'application/octet-stream' };
  }
}
