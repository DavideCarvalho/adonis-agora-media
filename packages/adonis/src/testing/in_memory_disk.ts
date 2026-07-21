import { Readable } from 'node:stream';
import type {
  Disk,
  DiskMetaData,
  DiskResolver,
  DiskWriteOptions,
  SignedUrlOptions,
} from '../types.js';

/** Visibility an {@link InMemoryDisk} reports — or `'unknown'` for a disk with no such signal. */
export type DiskVisibility = 'public' | 'private' | 'unknown';

interface StoredFile {
  data: Buffer;
  contentType?: string | undefined;
  lastModified: Date;
  /**
   * The `contentLength` the writer declared, recorded verbatim (`undefined` when it declared
   * none, and always `undefined` for `put`, which needs no declaration).
   *
   * It is kept only so tests can assert it. A real S3 disk CANNOT write a stream without it,
   * but this disk has the bytes in hand and never needs it — so silently ignoring it let
   * callers drop the size and still pass every test here, while failing against real S3.
   */
  contentLength?: number | undefined;
}

/**
 * In-memory {@link Disk} satisfying the same structural contract as an `@adonisjs/drive` disk.
 * Use it (via {@link inMemoryDiskResolver}) to drive the media-library and attachment layers in
 * tests without a real filesystem or S3.
 */
export class InMemoryDisk implements Disk {
  readonly files = new Map<string, StoredFile>();

  /** Options from the most recent `getSignedUrl` call, so tests can assert the contract. */
  lastSignedUrlOptions: SignedUrlOptions | undefined;

  /**
   * Reports the object visibility `delivery.mode: 'auto'` branches on. Defined as an own property
   * rather than a prototype method so `'unknown'` genuinely REMOVES it — that is the "disk that
   * cannot answer" case, which `resolveDeliveryMode` detects by probing for the method.
   */
  readonly getVisibility?: (key: string) => Promise<'public' | 'private'>;

  constructor(
    /** Used to render `getUrl`/`getSignedUrl`. */
    private readonly baseUrl = 'memory://disk',
    /** What `getVisibility` reports; `'unknown'` omits the method entirely. */
    visibility: DiskVisibility = 'private',
  ) {
    if (visibility !== 'unknown') this.getVisibility = async () => visibility;
  }

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
      contentLength: options?.contentLength,
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
    this.lastSignedUrlOptions = options;
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
export function inMemoryDiskResolver(
  names: string[] = ['default'],
  /** Visibility every disk reports; `'unknown'` builds disks with no `getVisibility` at all. */
  visibility: DiskVisibility = 'private',
): {
  resolve: DiskResolver;
  disks: Record<string, InMemoryDisk>;
} {
  const disks: Record<string, InMemoryDisk> = {};
  for (const name of names) disks[name] = new InMemoryDisk(`memory://${name}`, visibility);
  const fallback = names[0] ?? 'default';
  const resolve: DiskResolver = (name) => {
    const key = name ?? fallback;
    const disk = disks[key];
    if (!disk) throw new Error(`InMemoryDisk resolver: unknown disk "${key}"`);
    return disk;
  };
  return { resolve, disks };
}
