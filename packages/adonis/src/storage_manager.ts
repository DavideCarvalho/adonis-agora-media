import type { Disk, DiskResolver } from './types.js';

export interface StorageManagerOptions {
  /** Name of the default disk (must be resolvable by the resolver). */
  default: string;
  /** Resolves a disk by name; in production `(name) => drive.use(name)`. */
  resolve: DiskResolver;
}

/**
 * Thin façade over a {@link DiskResolver} (an `@adonisjs/drive` manager in production).
 * The media-library and attachment layers talk to disks only through this, so they never
 * import Drive and the in-memory test resolver is a drop-in.
 */
export class StorageManager {
  readonly defaultDisk: string;
  private readonly resolver: DiskResolver;

  constructor(options: StorageManagerOptions) {
    this.defaultDisk = options.default;
    this.resolver = options.resolve;
  }

  disk(name?: string): Disk {
    return this.resolver(name ?? this.defaultDisk);
  }
}
