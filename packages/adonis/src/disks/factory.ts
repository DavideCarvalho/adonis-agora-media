import type { Disk } from '../types.js';

/**
 * A configured disk: a lazy thunk the media provider calls at boot to build a {@link Disk}. Each
 * factory imports its peer dependency (e.g. `@aws-sdk/client-s3`) inside the thunk, so the driver
 * is only loaded when it is actually selected — keeping that package optional.
 */
export type DiskFactory = () => Promise<Disk>;

/** Static AWS credentials for the S3 disk. Omit to let the SDK's default provider chain resolve them. */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Options for the S3-backed disk. Mirrors the common `@aws-sdk/client-s3` `S3ClientConfig` knobs. */
export interface S3DiskConfig {
  /** Target bucket (required). */
  bucket: string;
  /** AWS region, e.g. `us-east-1`. */
  region?: string;
  /**
   * Static credentials. Omit to use the AWS SDK default provider chain (env vars, shared config,
   * IAM role, etc.).
   */
  credentials?: S3Credentials;
  /** Custom endpoint for S3-compatible services (MinIO, R2, DigitalOcean Spaces, …). */
  endpoint?: string;
  /** Use path-style addressing (`endpoint/bucket/key`) — required by most S3-compatible services. */
  forcePathStyle?: boolean;
  /** Prefix prepended to every key (e.g. `uploads`). */
  keyPrefix?: string;
  /** Base URL for stable public URLs (a CDN or the bucket website), used by `getUrl`. */
  publicBaseUrl?: string;
  /**
   * Whether objects on this disk are readable without credentials. Declarative, and read only by
   * `delivery.mode: 'auto'` (public ⇒ a plain URL, private ⇒ a signed one). Default `private`.
   */
  visibility?: 'public' | 'private';
}

/**
 * The disk factory namespace used in `config/media.ts`, parallel to `stores` and `processors`:
 *
 * ```ts
 * import { defineConfig, disks } from '@adonis-agora/media'
 *
 * export default defineConfig({
 *   disk: 's3',
 *   disks: {
 *     s3: disks.s3({ bucket: 'my-bucket', region: 'us-east-1', publicBaseUrl: 'https://cdn.example.com' }),
 *   },
 * })
 * ```
 *
 * Each factory returns a {@link DiskFactory} — a lazy thunk. Calling it in the config file costs
 * nothing; `@aws-sdk/client-s3` (and `@aws-sdk/s3-request-presigner`) are only imported when the
 * provider builds the selected disk at boot, keeping the AWS SDK an optional peer.
 */
export const disks = {
  /** S3 (or S3-compatible) disk — needs the optional `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` peers. */
  s3(config: S3DiskConfig): DiskFactory {
    return async () => {
      const { S3Client } = await import('@aws-sdk/client-s3');
      const { S3Disk } = await import('./s3.js');
      const client = new S3Client({
        ...(config.region !== undefined ? { region: config.region } : {}),
        ...(config.credentials !== undefined ? { credentials: config.credentials } : {}),
        ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
        ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
      });
      return new S3Disk({
        client,
        bucket: config.bucket,
        ...(config.keyPrefix !== undefined ? { keyPrefix: config.keyPrefix } : {}),
        ...(config.publicBaseUrl !== undefined ? { publicBaseUrl: config.publicBaseUrl } : {}),
        ...(config.region !== undefined ? { region: config.region } : {}),
        ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
        ...(config.forcePathStyle !== undefined ? { forcePathStyle: config.forcePathStyle } : {}),
        ...(config.visibility !== undefined ? { visibility: config.visibility } : {}),
      });
    };
  },
};

/**
 * Build every disk named in `config.disks` into a concrete {@link Disk} map. The media provider
 * calls this once at boot (each factory lazily loads its peer), then serves the resulting disks
 * from a synchronous resolver, falling back to Drive for any name not defined here.
 */
export async function resolveConfiguredDisks(
  factories: Record<string, DiskFactory> | undefined,
): Promise<Record<string, Disk>> {
  const built: Record<string, Disk> = {};
  if (factories) {
    for (const [name, factory] of Object.entries(factories)) {
      built[name] = await factory();
    }
  }
  return built;
}
