import type { Readable } from 'node:stream';

/**
 * Make a GetObject `Body` fail loudly when the underlying connection dies.
 *
 * Since response-checksum validation became the SDK default, `res.Body` is a smithy
 * `ChecksumStream` wired to the socket-backed `IncomingMessage` with a bare legacy
 * `source.pipe(this)` — which drops source errors. If the connection is killed
 * mid-stream (S3/MinIO idle timeout while the consumer applies backpressure), the
 * `IncomingMessage` dies with `aborted`/`errored` set but the Body never emits
 * anything: every pending read on it hangs forever, and once the Body becomes
 * unreachable the GC can even collect the consumer's whole suspended await chain,
 * turning a dropped connection into a silent, permanent freeze.
 *
 * The wrapper keeps the wrapped stream as `.source`, so we walk that chain and
 * bridge every layer down to the socket:
 *  - a layer erroring or closing before its end destroys the Body (pending reads
 *    REJECT instead of hanging);
 *  - the Body being destroyed early (consumer stopped reading) destroys the chain,
 *    releasing the socket instead of leaking it paused with a full buffer.
 */
export function hardenBodyStream(body: Readable): Readable {
  const chain = sourceChain(body);

  for (const layer of chain.slice(1)) {
    layer.once('error', (err) => body.destroy(err));
    layer.once('close', () => {
      if (!layer.readableEnded && !body.readableEnded) {
        body.destroy(
          new Error(
            `S3 body source stream (${layer.constructor?.name ?? 'stream'}) closed before its end (connection lost?)`,
          ),
        );
      }
    });
  }

  body.once('close', () => {
    for (const layer of chain.slice(1)) {
      if (!layer.readableEnded && !layer.destroyed) layer.destroy();
    }
  });

  return body;
}

/** The stream plus every `.source` it wraps (e.g. ChecksumStream → IncomingMessage). */
function sourceChain(stream: Readable): Readable[] {
  const chain: Readable[] = [stream];
  let current: unknown = stream;
  while (
    current &&
    typeof current === 'object' &&
    'source' in current &&
    current.source &&
    typeof (current.source as Readable).pipe === 'function' &&
    !chain.includes(current.source as Readable)
  ) {
    chain.push(current.source as Readable);
    current = current.source;
  }
  return chain;
}
