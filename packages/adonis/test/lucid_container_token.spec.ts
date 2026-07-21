import type { ApplicationService } from '@adonisjs/core/types';
import { describe, expect, it } from 'vitest';
import { stores } from '../src/stores/factory.js';
import { LucidMediaStore } from '../src/stores/lucid.js';
import { uploadSessions } from '../src/upload_sessions/factory.js';
import { LucidUploadSessionStore } from '../src/upload_sessions/lucid.js';

/**
 * REGRESSION GUARD — dual-package hazard on `@adonisjs/lucid`.
 *
 * These factories must resolve the Lucid `Database` through the STRING alias `'lucid.db'`, never by
 * importing `@adonisjs/lucid/services/db` (which resolves the `Database` CLASS and uses it as the
 * container token).
 *
 * Lucid's provider registers `container.singleton(Database, ...)` keyed on the class OBJECT. A class
 * token only matches when the consumer and the booting provider loaded the same physical copy of the
 * package. When a host app's tree contains two copies — different version pins, or even the same
 * version resolved under different peer sets, which pnpm materializes as separate directories — the
 * tokens differ, no binding is found, and the container tries to CONSTRUCT `Database`, which has no
 * `@inject()`:
 *
 *   RuntimeException: Cannot construct "[class Database]" class.
 *
 * That is a real production failure this library shipped into: every TUS upload 500'd while local
 * tests passed, because the duplication only existed in the deploy artifact. A string token cannot be
 * duplicated, so resolving by alias makes the library independent of the host's deduplication.
 *
 * The assertion is deliberately on the TOKEN, not on the returned store: a test that only checked
 * the store type would pass with either implementation and let the hazard back in silently.
 */
describe('lucid factories resolve the database by container alias', () => {
  /** Minimal app whose container records every token it is asked to resolve. */
  function appRecording(tokens: unknown[]): ApplicationService {
    return {
      container: {
        make: async (token: unknown) => {
          tokens.push(token);
          // The stores keep the handle and only touch it when a query runs, so a bare object is
          // enough to build one.
          return {};
        },
      },
    } as unknown as ApplicationService;
  }

  it('builds the media store via the string alias, not the Database class', async () => {
    const tokens: unknown[] = [];
    const store = await stores.lucid()({ app: appRecording(tokens) });

    expect(tokens).toEqual(['lucid.db']);
    expect(store).toBeInstanceOf(LucidMediaStore);
  });

  it('builds the upload session store via the string alias, not the Database class', async () => {
    const tokens: unknown[] = [];
    const store = await uploadSessions.lucid()({ app: appRecording(tokens) });

    expect(tokens).toEqual(['lucid.db']);
    expect(store).toBeInstanceOf(LucidUploadSessionStore);
  });

  it('passes the resolved handle through to the store', async () => {
    const db = { marker: 'the-resolved-database' };
    const app = {
      container: { make: async () => db },
    } as unknown as ApplicationService;

    const store = await stores.lucid()({ app });

    // Guards against a regression that resolves the right token but then discards the handle and
    // falls back to the imported service singleton.
    expect((store as unknown as { db: unknown }).db).toBe(db);
  });
});
