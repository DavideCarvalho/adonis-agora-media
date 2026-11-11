import { describe, expect, it, vi } from 'vitest';
import { configure } from '../configure.js';

describe('node ace configure @adonis-agora/media', () => {
  it('registers both providers and publishes the config files and both migrations', async () => {
    const providers: string[] = [];
    const stubs: string[] = [];
    const codemods = {
      updateRcFile: vi.fn(async (fn: (rc: { addProvider(p: string): void }) => void) => {
        fn({ addProvider: (p) => providers.push(p) });
      }),
      makeUsingStub: vi.fn(async (_root: string, stub: string) => {
        stubs.push(stub);
      }),
    };
    await configure({ createCodemods: async () => codemods } as never);

    expect(providers).toEqual([
      '@adonis-agora/media/media_provider',
      '@adonis-agora/media/dashboard_provider',
    ]);
    expect(stubs).toEqual([
      'config/media.stub',
      'config/media_dashboard.stub',
      'database/migrations/create_media_table.stub',
      // The console's Uploads tab reads these tables through the `lucid` session store.
      'database/migrations/create_media_upload_sessions_table.stub',
    ]);
  });
});
