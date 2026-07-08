import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import { StoreNotConfiguredError } from '../src/errors.js';
import type { StoreContext } from '../src/stores/factory.js';
import { resolveStore, stores } from '../src/stores/factory.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

// The memory factory ignores `ctx`, so a stub app is enough here.
const ctx: StoreContext = { app: {} as ApplicationService };

describe('resolveStore', () => {
  it('falls back to the in-memory store when no store is named (zero-config path)', async () => {
    const store = await resolveStore({}, ctx);
    expect(store).toBeInstanceOf(InMemoryMediaStore);
  });

  it('builds the selected store from the stores map', async () => {
    const store = await resolveStore({ store: 'memory', stores: { memory: stores.memory() } }, ctx);
    expect(store).toBeInstanceOf(InMemoryMediaStore);
  });

  it('throws (no silent in-memory fallback) when a store is named but missing from the map', async () => {
    // `store` set but no `stores` map at all.
    await expect(resolveStore({ store: 'lucid' }, ctx)).rejects.toBeInstanceOf(
      StoreNotConfiguredError,
    );
    // `store` set but the specific key (a typo'd name) is absent from the map.
    await expect(
      resolveStore({ store: 'lucid', stores: { memory: stores.memory() } }, ctx),
    ).rejects.toBeInstanceOf(StoreNotConfiguredError);
  });
});
