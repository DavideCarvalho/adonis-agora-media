import { TransformerRuntimeMissingError } from '../errors.js';
import type { HlsRemuxEngine } from './hls.js';
import type { MediaProbeEngine } from './probe.js';

/** The engine factories `./mediabunny.js` exports (the only module that imports the peer). */
export interface MediabunnyEngineModule {
  createHlsEngine(): HlsRemuxEngine;
  createProbeEngine(): MediaProbeEngine;
}

/**
 * Load the mediabunny-backed engine module, translating a missing optional peer into the typed
 * {@link TransformerRuntimeMissingError} instead of a raw `ERR_MODULE_NOT_FOUND` five imports deep.
 * Import happens here — at first transform — never at boot: configuring a transformer must not
 * load its engine (the same laziness `processors.sharp()` and `disks.s3()` follow).
 */
export async function loadMediabunny(transformerName: string): Promise<MediabunnyEngineModule> {
  try {
    return await import('./mediabunny.js');
  } catch (error) {
    if (
      (error as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' &&
      error instanceof Error &&
      error.message.includes('mediabunny')
    ) {
      throw new TransformerRuntimeMissingError(
        transformerName,
        "the optional peer dependency 'mediabunny'",
        'Install it (`pnpm add mediabunny`) or inject a custom `engine`.',
      );
    }
    throw error;
  }
}
