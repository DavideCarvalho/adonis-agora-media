import { describe, expect, it, vi } from 'vitest';
import { configure } from '../configure.js';

describe('node ace configure @adonis-agora/media', () => {
  it('registers both providers and publishes the config files and both migrations', async () => {
    const providers: string[] = [];
    const commands: string[] = [];
    const stubs: string[] = [];
    const codemods = {
      updateRcFile: vi.fn(
        async (fn: (rc: { addProvider(p: string): void; addCommand(c: string): void }) => void) => {
          fn({ addProvider: (p) => providers.push(p), addCommand: (c) => commands.push(c) });
        },
      ),
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
      'database/migrations/add_media_tenant_id.stub',
    ]);
    expect(commands).toEqual(['@adonis-agora/media/commands']);
  });

  it('--topology=tenant publishes the one-line tenant config and no migrations', async () => {
    const providers: string[] = [];
    const stubs: string[] = [];
    const codemods = {
      updateRcFile: vi.fn(
        async (fn: (rc: { addProvider(p: string): void; addCommand(c: string): void }) => void) => {
          fn({ addProvider: (p) => providers.push(p), addCommand: () => {} });
        },
      ),
      makeUsingStub: vi.fn(async (_root: string, stub: string) => {
        stubs.push(stub);
      }),
    };
    await configure({
      createCodemods: async () => codemods,
      parsedFlags: { topology: 'tenant' },
    } as never);

    expect(providers).toEqual([
      '@adonis-agora/media/media_provider',
      '@adonis-agora/media/dashboard_provider',
    ]);
    // A tenant keeps no media of its own: no store, upload-session or tenancy tables.
    expect(stubs).toEqual(['config/media_tenant.stub', 'config/media_dashboard.stub']);
  });

  it('any other --topology value keeps the standalone config', async () => {
    const stubs: string[] = [];
    const codemods = {
      updateRcFile: vi.fn(async () => {}),
      makeUsingStub: vi.fn(async (_root: string, stub: string) => {
        stubs.push(stub);
      }),
    };
    await configure({
      createCodemods: async () => codemods,
      parsedFlags: { topology: 'standalone' },
    } as never);

    expect(stubs[0]).toBe('config/media.stub');
    expect(stubs).toHaveLength(5);
  });
});
