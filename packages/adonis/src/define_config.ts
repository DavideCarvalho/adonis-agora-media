import { disks } from './disks/factory.js';
import type { DiskFactory, S3Credentials, S3DiskConfig } from './disks/factory.js';
import type { ImageProcessor } from './image_processor.js';
import type { MediaCollectionConfig } from './media_collection.js';
import { processors } from './processors/factory.js';
import type { ImageProcessorFactory } from './processors/factory.js';
import { stores } from './stores/factory.js';
import type { LucidStoreConfig, StoreContext, StoreFactory } from './stores/factory.js';

/**
 * Shape of `config/media.ts`. Storage is delegated to `@adonisjs/drive` — the `disk` is the name of a
 * disk in your `config/drive.ts`; omit it to use Drive's default disk. Pick a `store` by name from the
 * `stores` map (built with the {@link stores} factory so each peer is imported lazily). Conversions need
 * an `imageProcessor` (use `processors.sharp()` for the optional sharp peer, or pass your own instance).
 *
 * ```ts
 * import { defineConfig, stores, processors } from '@adonis-agora/media'
 *
 * export default defineConfig({
 *   disk: 's3',
 *   store: 'lucid',
 *   stores: {
 *     memory: stores.memory(),
 *     lucid: stores.lucid({ connection: 'pg' }),
 *   },
 *   imageProcessor: processors.sharp(),
 *   collections: [
 *     { name: 'avatar', single: true, acceptsMimeTypes: ['image/png', 'image/jpeg'] },
 *     { name: 'gallery', conversions: [{ name: 'thumb', width: 200 }, { name: 'og', width: 1200, eager: true }] },
 *   ],
 * })
 * ```
 */
export interface MediaConfig {
  /**
   * Name of the disk media is written to. Resolved first from the {@link disks} map (e.g. an
   * `disks.s3()` driver bundled with this package), then from your `@adonisjs/drive` config. Omit
   * to use Drive's default disk. A collection may override it per-collection, and each `attach`
   * call may override it per-call.
   */
  disk?: string;
  /**
   * Named disks built with the {@link disks} factory (e.g. `disks.s3({ bucket, region })`). Each
   * factory lazily imports its peer (the AWS SDK for S3) so it only loads when selected. Names here
   * take precedence over `@adonisjs/drive` disks of the same name.
   */
  disks?: Record<string, DiskFactory>;
  /** Name of the media store (a key of {@link stores}). Defaults to `memory` (single-process). */
  store?: string;
  /** Named media stores, built with the {@link stores} factory. */
  stores?: Record<string, StoreFactory>;
  /**
   * The image conversion engine. Either a ready {@link ImageProcessor} instance or an
   * {@link ImageProcessorFactory} built with the {@link processors} factory (e.g. `processors.sharp()`)
   * so the heavy peer is imported lazily. Required only if any collection defines conversions.
   */
  imageProcessor?: ImageProcessor | ImageProcessorFactory;
  /** Collection definitions (MIME whitelist, single-file replace, conversions). */
  collections?: MediaCollectionConfig[];
  /** Key prefix for column attachments created via the `AttachmentManager`. Default `attachments`. */
  attachmentKeyPrefix?: string;
  /** Emit `agora:media:*` diagnostics events (default true). */
  emitDiagnostics?: boolean;
}

/** Identity helper giving `config/media.ts` full type-checking. */
export function defineConfig(config: MediaConfig = {}): MediaConfig {
  return config;
}

export { stores, processors, disks };
export type {
  StoreContext,
  StoreFactory,
  LucidStoreConfig,
  ImageProcessorFactory,
  DiskFactory,
  S3DiskConfig,
  S3Credentials,
};
