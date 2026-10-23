import sharp from 'sharp';
import type { ConversionPreset, ConversionResult, ImageProcessor } from '../image_processor.js';

const CONTENT_TYPE: Record<string, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

/**
 * `ImageProcessor` backed by [sharp](https://sharp.pixelplumbing.com). Auto-orients from EXIF,
 * resizes/crops via `fit`, optionally blurs, converts format, and applies quality. The default output format is `webp`. Import this directly
 * (`@adonis-agora/media/processors/sharp`) or select it lazily with `processors.sharp()` in config.
 */
export class SharpImageProcessor implements ImageProcessor {
  async convert(input: Buffer, preset: ConversionPreset): Promise<ConversionResult> {
    const format = preset.format ?? 'webp';
    // An animated GIF/WebP keeps every frame — but only into a format that can hold them (WebP):
    // read animated into JPEG/PNG/AVIF and sharp stacks the frames into one tall image instead.
    const animated = format === 'webp';
    // `rotate()` with no angle applies the EXIF orientation — without it a portrait phone photo
    // comes out sideways, since the output drops the EXIF tag that made it display upright.
    let pipeline = sharp(input, { animated }).rotate();

    if (preset.width || preset.height) {
      pipeline = pipeline.resize({
        ...(preset.width ? { width: preset.width } : {}),
        ...(preset.height ? { height: preset.height } : {}),
        fit: preset.fit ?? 'cover',
        ...(preset.withoutEnlargement ? { withoutEnlargement: true } : {}),
      });
    }

    if (preset.blur) pipeline = pipeline.blur(preset.blur);

    pipeline = pipeline.toFormat(format, preset.quality ? { quality: preset.quality } : {});

    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    return {
      data,
      format,
      contentType: CONTENT_TYPE[format] ?? 'application/octet-stream',
      width: info.width,
      // An animated output reports the whole frame strip as `height`; one frame is `pageHeight`.
      height: (info as { pageHeight?: number }).pageHeight ?? info.height,
    };
  }
}
