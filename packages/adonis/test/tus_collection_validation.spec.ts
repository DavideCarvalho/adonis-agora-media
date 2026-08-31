import { beforeEach, describe, expect, it } from 'vitest';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaCollectionRegistry } from '../src/media_collection.js';
import { ResumableUploadManager } from '../src/resumable_upload.js';
import { StorageManager } from '../src/storage_manager.js';
import { InMemoryDisk } from '../src/testing/in_memory_disk.js';
import { InMemoryUploadSessionStore } from '../src/testing/in_memory_upload_session_store.js';
import { TusUploadHandler } from '../src/tus.js';

const b64 = (s: string) => Buffer.from(s).toString('base64');

const samples = {
  pdf: Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 5)]),
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 1),
  ]),
  svg: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'),
  text: Buffer.from('this is a plain text report, not a PDF at all\n', 'utf8'),
};

const collections: MediaCollectionConfig[] = [
  { name: 'exams', acceptsMimeTypes: ['application/pdf'] },
  { name: 'images', acceptsMimeTypes: ['image/png', 'image/jpeg'] },
  /** Open whitelist: `image/svg+xml` has no signature, so "unrecognised" proves nothing here. */
  { name: 'vectors', acceptsMimeTypes: ['image/svg+xml', 'application/pdf'] },
  { name: 'anything' },
];

let disk: InMemoryDisk;

function makeHandler(collection?: string) {
  disk = new InMemoryDisk();
  let tokens = 0;
  const manager = new ResumableUploadManager({
    storage: new StorageManager({ default: 'local', resolve: () => disk }),
    sessions: new InMemoryUploadSessionStore(),
    idGenerator: () => `s-${++tokens}`,
    emitDiagnostics: false,
  });
  return new TusUploadHandler({
    manager,
    disk: 'local',
    basePath: '/media/uploads/tus',
    keyFor: (filename) => `up/${filename}`,
    collections: new MediaCollectionRegistry(collections),
    ...(collection !== undefined ? { collection } : {}),
  });
}

const create = (handler: TusUploadHandler, length: number, filetype?: string) =>
  handler.handle({
    method: 'POST',
    headers: {
      'upload-length': String(length),
      'upload-metadata': `filename ${b64('report.pdf')}${
        filetype ? `,filetype ${b64(filetype)}` : ''
      }`,
    },
  });

const patch = (handler: TusUploadHandler, offset: number, body: Uint8Array) =>
  handler.handle({
    method: 'PATCH',
    uploadId: 's-1',
    headers: {
      'content-type': 'application/offset+octet-stream',
      'upload-offset': String(offset),
    },
    body,
  });

const head = (handler: TusUploadHandler) =>
  handler.handle({ method: 'HEAD', uploadId: 's-1', headers: {} });

describe('TusUploadHandler — collection-aware validation at POST (declared filetype)', () => {
  let handler: TusUploadHandler;
  beforeEach(() => {
    handler = makeHandler('exams');
  });

  it('rejects an unaccepted declared filetype with 415, before a single byte is uploaded', async () => {
    const res = await create(handler, 20_000_000, 'image/png');

    expect(res.status).toBe(415);
    expect(res.body).toContain('image/png');
    expect(res.body).toContain('exams');
    // No session was created and nothing reached the disk: the whole point of rejecting at create.
    expect((await head(handler)).status).toBe(404);
    expect(disk.files.size).toBe(0);
  });

  it('accepts a whitelisted declared filetype', async () => {
    const res = await create(handler, samples.pdf.byteLength, 'application/pdf');

    expect(res.status).toBe(201);
    expect(res.headers.Location).toBe('/media/uploads/tus/s-1');
  });

  it('still creates the session when the client declares no filetype (deferred to the first chunk)', async () => {
    const res = await create(handler, samples.pdf.byteLength);

    expect(res.status).toBe(201);
  });

  it('does not gate on MIME at all when no collection is configured', async () => {
    const open = makeHandler();

    expect((await create(open, 100, 'application/x-anything')).status).toBe(201);
  });
});

describe('TusUploadHandler — collection-aware validation on the first PATCH (real signature)', () => {
  it('rejects a client that lied in filetype, and discards the session + partial object', async () => {
    const handler = makeHandler('exams');
    await create(handler, samples.png.byteLength, 'application/pdf');

    const res = await patch(handler, 0, samples.png);

    expect(res.status).toBe(415);
    expect(res.body).toContain('image/png');
    // The session is gone and no partial bytes survive on the disk.
    expect((await head(handler)).status).toBe(404);
    expect(disk.files.size).toBe(0);
  });

  it('rejects content with no recognisable signature under a closed whitelist', async () => {
    const handler = makeHandler('exams');
    await create(handler, samples.text.byteLength, 'application/pdf');

    const res = await patch(handler, 0, samples.text);

    expect(res.status).toBe(415);
    expect(res.body).toContain('no accepted signature');
    expect((await head(handler)).status).toBe(404);
    expect(disk.files.size).toBe(0);
  });

  it('accepts unrecognisable content when the whitelist contains a signature-less type', async () => {
    const handler = makeHandler('vectors');
    await create(handler, samples.svg.byteLength, 'image/svg+xml');

    const res = await patch(handler, 0, samples.svg);

    expect(res.status).toBe(204);
    expect((await disk.getBytes('up/report.pdf')).toString()).toBe(samples.svg.toString());
  });

  it('rejects bytes that contradict a whitelisted declared type (both accepted)', async () => {
    const handler = makeHandler('images');
    await create(handler, samples.png.byteLength, 'image/jpeg');

    const res = await patch(handler, 0, samples.png);

    expect(res.status).toBe(415);
  });

  it('catches a liar that declared nothing at all', async () => {
    const handler = makeHandler('exams');
    await create(handler, samples.png.byteLength);

    const res = await patch(handler, 0, samples.png);

    expect(res.status).toBe(415);
  });

  it('lets a genuinely valid upload through both gates and completes it', async () => {
    const handler = makeHandler('exams');
    const created = await create(handler, samples.pdf.byteLength, 'application/pdf');
    expect(created.status).toBe(201);

    const res = await patch(handler, 0, samples.pdf);

    expect(res.status).toBe(204);
    expect(res.headers['Upload-Offset']).toBe(String(samples.pdf.byteLength));
    expect(Buffer.from(await disk.getBytes('up/report.pdf'))).toEqual(samples.pdf);
  });

  it('sniffs only the first chunk — later chunks are payload, not signature', async () => {
    const handler = makeHandler('exams');
    const total = samples.pdf.byteLength + samples.png.byteLength;
    await create(handler, total, 'application/pdf');

    expect((await patch(handler, 0, samples.pdf)).status).toBe(204);
    // A middle chunk that happens to look like another format is just bytes; it must not be sniffed.
    expect((await patch(handler, samples.pdf.byteLength, samples.png)).status).toBe(204);
    expect((await disk.getBytes('up/report.pdf')).byteLength).toBe(total);
  });

  it('accepts any binary on a handler with no collection configured', async () => {
    const handler = makeHandler();
    await create(handler, samples.png.byteLength, 'application/pdf');

    expect((await patch(handler, 0, samples.png)).status).toBe(204);
  });
});
