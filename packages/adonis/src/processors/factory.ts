import type { ImageProcessor } from '../image_processor.js';

/**
 * A configured image processor: a lazy thunk the media provider calls at boot. The sharp factory
 * imports `sharp` only inside the thunk, so the heavy peer is loaded only when selected.
 */
export type ImageProcessorFactory = () => Promise<ImageProcessor>;

/**
 * The image-processor factory namespace used in `config/media.ts`:
 *
 * ```ts
 * import { defineConfig, processors } from '@adonis-agora/media'
 *
 * export default defineConfig({
 *   imageProcessor: processors.sharp(),
 * })
 * ```
 */
export const processors = {
  /** sharp-backed resize/crop/format/quality (needs the optional `sharp` peer). */
  sharp(): ImageProcessorFactory {
    return async () => {
      const { SharpImageProcessor } = await import('./sharp.js');
      return new SharpImageProcessor();
    };
  },
};
