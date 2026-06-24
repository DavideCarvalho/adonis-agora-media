import type { ConversionPreset } from './image_processor.js';

export interface MediaCollectionConfig {
  name: string;
  /** Single-file collection: attaching replaces any existing media. */
  single?: boolean;
  /** Target disk for this collection (defaults to the storage default disk). */
  disk?: string;
  /** Allowed MIME types; when set, other types are rejected on attach. */
  acceptsMimeTypes?: string[];
  /** Image conversion presets available for this collection. */
  conversions?: ConversionPreset[];
}

export class MediaCollectionRegistry {
  private readonly map = new Map<string, MediaCollectionConfig>();

  constructor(collections: MediaCollectionConfig[] = []) {
    for (const c of collections) this.map.set(c.name, c);
  }

  /** Registered config for a collection, or a permissive default. */
  get(name: string): MediaCollectionConfig {
    return this.map.get(name) ?? { name };
  }
}
