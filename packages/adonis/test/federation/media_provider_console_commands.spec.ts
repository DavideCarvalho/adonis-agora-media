import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import MediaProvider from '../../providers/media_provider.js';
import { RedisConsoleChannel } from '../../src/federation/redis_channel.js';
import { MediaManager } from '../../src/media_manager.js';
import { InMemoryMediaStore } from '../../src/testing/in_memory_media_store.js';
import { RedisBus } from '../support/redis_bus.js';

/** `MediaProvider.ready()` with `consoleCommands`: the owning side of the federated console. */
async function start(environment: string, consoleCommands: Record<string, unknown>) {
  const bus = new RedisBus();
  const store = new InMemoryMediaStore();
  const lines: string[] = [];
  const manager = {
    storage: { defaultDisk: 'fs', disk: () => ({}) },
    hasResumable: false,
    store,
  };
  const config: Record<string, unknown> = { media: { disk: 'fs', consoleCommands } };
  const app = {
    config: { get: (key: string, def: unknown) => config[key] ?? def },
    getEnvironment: () => environment,
    container: {
      make: async (token: unknown) => {
        if (token === 'redis') return { connection: () => bus.connection() };
        if (token === 'logger') {
          return { info: (l: string) => lines.push(l), error: (l: string) => lines.push(l) };
        }
        if (token === MediaManager) return manager;
        throw new Error(`unexpected ${String(token)}`);
      },
    },
  };
  const provider = new MediaProvider(app as never);
  await provider.ready();
  const console = new RedisConsoleChannel({ client: bus.connection(), prefix: 'et' });
  const send = (verb: string, ...args: unknown[]) =>
    console.send({ id: randomUUID(), verb, args, actor: 'ana@hub' }, { timeoutMs: 1_000 });
  return { provider, store, lines, send };
}

describe('MediaProvider — consoleCommands', () => {
  it('answers on the app prefix, and runs actions only with actions: true', async () => {
    const readOnly = await start('web', { prefix: 'et' });
    expect(await readOnly.send('disks')).toMatchObject({
      ok: true,
      data: { data: [{ name: 'fs', default: true }] },
    });
    await readOnly.store.save({ id: 'r1' } as never);
    expect(await readOnly.send('deleteMediaRecord', 'r1')).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    await readOnly.provider.shutdown();

    const acting = await start('web', { prefix: 'et', actions: true });
    await acting.store.save({ id: 'r1', conversions: {} } as never);
    expect(await acting.send('deleteMediaRecord', 'r1')).toEqual({
      id: expect.any(String),
      ok: true,
      data: null,
    });
    expect(await acting.store.find('r1')).toBeNull();
    expect(acting.lines).toContain('[media] federated console: deleteMediaRecord r1 by ana@hub');
    await acting.provider.shutdown();
  });

  it('does not listen outside web processes', async () => {
    const worker = await start('console', { prefix: 'et' });
    await expect(worker.send('disks')).rejects.toThrow(/listens for media console commands/);
  });
});
