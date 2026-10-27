import type { Readable } from 'node:stream';
import type { Disk, DiskMetaData } from './types.js';

/**
 * Open an object for streaming and read its metadata in ONE round-trip's worth of latency: the
 * `HEAD` (`getMetaData`) and the `GET` (`getStream`) are independent, so they are issued together
 * instead of one after the other — on S3 that halves the time to first byte of every proxied file
 * and HLS/DASH segment.
 *
 * Errors keep the sequential order's precedence: a metadata failure wins (and the stream that did
 * open is destroyed, so no socket is leaked); otherwise a stream failure is thrown.
 *
 * @internal
 */
export async function openWithMetadata(
  disk: Disk,
  key: string,
): Promise<{ metadata: DiskMetaData; stream: Readable }> {
  const [metadata, stream] = await Promise.allSettled([
    (async () => disk.getMetaData(key))(),
    (async () => disk.getStream(key))(),
  ]);
  if (metadata.status === 'rejected') {
    if (stream.status === 'fulfilled') stream.value.destroy();
    throw metadata.reason;
  }
  if (stream.status === 'rejected') throw stream.reason;
  return { metadata: metadata.value, stream: stream.value };
}

/** Decode disk bytes as UTF-8 without copying them into a fresh `Buffer` first. @internal */
export function utf8Of(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
}

/** A plain `Uint8Array` over the same memory as `bytes` (a Buffer), without copying it. @internal */
export function uint8View(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
