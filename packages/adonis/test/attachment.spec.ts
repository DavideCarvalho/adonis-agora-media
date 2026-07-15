import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Attachment, AttachmentManager } from '../src/attachment.js';
import { StorageManager } from '../src/storage_manager.js';
import { FakeImageProcessor } from '../src/testing/fake_image_processor.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';

function makeManager(imageProcessor?: any) {
  const { resolve, disks } = inMemoryDiskResolver(['fs']);
  const storage = new StorageManager({ default: 'fs', resolve });
  let counter = 0;
  const manager = new AttachmentManager({
    storage,
    imageProcessor,
    idGenerator: () => `att-${++counter}`,
    emitDiagnostics: false,
  });
  return { manager, disks };
}

const png = Buffer.from('fake-png-bytes');

describe('AttachmentManager (column model)', () => {
  /**
   * The streaming path had no coverage at all here, and it was dropping the declared size
   * before it reached the disk — which a real S3 disk cannot write a stream without. The
   * in-memory disk holds the bytes and never needs the declaration, so the gap was invisible
   * until a live MinIO rejected the request.
   */
  it('forwards the declared size to the disk when streaming a Readable', async () => {
    const { manager, disks } = makeManager();
    const att = await manager.createFromFile({
      fileName: 'clip.mp4',
      mimeType: 'video/mp4',
      contents: Readable.from([Buffer.from('streamed-'), Buffer.from('bytes')]),
      size: 14,
    });
    const stored = disks.fs.files.get(att.path);
    expect(stored?.data.toString()).toBe('streamed-bytes');
    expect(stored?.contentLength).toBe(14);
  });

  it('creates an attachment, stores bytes, and serializes round-trip', async () => {
    const { manager, disks } = makeManager();
    const att = await manager.createFromFile({
      fileName: 'avatar.png',
      mimeType: 'image/png',
      contents: png,
    });
    expect(att.path).toBe('attachments/att-1/avatar.png');
    expect(att.size).toBe(png.byteLength);
    expect(disks.fs.files.has(att.path)).toBe(true);

    const json = att.toJSON();
    const back = Attachment.fromJSON(json);
    expect(back?.path).toBe(att.path);
    expect(Attachment.fromJSON(null)).toBeNull();
  });

  it('generates eager variants and resolves their url', async () => {
    const { manager } = makeManager(new FakeImageProcessor());
    const att = await manager.createFromFile(
      { fileName: 'avatar.png', mimeType: 'image/png', contents: png },
      { variants: [{ name: 'thumb', width: 100, format: 'webp' }] },
    );
    expect(att.variants.thumb?.path).toBe('attachments/att-1/variants/thumb.webp');
    expect(await manager.url(att, 'thumb')).toBe(`memory://fs/${att.variants.thumb?.path}`);
    expect(await manager.url(att)).toBe(`memory://fs/${att.path}`);
  });

  it('deletes the attachment and its variants', async () => {
    const { manager, disks } = makeManager(new FakeImageProcessor());
    const att = await manager.createFromFile(
      { fileName: 'avatar.png', mimeType: 'image/png', contents: png },
      { variants: [{ name: 'thumb', width: 100 }] },
    );
    await manager.delete(att);
    expect(disks.fs.files.has(att.path)).toBe(false);
    expect(disks.fs.files.has(att.variants.thumb?.path ?? '')).toBe(false);
  });
});
