import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { TransformerContext } from '../transformer.js';

/** What {@link withSourceFile} hands its callback. */
export interface MaterializedSource {
  /** Local path of the original's bytes. */
  sourcePath: string;
  /** The temp directory the source lives in — free scratch space, removed when the callback ends. */
  tempDir: string;
}

/**
 * Materialize a media original into a local temp file for the duration of `fn`, then remove the
 * whole temp directory — success or failure.
 *
 * File-based media engines (mediabunny, and most others) want random access to a local path, while
 * a disk object only offers bytes/stream — so file-shaped transformers all start with this same
 * dance. The bytes are **streamed** to disk, never buffered whole: the typical subject is a video.
 * The file keeps the original's extension purely as a debugging nicety; engines detect the real
 * format from content.
 */
export async function withSourceFile<T>(
  context: TransformerContext,
  fn: (source: MaterializedSource) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), 'agora-media-transform-'));
  try {
    const extension = extname(context.record.fileName);
    const sourcePath = join(tempDir, `source${extension || '.bin'}`);
    await pipeline(await context.getStream(), createWriteStream(sourcePath));
    return await fn({ sourcePath, tempDir });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {
      // best-effort: temp cleanup must never mask the transform's own outcome
    });
  }
}
