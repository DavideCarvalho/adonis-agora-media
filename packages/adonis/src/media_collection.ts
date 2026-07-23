import { TransformerConflictError } from './errors.js';
import type { ConversionPreset } from './image_processor.js';
import type { Transformer } from './transformer.js';

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
  /**
   * Content transformers available for this collection (e.g. `transformers.hls()`). Each produces
   * a named entry in `record.conversions`, so transformer names and preset names share one
   * namespace — a collision throws {@link TransformerConflictError} at construction.
   */
  transformers?: Transformer[];
}

export class MediaCollectionRegistry {
  private readonly map = new Map<string, MediaCollectionConfig>();

  constructor(collections: readonly MediaCollectionConfig[] = []) {
    for (const c of collections) {
      assertDistinctDerivativeNames(c);
      this.map.set(c.name, c);
    }
  }

  /** Registered config for a collection, or a permissive default. */
  get(name: string): MediaCollectionConfig {
    return this.map.get(name) ?? { name };
  }
}

/**
 * Presets and transformers both persist under `record.conversions[name]`, so within one collection
 * every derivative name must be unique across BOTH lists. Checked eagerly at registry construction
 * — a collision is a config bug, and failing at boot beats failing on the first attach.
 */
function assertDistinctDerivativeNames(collection: MediaCollectionConfig): void {
  const seen = new Set<string>();
  for (const preset of collection.conversions ?? []) {
    if (seen.has(preset.name)) throw new TransformerConflictError(collection.name, preset.name);
    seen.add(preset.name);
  }
  for (const transformer of collection.transformers ?? []) {
    if (seen.has(transformer.name)) {
      throw new TransformerConflictError(collection.name, transformer.name);
    }
    seen.add(transformer.name);
  }
}
