import { Duplex, PassThrough, type Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { hardenBodyStream } from '../src/disks/harden_body_stream.js';

/** Minimal stand-in for smithy's ChecksumStream: wraps a source with a bare legacy pipe(). */
class ChecksumLikeStream extends Duplex {
  constructor(public readonly source: Readable) {
    super();
    source.pipe(this);
  }
  override _read(): void {}
  override _write(chunk: Buffer, _enc: string, cb: () => void): void {
    this.push(chunk);
    cb();
  }
  override _final(cb: () => void): void {
    this.push(null);
    cb();
  }
}

const errorOf = (stream: Readable): Promise<Error> =>
  new Promise((resolve) => stream.once('error', resolve));

// Every case is bounded by an explicit per-test timeout: a regression (the bug is a HANG)
// then surfaces as a failing test rather than a hung suite.
describe('hardenBodyStream', () => {
  it('propagates a source error to the body (bare pipe drops it)', async () => {
    const source = new PassThrough();
    const body = hardenBodyStream(new ChecksumLikeStream(source));
    const err = errorOf(body);
    source.destroy(new Error('ECONNRESET: connection killed mid-stream'));
    await expect(err).resolves.toMatchObject({
      message: 'ECONNRESET: connection killed mid-stream',
    });
    expect(body.destroyed).toBe(true);
  }, 1000);

  it('turns a source closing before its end into a body error (aborted without error event)', async () => {
    const source = new PassThrough();
    const body = hardenBodyStream(new ChecksumLikeStream(source));
    const err = errorOf(body);
    source.destroy(); // close, no error — the aborted-IncomingMessage shape
    await expect(err).resolves.toMatchObject({
      message: expect.stringContaining('closed before its end'),
    });
  }, 1000);

  it('a pending read on a dead connection rejects instead of hanging forever', async () => {
    const source = new PassThrough();
    const body = hardenBodyStream(new ChecksumLikeStream(source));
    // Consume the body as the real getStream() caller would: an async iterator that is
    // parked awaiting the next chunk when the socket dies mid-stream.
    const drained = (async () => {
      for await (const _chunk of body) {
        // no bytes ever arrive; the read is parked here
      }
    })();
    source.destroy(new Error('ECONNRESET: connection killed mid-stream'));
    await expect(drained).rejects.toThrow('ECONNRESET: connection killed mid-stream');
  }, 1000);

  it('destroying the body early tears the chain down and releases the source', async () => {
    const source = new PassThrough();
    const body = hardenBodyStream(new ChecksumLikeStream(source));
    const closed = new Promise((resolve) => source.once('close', resolve));
    body.destroy();
    await closed;
    expect(source.destroyed).toBe(true);
  }, 1000);

  it('a fully consumed body leaves nothing to tear down', async () => {
    const source = new PassThrough();
    const body = hardenBodyStream(new ChecksumLikeStream(source));
    source.end('all the bytes');
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('all the bytes');
  }, 1000);
});
