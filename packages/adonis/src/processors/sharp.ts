import sharp from 'sharp';
import {
  type ConversionPreset,
  type ConversionResult,
  type ConvertOptions,
  type ImageProcessor,
  presetCrops,
} from '../image_processor.js';

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
  async convert(
    input: Buffer,
    preset: ConversionPreset,
    options: ConvertOptions = {},
  ): Promise<ConversionResult> {
    const format = preset.format ?? 'webp';
    // An animated GIF/WebP keeps every frame — but only into a format that can hold them (WebP):
    // read animated into JPEG/PNG/AVIF and sharp stacks the frames into one tall image instead.
    const animated = format === 'webp';
    // `rotate()` with no angle applies the EXIF orientation — without it a portrait phone photo
    // comes out sideways, since the output drops the EXIF tag that made it display upright.
    let pipeline = sharp(input, { animated }).rotate();

    const focal =
      options.focalPoint && presetCrops(preset)
        ? await focalCrop(input, preset, options.focalPoint)
        : undefined;

    if (focal) {
      // Scale to cover the box, then cut the box out around the focal point.
      pipeline = pipeline
        .resize({ width: focal.scaledWidth, height: focal.scaledHeight, fit: 'fill' })
        .extract({
          left: focal.left,
          top: focal.top,
          width: preset.width!,
          height: preset.height!,
        });
    } else if (preset.width || preset.height) {
      pipeline = pipeline.resize({
        ...(preset.width ? { width: preset.width } : {}),
        ...(preset.height ? { height: preset.height } : {}),
        fit: preset.fit ?? 'cover',
        ...(preset.withoutEnlargement ? { withoutEnlargement: true } : {}),
        ...(preset.position ? { position: preset.position } : {}),
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

/**
 * The crop box for `preset` (both sides, `cover`) that puts `focal` as close to its centre as the
 * image allows: scale the image to just cover the box, then shift the box toward the point,
 * clamped to the edges. `undefined` for an animated image (frames are cropped by sharp's own
 * gravity instead) or one whose size cannot be read.
 */
async function focalCrop(
  input: Buffer,
  preset: ConversionPreset,
  focal: { x: number; y: number },
): Promise<{ scaledWidth: number; scaledHeight: number; left: number; top: number } | undefined> {
  const metadata = await sharp(input).metadata();
  if ((metadata.pages ?? 1) > 1 || !metadata.width || !metadata.height) return undefined;
  // `metadata()` is pre-rotation; orientations 5–8 swap the axes of what is displayed.
  const swap = (metadata.orientation ?? 1) >= 5;
  const width = swap ? metadata.height : metadata.width;
  const height = swap ? metadata.width : metadata.height;
  const boxWidth = preset.width!;
  const boxHeight = preset.height!;

  const scale = Math.max(boxWidth / width, boxHeight / height);
  const scaledWidth = Math.max(boxWidth, Math.round(width * scale));
  const scaledHeight = Math.max(boxHeight, Math.round(height * scale));
  const clamp = (value: number, max: number) => Math.min(Math.max(value, 0), max);
  return {
    scaledWidth,
    scaledHeight,
    left: clamp(Math.round(focal.x * scaledWidth - boxWidth / 2), scaledWidth - boxWidth),
    top: clamp(Math.round(focal.y * scaledHeight - boxHeight / 2), scaledHeight - boxHeight),
  };
}
