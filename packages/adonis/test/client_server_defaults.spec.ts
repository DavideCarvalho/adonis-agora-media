import { createMediaUploadClient } from '@adonis-agora/media-react/client';
import { defineConfig as httpDefineConfig, Qs, Router } from '@adonisjs/core/http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaConfig } from '../src/define_config.js';
import { MIN_DIRECT_PART_SIZE } from '../src/direct_upload.js';
import { MediaManager } from '../src/media_manager.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';
import { InMemoryUploadSessionStore } from '../src/testing/in_memory_upload_session_store.js';
import { FakeMultipartDisk } from './fake_multipart_disk.js';

/**
 * Client-against-server, with the DEFAULTS of both sides and nothing configured in between.
 *
 * This is the one path no unit test on either side could cover: `packages/react` knows only the
 * URLs it produces, `packages/adonis` knows only the URLs it mounts, and both were internally
 * consistent while disagreeing with each other. A stock `createMediaUploadClient()` POSTed its
 * initiate to `/media/uploads` (its `uploadsPath` default) while `MediaProvider` mounts the
 * direct-session routes at `/media/uploads/direct/sessions` — so `mode: 'direct'` 404'd for anyone
 * who installed both packages and followed the happy path.
 *
 * Everything below the HTTP transport is real: the real provider registers real routes on a real
 * AdonisJS `Router`, the real `DirectUploadHandler`/`DirectUploadManager` serve them over a real
 * session store, and the real browser client drives the whole flow. The only double is the
 * transport itself — a `fetchImpl` that resolves each URL through `router.match()` and invokes the
 * matched route, so an unmounted path fails exactly as it would over the wire: `404`.
 */

/** 5 MiB — the smallest part size the manager accepts; keeps the fixture small but realistic. */
const PART = MIN_DIRECT_PART_SIZE;

/** The AdonisJS `Router` the provider registers into, standalone (no app boot needed to match). */
function makeRouter(): Router {
  const qs = new Qs(httpDefineConfig({}).qs ?? { parse: {}, stringify: {} });
  return new Router(
    { rcFile: { namespaces: {} }, container: {} } as never,
    {} as never,
    qs as never,
  );
}

/** The slice of `ApplicationService` the provider touches, over a real router + a real manager. */
function makeApp(config: MediaConfig, router: Router, manager: MediaManager) {
  const booted: Array<() => Promise<void> | void> = [];
  return {
    booted,
    app: {
      config: { get: (_key: string, def: unknown) => config ?? def },
      container: {
        singleton: vi.fn(),
        make: async (token: unknown) => {
          if (token === 'router') return router;
          if (token === MediaManager) return manager;
          throw new Error(`unexpected container.make(${String(token)})`);
        },
      },
      booted: async (handler: () => Promise<void> | void) => {
        booted.push(handler);
      },
    },
  };
}

/** Register the real provider's routes on the real router, then commit so `match()` can resolve. */
async function mountProvider(config: MediaConfig, router: Router, manager: MediaManager) {
  const { default: MediaProvider } = await import('../providers/media_provider.js');
  const { app, booted } = makeApp(config, router, manager);
  const provider = new MediaProvider(app as never);
  provider.register();
  await provider.boot();
  for (const handler of booted) await handler();
  router.commit();
}

/** Minimal `HttpContext` stand-in: what the provider's direct-session route adapters actually read. */
function makeCtx(params: Record<string, string>, body: unknown) {
  let status = 200;
  return {
    ctx: {
      params,
      request: { body: () => body },
      response: {
        status(code: number) {
          status = code;
          return this;
        },
      },
    },
    statusOf: () => status,
  };
}

/**
 * A `fetch` that routes through the real router instead of the network. An unmatched path answers
 * `404` — the whole point: the assertion is that the client's URLs land on mounted routes.
 */
function routerFetch(router: Router) {
  const seen: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(String(input), 'http://app.test');
    seen.push(`${method} ${url.pathname}`);

    const matched = router.match(url.pathname, method);
    if (!matched) {
      return new Response(JSON.stringify({ error: 'no such route' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }

    const parsed = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const { ctx, statusOf } = makeCtx(matched.params as Record<string, string>, parsed);
    const body = await (matched.route.handler as (c: unknown) => Promise<unknown>)(ctx);

    return new Response(body === '' ? null : JSON.stringify(body), {
      status: statusOf(),
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, seen };
}

/** Stands in for the browser PUTing a part to its presigned URL — stages the bytes on the disk. */
function stagingPartUploader(disk: FakeMultipartDisk) {
  return async (url: string, part: Blob) => {
    const parsed = new URL(url);
    const uploadId = parsed.searchParams.get('uploadId') as string;
    const partNumber = Number(parsed.searchParams.get('partNumber'));
    disk.stagePart(uploadId, partNumber, new Uint8Array(await part.arrayBuffer()));
    return `"e-${partNumber}"`;
  };
}

let disk: FakeMultipartDisk;
let manager: MediaManager;

beforeEach(() => {
  disk = new FakeMultipartDisk();
  manager = new MediaManager({
    defaultDisk: 's3',
    resolve: () => disk,
    store: new InMemoryMediaStore(),
    directUploadSessions: new InMemoryUploadSessionStore(),
    directPartSize: PART,
  });
});

describe('browser client against the provider routes', () => {
  it('completes a direct upload with BOTH sides left at their defaults', async () => {
    const router = makeRouter();
    // The stock server: direct-session routes enabled, prefix untouched.
    await mountProvider({ uploads: { direct: { routes: { enabled: true } } } }, router, manager);

    const { fetchImpl, seen } = routerFetch(router);
    // The stock client: no `uploadsPath`, no `directPath`, nothing.
    const client = createMediaUploadClient({
      fetchImpl,
      partUploader: stagingPartUploader(disk),
    });

    const bytes = new Uint8Array(PART + 1024).fill(7);
    const result = await client.uploadDirect(new Blob([bytes]), {
      filename: 'lesson.mp4',
      contentType: 'video/mp4',
    });

    expect(result.mode).toBe('direct');
    // The object really was assembled on the disk from the staged parts.
    expect(await disk.getBytes(result.mode === 'direct' ? result.key : '')).toHaveLength(
      bytes.length,
    );
    // Every request went to the direct-session prefix — none to the uploads prefix.
    expect(seen[0]).toBe('POST /media/uploads/direct/sessions');
    expect(seen.every((entry) => entry.includes('/media/uploads/direct/sessions'))).toBe(true);
  });

  it('reads session status and aborts against the default prefix too', async () => {
    const router = makeRouter();
    await mountProvider({ uploads: { direct: { routes: { enabled: true } } } }, router, manager);

    const { fetchImpl } = routerFetch(router);
    const client = createMediaUploadClient({ fetchImpl });

    const created = await manager.direct.initiate({ key: 'k.bin', size: PART * 2 });

    const status = await client.directSessionStatus(created.id);
    expect(status.id).toBe(created.id);
    expect(status.pendingParts).toHaveLength(2);

    await client.abortDirectSession(created.id);
    expect(disk.aborted).toHaveLength(1);
  });

  it('keeps honouring an explicit uploadsPath, the way clients were configured before', async () => {
    const router = makeRouter();
    await mountProvider(
      { uploads: { direct: { routes: { enabled: true, prefix: '/api/v1/upload-video' } } } },
      router,
      manager,
    );

    const { fetchImpl, seen } = routerFetch(router);
    // Exactly the shape a host wires today: one path, set on both sides.
    const client = createMediaUploadClient({
      uploadsPath: '/api/v1/upload-video',
      fetchImpl,
      partUploader: stagingPartUploader(disk),
    });

    const result = await client.uploadDirect(new Blob([new Uint8Array(1024).fill(3)]), {
      filename: 'a.mp4',
      contentType: 'video/mp4',
    });

    expect(result.mode).toBe('direct');
    expect(seen[0]).toBe('POST /api/v1/upload-video');
  });

  it('lets directPath address the session routes independently of the proxy prefix', async () => {
    const router = makeRouter();
    await mountProvider(
      { uploads: { direct: { routes: { enabled: true, prefix: '/internal/sessions' } } } },
      router,
      manager,
    );

    const { fetchImpl, seen } = routerFetch(router);
    const client = createMediaUploadClient({
      uploadsPath: '/media/uploads', // proxy lives here
      directPath: '/internal/sessions', // direct sessions live over there
      fetchImpl,
      partUploader: stagingPartUploader(disk),
    });

    const result = await client.uploadDirect(new Blob([new Uint8Array(512).fill(1)]), {
      filename: 'b.mp4',
      contentType: 'video/mp4',
    });

    expect(result.mode).toBe('direct');
    expect(seen[0]).toBe('POST /internal/sessions');
  });
});
