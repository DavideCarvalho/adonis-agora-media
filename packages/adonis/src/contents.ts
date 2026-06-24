import type { Readable } from 'node:stream';

/**
 * Coerce attach/create inputs (a `Buffer` or a `Readable`) to a `Uint8Array` for the disk's `put`,
 * which (matching flydrive) does not accept a stream. A `Buffer` is already a `Uint8Array`.
 */
export async function toBytes(contents: Buffer | Readable): Promise<Uint8Array> {
  if (Buffer.isBuffer(contents)) return contents;
  const chunks: Buffer[] = [];
  for await (const chunk of contents) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** Read back disk bytes as a Node `Buffer` for the image processor (which works on Buffers). */
export function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
}
