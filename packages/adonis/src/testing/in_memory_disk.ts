import { Readable } from 'node:stream';
import type {
  Disk,
  DiskMetaData,
  DiskResolver,
  DiskWriteOptions,
  SignedUrlOptions,
} from '../types.js';

interface StoredFile {
  data: Buffer;
  contentType?: string | undefined;
  lastModified: Date;
}

/**
 * In-memory {@link Disk} satisfying the same structural contract as an `@adonisjs/drive` disk.
 * Use it (via {@link inMemoryDiskResolver}) to drive the media-library and attachment layers in
 * tests without a real filesystem or S3.
 */
export class InMemoryDisk implements Disk {
  readonly files = new Map<string, StoredFile>();

  constructor(
    /** Used to render `getUrl`/`getSignedUrl`. */
    private readonly baseUrl = 'memory://disk',
  ) {}

  async put(key: string, contents: Uint8Array, options?: DiskWriteOptions): Promise<void> {
    this.files.set(key, {
      data: Buffer.from(contents),
      contentType: options?.contentType,
      lastModified: new Date(),
    });
  }

  async putStream(key: string, contents: Readable, options?: DiskWriteOptions): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of contents) chunks.push(Buffer.from(chunk));
    this.files.set(key, {
      data: Buffer.concat(chunks),
      contentType: options?.contentType,
      lastModified: new Date(),
    });
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const file = this.require(key);
    return Buffer.from(file.data);
  }

  async getStream(key: string): Promise<Readable> {
    return Readable.from(this.require(key).data);
  }

  async exists(key: string): Promise<boolean> {
    return this.files.has(key);
  }

  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }

  async getUrl(key: string): Promise<string> {
    return `${this.baseUrl}/${key}`;
  }

  async getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string> {
    const expires = options?.expiresIn ?? '';
    return `${this.baseUrl}/${key}?signature=fake&expires=${expires}`;
  }

  async getMetaData(key: string): Promise<DiskMetaData> {
    const file = this.require(key);
    return {
      contentLength: file.data.byteLength,
      contentType: file.contentType,
      lastModified: file.lastModified,
    };
  }

  private require(key: string): StoredFile {
    const file = this.files.get(key);
    if (!file) throw new Error(`InMemoryDisk: file not found: ${key}`);
    return file;
  }
}

/**
 * Build a {@link DiskResolver} over named in-memory disks. The first name is the default; a single
 * unnamed disk is named `default`. Returns the resolver plus the disk map for assertions.
 *
 * ```ts
 * const { resolve, disks } = inMemoryDiskResolver(['fs'])
 * const storage = new StorageManager({ default: 'fs', resolve })
 * ```
 */
export function inMemoryDiskResolver(names: string[] = ['default']): {
  resolve: DiskResolver;
  disks: Record<string, InMemoryDisk>;
} {
  const disks: Record<string, InMemoryDisk> = {};
  for (const name of names) disks[name] = new InMemoryDisk(`memory://${name}`);
  const fallback = names[0] ?? 'default';
  const resolve: DiskResolver = (name) => {
    const key = name ?? fallback;
    const disk = disks[key];
    if (!disk) throw new Error(`InMemoryDisk resolver: unknown disk "${key}"`);
    return disk;
  };
  return { resolve, disks };
}
