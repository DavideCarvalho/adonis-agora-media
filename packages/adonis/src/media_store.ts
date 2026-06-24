import type { MediaRecord } from './media_record.js';

/**
 * Persistence SPI for media records. Implemented per backend as a POJO that receives
 * its connection in the constructor. Ships with an in-memory driver (`@adonis-agora/media/testing`)
 * and a Lucid driver (`@adonis-agora/media/stores/lucid`).
 */
export interface MediaStore {
  save(record: MediaRecord): Promise<MediaRecord>;
  find(id: string): Promise<MediaRecord | null>;
  /** Records for an owner, optionally a single collection, ordered by `order` asc. */
  listByOwner(ownerType: string, ownerId: string, collection?: string): Promise<MediaRecord[]>;
  delete(id: string): Promise<void>;
  /** Next `order` value for appending to a collection (0-based). */
  nextOrder(ownerType: string, ownerId: string, collection: string): Promise<number>;
}
