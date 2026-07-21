import { Readable } from 'node:stream';

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

/** What {@link peekContents} hands back: the sniffed head, plus contents still safe to write. */
export interface PeekedContents {
  /** Up to `length` leading bytes (fewer if the payload is shorter). */
  head: Uint8Array;
  /**
   * The contents to write. Identical to the input for a `Buffer`; for a `Readable` it is a NEW
   * stream that replays the consumed head before the untouched remainder, so the peek is invisible
   * downstream.
   */
  contents: Buffer | Readable;
}

/**
 * Read the first `length` bytes of an attach payload WITHOUT consuming it, so the caller can sniff
 * its real content type and still write every byte.
 *
 * A `Readable` cannot be rewound, so the head is re-emitted in front of the rest through a fresh
 * stream driven by the SAME async iterator — no buffering of the full payload, which is what keeps
 * the streaming attach path (large uploads, no conversions) streaming.
 */
export async function peekContents(
  contents: Buffer | Readable,
  length: number,
): Promise<PeekedContents> {
  if (Buffer.isBuffer(contents)) {
    return { head: contents.subarray(0, length), contents };
  }

  const iterator = contents[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let read = 0;
  let done = false;
  while (read < length) {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      break;
    }
    const chunk = Buffer.from(next.value);
    chunks.push(chunk);
    read += chunk.byteLength;
  }
  const buffered = Buffer.concat(chunks);

  const replayed = Readable.from(
    (async function* () {
      if (buffered.byteLength > 0) yield buffered;
      if (done) return;
      while (true) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    })(),
  );

  return { head: buffered.subarray(0, length), contents: replayed };
}

/**
 * Read the first `length` bytes of an object already on a disk and stop — the stream is destroyed
 * as soon as enough bytes are in hand, so adopting a 2 GiB scan in place costs one short ranged
 * read rather than a download.
 */
export async function peekStream(stream: Readable, length: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let read = 0;
  try {
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
      read += chunk.length;
      if (read >= length) break;
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks).subarray(0, length);
}
