import { InMemoryDisk } from '../src/testing/in_memory_disk.js';
import type { DiskWriteOptions, MultipartPart, MultipartUploadDisk } from '../src/types.js';

/**
 * An in-memory disk with the full native-multipart surface. The browser side of the flow (PUTing
 * bytes to a presigned URL) is simulated with {@link stagePart}; `completeMultipartUpload`
 * assembles whatever was staged into a real object on the disk, so `attachExisting` can read it.
 */
export class FakeMultipartDisk extends InMemoryDisk implements MultipartUploadDisk {
  readonly created: Array<{ key: string; options: DiskWriteOptions | undefined }> = [];
  readonly presigned: Array<{ key: string; uploadId: string; partNumber: number; ttl: number }> =
    [];
  readonly completed: Array<{ key: string; uploadId: string; parts: MultipartPart[] }> = [];
  readonly aborted: Array<{ key: string; uploadId: string }> = [];
  /** When set, `abortMultipartUpload` throws (a lifecycle rule already reaped the upload). */
  abortFails = false;
  readonly #staged = new Map<string, Map<number, Uint8Array>>();
  #uploadSeq = 0;
  #urlSeq = 0;

  async createMultipartUpload(
    key: string,
    options?: DiskWriteOptions,
  ): Promise<{ uploadId: string }> {
    const uploadId = `mp-${++this.#uploadSeq}`;
    this.created.push({ key, options });
    this.#staged.set(uploadId, new Map());
    return { uploadId };
  }

  async uploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    body: Uint8Array,
  ): Promise<MultipartPart> {
    this.stagePart(uploadId, partNumber, body);
    return { partNumber, etag: `"e-${partNumber}"` };
  }

  async presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    ttl: number,
  ): Promise<string> {
    this.presigned.push({ key, uploadId, partNumber, ttl });
    return `https://s3.fake/${key}?uploadId=${uploadId}&partNumber=${partNumber}&sig=${++this.#urlSeq}`;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: MultipartPart[],
  ): Promise<void> {
    this.completed.push({ key, uploadId, parts });
    const staged = this.#staged.get(uploadId);
    if (staged) {
      const buffers = parts
        .slice()
        .sort((a, b) => a.partNumber - b.partNumber)
        .map((part) => Buffer.from(staged.get(part.partNumber) ?? new Uint8Array()));
      await this.put(key, new Uint8Array(Buffer.concat(buffers)));
      this.#staged.delete(uploadId);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    if (this.abortFails) throw new Error('NoSuchUpload');
    this.aborted.push({ key, uploadId });
    this.#staged.delete(uploadId);
  }

  /** Simulate the browser having PUT these bytes to the part's presigned URL. */
  stagePart(uploadId: string, partNumber: number, bytes: Uint8Array): void {
    const staged = this.#staged.get(uploadId) ?? new Map<number, Uint8Array>();
    staged.set(partNumber, bytes);
    this.#staged.set(uploadId, staged);
  }
}
