import type { Readable } from 'node:stream';

/**
 * The minimal disk surface `@adonis-agora/media` needs — a structural subset of an
 * `@adonisjs/drive` (flydrive) Disk, so a real Drive disk satisfies it directly. The library
 * NEVER imports Drive; it resolves a disk from the {@link DiskResolver} (the Drive manager's
 * `use(name)` in production, a fake in tests) and only ever calls these methods. This keeps Drive
 * a peer dependency and lets the in-memory test disk implement the same contract.
 *
 * Binary reads use `getBytes` (a `Uint8Array`) rather than `get` (which flydrive returns as a UTF-8
 * string); writes accept a `Uint8Array`, so callers buffer any `Readable` first.
 */
export interface Disk {
  put(key: string, contents: Uint8Array, options?: DiskWriteOptions): Promise<void>;
  /**
   * Write a stream straight to the disk without buffering it in memory (flydrive exposes this). Used
   * for large uploads when no conversions are needed and the size is known up front. Optional so the
   * structural contract stays minimal; callers fall back to {@link put} when it is absent.
   */
  putStream?(key: string, contents: Readable, options?: DiskWriteOptions): Promise<void>;
  getBytes(key: string): Promise<Uint8Array>;
  getStream(key: string): Promise<Readable>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  getUrl(key: string): Promise<string>;
  getSignedUrl(key: string, options?: SignedUrlOptions): Promise<string>;
  getMetaData(key: string): Promise<DiskMetaData>;
}

export interface DiskWriteOptions {
  contentType?: string;
  visibility?: 'public' | 'private';
}

export interface SignedUrlOptions {
  /** Human-readable duration accepted by Drive, e.g. `'30m'`, `'1h'`, or seconds as a number. */
  expiresIn?: string | number;
  contentType?: string;
  contentDisposition?: string;
}

export interface DiskMetaData {
  contentLength: number;
  contentType?: string | undefined;
  etag?: string | undefined;
  lastModified?: Date | undefined;
}

/**
 * Resolves a disk by name. In an AdonisJS app this is `(name) => drive.use(name)`; the
 * provider builds it from the booted Drive manager. Tests pass a resolver over fake disks.
 * Omitting the name yields the configured default disk.
 */
export type DiskResolver = (name?: string) => Disk;
