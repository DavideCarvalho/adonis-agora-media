import app from '@adonisjs/core/services/app';
import { MediaManager } from './media_manager.js';

/**
 * Store a single file for an owner and return stable public URLs. This is a thin, generic seam over
 * {@link MediaManager} for callers (e.g. another Agora package storing an avatar) that only need to
 * "replace this owner's one file and give me a URL", without touching the fuller library surface.
 *
 * Single-slot replacement is a property of the collection: the `collection` named here must be
 * configured `single: true` in the app's `config/media.ts`. It is NOT an attach flag.
 */
export interface StoreSingleFileInput {
  ownerType: string;
  ownerId: string;
  /** Must be configured `single: true` in the app's media config. */
  collection: string;
  fileName: string;
  mimeType: string;
  contents: Buffer;
}

export interface StoredSingleFile {
  /** Public URL of the stored original. */
  url: string;
  /** Public URL of the `thumb` conversion, or `null` when that conversion isn't configured. */
  thumbUrl: string | null;
}

export interface RemoveSingleFileInput {
  ownerType: string;
  ownerId: string;
  collection: string;
}

/**
 * Core of {@link storeSingleFile} driven by an explicit {@link MediaManager}, so tests can exercise
 * it with an in-memory manager without booting an app. Attaches the file to the owner's collection
 * (single-file replacement comes from the collection config) and resolves the original URL plus,
 * best-effort, a `thumb` conversion URL.
 */
export async function storeSingleFileWith(
  manager: MediaManager,
  input: StoreSingleFileInput,
): Promise<StoredSingleFile> {
  const record = await manager.library.for(input.ownerType, input.ownerId).attach({
    collection: input.collection,
    fileName: input.fileName,
    mimeType: input.mimeType,
    contents: input.contents,
  });

  const url = await manager.library.url(record.id);

  // The `thumb` conversion is optional: if the collection doesn't define it (or it can't be
  // generated), there's simply no thumbnail — return null rather than failing the whole store.
  let thumbUrl: string | null = null;
  try {
    thumbUrl = await manager.library.url(record.id, 'thumb');
  } catch {
    thumbUrl = null;
  }

  return { url, thumbUrl };
}

/**
 * Core of {@link removeSingleFile} driven by an explicit {@link MediaManager}. Empties the owner's
 * collection by deleting every record it holds (a single-file collection holds at most one).
 */
export async function removeSingleFileWith(
  manager: MediaManager,
  input: RemoveSingleFileInput,
): Promise<void> {
  const records = await manager.library.for(input.ownerType, input.ownerId).list(input.collection);
  for (const record of records) await manager.library.delete(record.id);
}

/**
 * Store a single file for an owner via the app-bound {@link MediaManager}. Resolves the manager from
 * the container, then delegates to {@link storeSingleFileWith}. The `collection` must be configured
 * `single: true` in `config/media.ts` for prior files to be replaced.
 */
export async function storeSingleFile(input: StoreSingleFileInput): Promise<StoredSingleFile> {
  const manager = await app.container.make(MediaManager);
  return storeSingleFileWith(manager, input);
}

/**
 * Remove the owner's file in a collection via the app-bound {@link MediaManager}. Resolves the
 * manager from the container, then delegates to {@link removeSingleFileWith}.
 */
export async function removeSingleFile(input: RemoveSingleFileInput): Promise<void> {
  const manager = await app.container.make(MediaManager);
  return removeSingleFileWith(manager, input);
}

/**
 * Whether the single-file store is usable — i.e. the {@link MediaManager} is bound in the app
 * container. Callers use this to feature-detect media before routing a store through it.
 */
export async function isSingleFileStoreAvailable(): Promise<boolean> {
  return app.container.hasBinding(MediaManager);
}
