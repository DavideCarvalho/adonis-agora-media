import { HlsTransformer, type HlsTransformerOptions } from './hls.js';
import { PlaceholderTransformer, type PlaceholderTransformerOptions } from './placeholder.js';
import { MetadataProbeTransformer, type MetadataProbeTransformerOptions } from './probe.js';

/**
 * The transformer factory namespace used in `config/media.ts` — the {@link Transformer}
 * counterpart of `processors`/`disks`/`stores`:
 *
 * ```ts
 * import { defineConfig, transformers } from '@adonis-agora/media'
 *
 * export default defineConfig({
 *   collections: [
 *     {
 *       name: 'videos',
 *       acceptsMimeTypes: ['video/mp4'],
 *       transformers: [transformers.hls({ targetDuration: 4 }), transformers.probe()],
 *     },
 *   ],
 * })
 * ```
 *
 * Constructing a transformer here never loads its engine — the optional `mediabunny` / `sharp`
 * peers are imported inside the first `transform()` call, so config stays side-effect-free.
 */
export const transformers = {
  /** Video → HLS package (MPEG-TS segments + playlists) via mediabunny. Default name `'hls'`. */
  hls<Name extends string = 'hls'>(options: HlsTransformerOptions<Name> = {}) {
    return new HlsTransformer(options);
  },
  /** Metadata-only probe (duration/resolution/codecs) via mediabunny. Default name `'probe'`. */
  probe<Name extends string = 'probe'>(options: MetadataProbeTransformerOptions<Name> = {}) {
    return new MetadataProbeTransformer(options);
  },
  /**
   * Image → inline blurred-preview metadata (tiny WebP `dataUrl`, dimensions, dominant colour) via
   * sharp. Eager by default. Default name `'placeholder'`.
   */
  placeholder<Name extends string = 'placeholder'>(
    options: PlaceholderTransformerOptions<Name> = {},
  ) {
    return new PlaceholderTransformer(options);
  },
};
