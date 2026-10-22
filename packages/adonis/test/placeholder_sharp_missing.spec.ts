import { describe, expect, it } from 'vitest';
import { TransformerRuntimeMissingError } from '../src/errors.js';
import { loadSharpPlaceholderEngine } from '../src/transformers/placeholder.js';

function moduleNotFound(message: string) {
  return Object.assign(new Error(message), { code: 'ERR_MODULE_NOT_FOUND' });
}

describe('placeholder engine without sharp', () => {
  it('reports the missing peer as TransformerRuntimeMissingError', async () => {
    const error = await loadSharpPlaceholderEngine('placeholder', () =>
      Promise.reject(moduleNotFound("Cannot find package 'sharp' imported from placeholder.js")),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransformerRuntimeMissingError);
    expect((error as Error).message).toContain("'sharp'");
  });

  it('lets a broken sharp install (a missing transitive dep) surface as is', async () => {
    const broken = moduleNotFound("Cannot find package '@img/sharp-libvips-linux-x64'");
    const error = await loadSharpPlaceholderEngine('placeholder', () =>
      Promise.reject(broken),
    ).catch((e: unknown) => e);
    expect(error).toBe(broken);
  });
});
