import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import MediaProvider from '../providers/media_provider.js';
import { MediaManager } from '../src/media_manager.js';

/**
 * The built-in upload routes (`uploads.routes`): the client never picks the key or a free disk,
 * later multipart calls need the upload's token, and without auth middleware they do not mount in
 * production.
 */

type Handler = (ctx: unknown) => Promise<unknown>;

function harness(
  routes: Record<string, unknown>,
  options: {
    inProduction?: boolean;
    appKey?: string | null;
    uploads?: Record<string, unknown>;
  } = {},
) {
  const handlers = new Map<string, Handler>();
  const groups: Array<{ middleware: unknown[] }> = [];
  const chain = { as: () => chain };
  const on = (method: string) => (path: string, handler: Handler) => {
    handlers.set(`${method} ${path}`, handler);
    return chain;
  };
  const router = {
    get: on('GET'),
    post: on('POST'),
    put: on('PUT'),
    patch: on('PATCH'),
    delete: on('DELETE'),
    route: () => chain,
    group: (cb: () => void) => {
      cb();
      const group = {
        middleware: [] as unknown[],
        prefix: () => group,
      };
      const api = {
        prefix: () => api,
        middleware: (list: unknown[]) => {
          group.middleware.push(...list);
          return api;
        },
      };
      groups.push(group);
      return api;
    },
  };
  const calls: Array<[string, unknown]> = [];
  const manager = {
    storage: { defaultDisk: 'local' },
    initiateDirectUpload: async (input: { key: string; disk: string }) => {
      calls.push(['initiate', input]);
      return { uploadId: 'up-1', key: input.key, disk: input.disk, partSize: 5, parts: [] };
    },
    uploads: {
      presignPart: async (input: unknown) => {
        calls.push(['presign', input]);
        return { url: 'https://s3/part' };
      },
    },
    completeDirectUpload: async (input: { key: string; disk: string }) => {
      calls.push(['complete', input]);
      return { key: input.key, disk: input.disk };
    },
    abortDirectUpload: async (input: unknown) => void calls.push(['abort', input]),
    proxyUpload: async (input: { key: string; disk: string; contentType?: string }) => {
      calls.push(['proxy', { key: input.key, disk: input.disk, contentType: input.contentType }]);
      return { key: input.key, disk: input.disk };
    },
  };
  const warnings: string[] = [];
  const booted: Array<() => Promise<void>> = [];
  const config: Record<string, unknown> = {
    media: { uploads: { routes: { enabled: true, ...routes }, ...(options.uploads ?? {}) } },
    'app.appKey':
      options.appKey === null ? undefined : (options.appKey ?? 'an-app-key-of-32-characters-long'),
  };
  const provider = new MediaProvider({
    config: { get: (key: string, def: unknown) => config[key] ?? def },
    inProduction: options.inProduction ?? false,
    container: {
      singleton: vi.fn(),
      hasBinding: () => false,
      make: async (token: unknown) => {
        if (token === 'router') return router;
        if (token === 'logger') return { warn: (l: string) => warnings.push(l) };
        if (token === MediaManager) return manager;
        throw new Error(`unexpected ${String(token)}`);
      },
    },
    booted: async (hook: () => Promise<void>) => void booted.push(hook),
  } as never);

  const call = async (
    route: string,
    input: {
      body?: Record<string, unknown>;
      qs?: Record<string, unknown>;
      params?: Record<string, string>;
      headers?: Record<string, string>;
    } = {},
  ) => {
    const handler = handlers.get(route);
    if (!handler) throw new Error(`no route ${route}`);
    let status = 200;
    let body: unknown;
    const all = { ...(input.qs ?? {}), ...(input.body ?? {}) };
    await handler({
      params: input.params ?? {},
      request: {
        input: (key: string) => all[key],
        body: () => input.body ?? {},
        header: (name: string) => input.headers?.[name],
        request: Readable.from([Buffer.from('bytes')]),
      },
      response: {
        status(code: number) {
          status = code;
          return this;
        },
        json(payload: unknown) {
          body = payload;
        },
      },
    });
    return { status, body: body as Record<string, unknown> };
  };

  const start = async () => {
    provider.register();
    await provider.boot();
    for (const hook of booted) await hook();
    await new Promise((resolve) => setTimeout(resolve, 5));
  };
  return { start, call, calls, groups, warnings };
}

describe('uploads.routes', () => {
  it('does not mount in production without auth middleware, and says what to add', async () => {
    const { start } = harness({}, { inProduction: true });
    await expect(start()).rejects.toThrow(
      /uploads\.routes has no `middleware`.*not mounted in production.*uploads\.routes\.middleware: \[middleware\.auth\(\)\]/,
    );
  });

  it('mounts in development with a warning, and in production with middleware', async () => {
    const dev = harness({});
    await dev.start();
    expect(dev.warnings.join('\n')).toMatch(/would not mount in production/);

    const auth = () => undefined;
    const prod = harness({ middleware: [auth] }, { inProduction: true });
    await prod.start();
    expect(prod.groups.at(-1)?.middleware).toEqual([auth]);
    // `allowUnguarded`: something else guards them.
    await harness({ allowUnguarded: true }, { inProduction: true }).start();
  });

  it('derives the key server-side and refuses a client key', async () => {
    const { start, call, calls } = harness({ middleware: [() => undefined] });
    await start();
    const refused = await call('PUT /media/uploads/proxy', {
      qs: { key: 'users/1/avatar.png', fileName: 'a.png' },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/send `fileName` instead of `key`/);

    const ok = await call('PUT /media/uploads/proxy', {
      qs: { fileName: 'a.png' },
      headers: { 'content-type': 'image/png' },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.key).toMatch(/^uploads\/[0-9a-f-]{36}\/a\.png$/);
    expect(calls.at(-1)).toEqual([
      'proxy',
      { key: ok.body.key, disk: 'local', contentType: 'image/png' },
    ]);

    // A traversal-shaped name never becomes a key.
    expect((await call('PUT /media/uploads/proxy', { qs: { fileName: '../x' } })).status).toBe(400);
    // A content type a header cannot carry is refused.
    expect(
      (
        await call('PUT /media/uploads/proxy', {
          qs: { fileName: 'a.png' },
          headers: { 'content-type': 'image/png\u0001' },
        })
      ).status,
    ).toBe(400);
  });

  it('writes only to the configured disks, and keyFor resolves the key per request', async () => {
    const { start, call } = harness({
      middleware: [() => undefined],
      disk: 'uploads',
      disks: ['archive'],
      keyFor: (fileName: string, token: string) => `tenant-7/${token}-${fileName}`,
    });
    await start();
    const other = await call('PUT /media/uploads/proxy', {
      qs: { fileName: 'a.png', disk: 'private' },
    });
    expect(other.status).toBe(400);
    expect(other.body.error).toMatch(/not one these routes write to/);
    const archive = await call('PUT /media/uploads/proxy', {
      qs: { fileName: 'a.png', disk: 'archive' },
    });
    expect(archive.body).toMatchObject({
      disk: 'archive',
      key: expect.stringMatching(/^tenant-7\//),
    });
    const fallback = await call('PUT /media/uploads/proxy', { qs: { fileName: 'a.png' } });
    expect(fallback.body).toMatchObject({ disk: 'uploads' });
  });

  it("multipart: the later calls need the initiate's uploadToken, bound to its key and disk", async () => {
    const { start, call, calls } = harness({ middleware: [() => undefined] });
    await start();
    const created = await call('POST /media/uploads/direct/initiate', {
      body: { fileName: 'video.mp4', contentType: 'video/mp4', size: 10 },
    });
    expect(created.status).toBe(200);
    const { key, disk, uploadToken } = created.body as {
      key: string;
      disk: string;
      uploadToken: string;
    };
    expect(key).toMatch(/^uploads\/.+\/video\.mp4$/);
    expect(typeof uploadToken).toBe('string');

    const params = { uploadId: 'up-1', partNumber: '1' };
    const presigned = await call('POST /media/uploads/direct/:uploadId/parts/:partNumber', {
      params,
      body: { key, disk, uploadToken },
    });
    expect(presigned.status).toBe(200);
    // Another key with this token, a made-up token, or none: refused.
    for (const body of [
      { key: 'someone/else.mp4', disk, uploadToken },
      { key, disk, uploadToken: 'forged' },
      { key, disk },
    ]) {
      const refused = await call('POST /media/uploads/direct/:uploadId/complete', {
        params,
        body: { ...body, parts: [] },
      });
      expect([400, 403]).toContain(refused.status);
    }
    expect(calls.some(([name]) => name === 'complete')).toBe(false);
    const done = await call('POST /media/uploads/direct/:uploadId/complete', {
      params,
      body: { key, disk, uploadToken, parts: [{ partNumber: 1, etag: 'e' }] },
    });
    expect(done.status).toBe(200);
    const aborted = await call('DELETE /media/uploads/direct/:uploadId', {
      params: { uploadId: 'up-2' },
      body: { key, disk, uploadToken },
    });
    expect(aborted.status).toBe(403);
  });
});

describe('every upload route group is guarded the same way', () => {
  const auth = () => undefined;
  const groups = {
    'uploads.resumable.routes': (r: Record<string, unknown>) => ({
      resumable: { routes: { enabled: true, ...r } },
    }),
    'uploads.direct.routes': (r: Record<string, unknown>) => ({
      direct: { routes: { enabled: true, ...r } },
    }),
  };

  for (const [option, uploads] of Object.entries(groups)) {
    it(`${option}: not mounted in production without middleware, naming the option`, async () => {
      const { start } = harness(
        { middleware: [auth] },
        { inProduction: true, uploads: uploads({}) },
      );
      await expect(start()).rejects.toThrow(
        new RegExp(
          `${option.replaceAll('.', '\\.')} has no \`middleware\`.*not mounted in production.*${option.replaceAll('.', '\\.')}\\.middleware: \\[middleware\\.auth\\(\\)\\].*allowUnguarded: true`,
        ),
      );
    });

    it(`${option}: middleware guards it; allowUnguarded mounts it; a warning outside production`, async () => {
      const guarded = harness(
        { middleware: [auth] },
        { inProduction: true, uploads: uploads({ middleware: [auth] }) },
      );
      await guarded.start();
      expect(guarded.groups.some((g) => g.middleware.includes(auth))).toBe(true);
      await harness(
        { middleware: [auth] },
        { inProduction: true, uploads: uploads({ allowUnguarded: true }) },
      ).start();
      const dev = harness({ middleware: [auth] }, { uploads: uploads({}) });
      await dev.start();
      expect(dev.warnings.join('\n')).toContain(`${option} has no \`middleware\``);
    });
  }
});

describe('upload tokens are signed with APP_KEY, never a per-process key in production', () => {
  const auth = () => undefined;

  it('fails at boot in production without APP_KEY or uploads.secret, saying what to set', async () => {
    const { start } = harness({ middleware: [auth] }, { inProduction: true, appKey: null });
    await expect(start()).rejects.toThrow(/APP_KEY.*uploads\.secret/);
  });

  it('uploads.secret signs them when given (the same on every instance)', async () => {
    const uploads = { secret: 'an-upload-secret-0123456789' };
    const one = harness({ middleware: [auth] }, { inProduction: true, appKey: null, uploads });
    const two = harness({ middleware: [auth] }, { inProduction: true, appKey: null, uploads });
    await one.start();
    await two.start();
    const created = await one.call('POST /media/uploads/direct/initiate', {
      body: { fileName: 'a.mp4' },
    });
    const { key, disk, uploadToken } = created.body as Record<string, string>;
    // Another instance accepts the token.
    const done = await two.call('POST /media/uploads/direct/:uploadId/complete', {
      params: { uploadId: 'up-1' },
      body: { key, disk, uploadToken, parts: [] },
    });
    expect(done.status).toBe(200);
  });

  it("two instances with the same APP_KEY accept each other's tokens", async () => {
    const one = harness({ middleware: [auth] }, { inProduction: true });
    const two = harness({ middleware: [auth] }, { inProduction: true });
    await one.start();
    await two.start();
    const created = await one.call('POST /media/uploads/direct/initiate', {
      body: { fileName: 'a.mp4' },
    });
    const { key, disk, uploadToken } = created.body as Record<string, string>;
    const done = await two.call('POST /media/uploads/direct/:uploadId/complete', {
      params: { uploadId: 'up-1' },
      body: { key, disk, uploadToken, parts: [] },
    });
    expect(done.status).toBe(200);
  });

  it('outside production without APP_KEY: a per-process key, with a warning', async () => {
    const dev = harness({ middleware: [auth] }, { appKey: null });
    await dev.start();
    expect(dev.warnings.join('\n')).toMatch(/per-process key.*APP_KEY/);
    const created = await dev.call('POST /media/uploads/direct/initiate', {
      body: { fileName: 'a.mp4' },
    });
    expect(created.status).toBe(200);
  });
});
