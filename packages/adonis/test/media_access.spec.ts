import type { Readable } from 'node:stream';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import {
  adonisAuthIdentity,
  authorizers,
  type MediaAccessRequest,
  type MediaIdentityResolver,
  type MediaSubject,
} from '../src/access.js';
import type { DeliveryMode } from '../src/delivery.js';
import type { DeliverySigningConfig } from '../src/delivery_signing.js';
import { authkitIdentity } from '../src/integrations/authkit.js';
import { authz } from '../src/integrations/authz.js';
import { MediaAccess } from '../src/media_access.js';
import type { MediaCollectionConfig } from '../src/media_collection.js';
import { MediaLibrary } from '../src/media_library.js';
import type { MediaRecord } from '../src/media_record.js';
import { SharpImageProcessor } from '../src/processors/sharp.js';
import { StorageManager } from '../src/storage_manager.js';
import { inMemoryDiskResolver } from '../src/testing/in_memory_disk.js';
import { InMemoryMediaStore } from '../src/testing/in_memory_media_store.js';

/** A context whose identity is just `ctx.user` — what the identity resolver below reads. */
interface TestCtx {
  user?: MediaSubject | null;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  headers: Record<string, string>;
}
const identity: MediaIdentityResolver = (ctx) => (ctx as TestCtx).user ?? null;

function setup(
  options: {
    collections?: MediaCollectionConfig[];
    mode?: DeliveryMode;
    signing?: DeliverySigningConfig;
  } = {},
) {
  const { resolve } = inMemoryDiskResolver(['fs']);
  let counter = 0;
  const library = new MediaLibrary({
    storage: new StorageManager({ default: 'fs', resolve }),
    store: new InMemoryMediaStore(),
    collections: options.collections ?? [
      { name: 'avatar', access: { read: authorizers.owner({ ownerTypes: ['User'] }) } },
      { name: 'banner', access: { read: 'public' } },
      { name: 'secret' },
    ],
    imageProcessor: new SharpImageProcessor(),
    idGenerator: () => `id-${++counter}`,
    emitDiagnostics: false,
    deliveryMode: options.mode ?? 'proxy',
    ...(options.signing ? { deliverySigning: options.signing } : {}),
  });
  const access = new MediaAccess({ library, identity });
  return { library, access };
}

async function attach(library: MediaLibrary, collection: string, ownerId = '7') {
  const png = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#468' } })
    .png()
    .toBuffer();
  return library.attach({
    ownerType: 'User',
    ownerId,
    collection,
    fileName: 'pic ção.png',
    mimeType: 'image/png',
    contents: png,
  });
}

/** Records what the route did with the response. */
function fakeHttp(init: Partial<TestCtx> = {}) {
  const sent: {
    status?: number;
    json?: unknown;
    headers: Record<string, string>;
    redirect?: string;
    stream?: Readable;
  } = { headers: {} };
  const ctx = {
    user: init.user ?? null,
    params: init.params ?? {},
    query: init.query ?? {},
    headers: init.headers ?? {},
    request: {
      qs: () => ctx.query,
      header: (name: string) => ctx.headers[name.toLowerCase()],
    },
    response: {
      status(code: number) {
        sent.status = code;
        return { json: (body: unknown) => (sent.json = body) };
      },
      header(name: string, value: string) {
        sent.headers[name.toLowerCase()] = value;
      },
      redirect(url: string) {
        sent.redirect = url;
      },
      stream(stream: Readable) {
        sent.stream = stream;
      },
    },
  };
  return { ctx, sent };
}

const owner: MediaSubject = { id: '7' };
const stranger: MediaSubject = { id: '8' };

describe('authorizers', () => {
  const record = { id: 'm', ownerType: 'User', ownerId: '7', collection: 'c' } as MediaRecord;
  const ask = (subject: MediaSubject | null, extra: Partial<MediaAccessRequest> = {}) =>
    ({ ctx: {}, action: 'read', collection: 'c', record, subject, ...extra }) as MediaAccessRequest;

  it('owner compares the owner id (and type, when restricted) with the subject', async () => {
    expect(await authorizers.owner()(ask(owner))).toBe(true);
    expect(await authorizers.owner()(ask(stranger))).toBe(false);
    expect(await authorizers.owner()(ask(null))).toBe(false);
    expect(await authorizers.owner({ ownerTypes: ['Team'] })(ask(owner))).toBe(false);
    // a write has no record: owner() cannot allow it
    expect(await authorizers.owner()(ask(owner, { action: 'write', record: undefined }))).toBe(
      false,
    );
  });

  it('public, authenticated, roles', async () => {
    expect(await authorizers.public()(ask(null))).toBe(true);
    expect(await authorizers.authenticated()(ask(null))).toBe(false);
    expect(await authorizers.authenticated()(ask(stranger))).toBe(true);
    expect(await authorizers.roles(['admin'])(ask({ id: '1', roles: ['admin'] }))).toBe(true);
    expect(await authorizers.roles(['admin'])(ask({ id: '1' }))).toBe(false);
  });

  it('any / all short-circuit, in order', async () => {
    const never = vi.fn(() => {
      throw new Error('must not run');
    });
    expect(await authorizers.any(authorizers.public(), never)(ask(null))).toBe(true);
    expect(await authorizers.all(authorizers.authenticated(), never)(ask(null))).toBe(false);
    expect(await authorizers.all()(ask(owner))).toBe(false); // nothing to allow it
  });

  it('adonisAuthIdentity reads ctx.auth.user', async () => {
    expect(await adonisAuthIdentity({ auth: { user: { id: 42, email: 'x' } } })).toMatchObject({
      id: '42',
    });
    expect(await adonisAuthIdentity({ auth: { user: null } })).toBeNull();
    expect(await adonisAuthIdentity({})).toBeNull();
  });
});

describe('media.access', () => {
  it('applies the collection rule; no rule means no', async () => {
    const { library, access } = setup();
    const avatar = await attach(library, 'avatar');
    const banner = await attach(library, 'banner');
    const secret = await attach(library, 'secret');

    expect(await access.can({ user: owner }, 'read', avatar)).toBe(true);
    expect(await access.can({ user: stranger }, 'read', avatar)).toBe(false);
    expect(await access.can({ user: null }, 'read', banner)).toBe(true);
    expect(await access.can({ user: owner }, 'read', secret)).toBe(false);
    expect(await access.can({ user: owner }, 'write', { collection: 'avatar' })).toBe(false);
    // an explicit rule replaces the collection's
    expect(await access.can({ user: owner }, 'read', secret, authorizers.public())).toBe(true);
  });

  it('authorize() throws 401 for anonymous, 403 for a signed-in stranger', async () => {
    const { library, access } = setup();
    const avatar = await attach(library, 'avatar');
    await expect(access.authorize({ user: null }, 'read', avatar)).rejects.toMatchObject({
      code: 'E_MEDIA_ACCESS_DENIED',
      status: 401,
    });
    await expect(access.authorize({ user: stranger }, 'read', avatar)).rejects.toMatchObject({
      status: 403,
      collection: 'avatar',
      mediaId: avatar.id,
    });
  });

  it('image() checks read access before handing out URLs', async () => {
    const { library, access } = setup();
    const avatar = await attach(library, 'avatar');
    await expect(access.image({ user: owner }, avatar.id)).resolves.toHaveProperty('src');
    await expect(access.image({ user: stranger }, avatar.id)).rejects.toMatchObject({
      status: 403,
    });
    await expect(access.image({ user: owner }, 'nope')).rejects.toMatchObject({
      code: 'E_MEDIA_RECORD_NOT_FOUND',
    });
  });
});

describe('media.access.deliveryRoute()', () => {
  it('streams to an allowed reader, with the headers a file needs', async () => {
    const { library, access } = setup();
    const avatar = await attach(library, 'avatar');
    const { ctx, sent } = fakeHttp({ user: owner, params: { id: avatar.id } });

    await access.deliveryRoute()(ctx);

    expect(sent.status).toBeUndefined();
    expect(sent.stream).toBeDefined();
    expect(sent.headers['content-type']).toBe('image/png');
    expect(sent.headers['content-length']).toBe(String(avatar.size));
    expect(sent.headers['cache-control']).toBe('private, max-age=60');
    expect(sent.headers['content-disposition']).toBe(
      `inline; filename="pic __o.png"; filename*=UTF-8''pic%20%C3%A7%C3%A3o.png`,
    );
  });

  it('answers 401 / 403 / 404 as JSON with the stable code', async () => {
    const { library, access } = setup();
    const avatar = await attach(library, 'avatar');
    const secret = await attach(library, 'secret');
    const route = access.deliveryRoute();

    const anonymous = fakeHttp({ params: { id: avatar.id } });
    await route(anonymous.ctx);
    expect(anonymous.sent).toMatchObject({ status: 401, json: { code: 'E_MEDIA_ACCESS_DENIED' } });

    const other = fakeHttp({ user: stranger, params: { id: avatar.id } });
    await route(other.ctx);
    expect(other.sent.status).toBe(403);
    expect(other.sent.stream).toBeUndefined();

    const noRule = fakeHttp({ user: owner, params: { id: secret.id } });
    await route(noRule.ctx);
    expect(noRule.sent.status).toBe(403);

    const missing = fakeHttp({ user: owner, params: { id: 'nope' } });
    await route(missing.ctx);
    expect(missing.sent).toMatchObject({ status: 404, json: { code: 'E_MEDIA_RECORD_NOT_FOUND' } });
  });

  it('an explicit authorize and a custom param', async () => {
    const { library, access } = setup();
    const secret = await attach(library, 'secret');
    const { ctx, sent } = fakeHttp({ user: owner, params: { mediaId: secret.id } });
    await access.deliveryRoute({ authorize: authorizers.owner(), param: 'mediaId' })(ctx);
    expect(sent.stream).toBeDefined();
  });

  it('resizes ?w= within the whitelist, 400 outside it; redirects with Vary in redirect mode', async () => {
    const { library, access } = setup({ mode: 'public' });
    const banner = await attach(library, 'banner');
    const route = access.deliveryRoute({ cacheControl: 'public, max-age=3600' });

    const ok = fakeHttp({
      params: { id: banner.id },
      query: { w: '640' },
      headers: { accept: 'image/webp,*/*' },
    });
    await route(ok.ctx);
    expect(ok.sent.redirect).toContain('/conversions/@w640q75-webp.webp');
    expect(ok.sent.headers.vary).toBe('Accept');
    expect(ok.sent.headers['cache-control']).toBe('public, max-age=3600');

    const odd = fakeHttp({ params: { id: banner.id }, query: { w: '500' } });
    await route(odd.ctx);
    expect(odd.sent).toMatchObject({
      status: 400,
      json: { code: 'E_MEDIA_IMAGE_SIZE_NOT_ALLOWED' },
    });
  });

  it('a signed URL is its own authorization; a tampered one is 403', async () => {
    const { library, access } = setup({ signing: { secret: 's3cret-value' } });
    const avatar = await attach(library, 'avatar');
    const url = new URL(library.deliveryUrl(avatar.id, { width: 500 }), 'http://app.test');
    const query = Object.fromEntries(url.searchParams);

    // nobody signed in, and 500 is not whitelisted: the signature covers both
    const signed = fakeHttp({ params: { id: avatar.id }, query });
    await access.deliveryRoute()(signed.ctx);
    expect(signed.sent.status).toBeUndefined();
    expect(signed.sent.stream).toBeDefined();

    const tampered = fakeHttp({ params: { id: avatar.id }, query: { ...query, w: '2000' } });
    await access.deliveryRoute()(tampered.ctx);
    expect(tampered.sent).toMatchObject({
      status: 403,
      json: { code: 'E_MEDIA_DELIVERY_SIGNATURE' },
    });

    // and unsigned requests are still the route's to authorize (signing is not required here)
    const session = fakeHttp({ user: owner, params: { id: avatar.id } });
    await access.deliveryRoute()(session.ctx);
    expect(session.sent.stream).toBeDefined();
  });

  it('rethrows what it does not know how to answer', async () => {
    const { library, access } = setup();
    const avatar = await attach(library, 'avatar');
    const { ctx } = fakeHttp({ user: owner, params: { id: avatar.id } });
    const boom = access.deliveryRoute({
      authorize: () => {
        throw new Error('database down');
      },
    });
    await expect(boom(ctx)).rejects.toThrow('database down');
  });
});

describe('@adonis-agora/media/authkit', () => {
  const server = {
    getAccountId: (ctx: unknown) => (ctx as { acting?: string }).acting ?? null,
    realAccountId: (ctx: unknown) => (ctx as { real?: string }).real ?? null,
  };
  const client = {
    getAuthkit: async (ctx: unknown) => ({
      getIdentity: async () => (ctx as { identity?: never }).identity ?? null,
    }),
  };

  it('server side: the acting account owns, the real human is checked', async () => {
    const resolve = authkitIdentity({ side: 'server', load: { server: async () => server } });
    expect(await resolve({ acting: 'u-2', real: 'admin-1' })).toEqual({
      id: 'u-2',
      realId: 'admin-1',
    });
    expect(await resolve({})).toBeNull();
  });

  it('client side: sub, global roles and active organization', async () => {
    const resolve = authkitIdentity({ side: 'client', load: { client: async () => client } });
    const identity = { userId: 'sub-1', globalRoles: ['admin'], orgId: 'acme' };
    expect(await resolve({ identity })).toEqual({
      id: 'sub-1',
      realId: 'sub-1',
      roles: ['admin'],
      tenantId: 'acme',
    });
  });

  it('auto: the client when ctx.authkit is there, otherwise the server, falling back to the client', async () => {
    const identity = { userId: 'sub-1' };
    const both = authkitIdentity({
      load: { server: async () => server, client: async () => client },
    });
    expect(await both({ authkit: {}, identity, acting: 'u-2' })).toMatchObject({ id: 'sub-1' });
    expect(await both({ acting: 'u-2' })).toMatchObject({ id: 'u-2' });

    const missing = Object.assign(new Error("Cannot find package '@adonis-agora/authkit-server'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const clientOnly = authkitIdentity({
      load: { server: () => Promise.reject(missing), client: async () => client },
    });
    expect(await clientOnly({ identity })).toMatchObject({ id: 'sub-1' });
  });
});

describe('@adonis-agora/media/authz', () => {
  function fakeAuthz() {
    const calls: unknown[][] = [];
    return {
      calls,
      service: {
        can: async (user: unknown, permission: string, options?: unknown) => {
          calls.push(['can', user, permission, options]);
          return permission === 'media.avatar.read';
        },
        hasAnyRole: async (user: unknown, roles: string[], options?: unknown) => {
          calls.push(['hasAnyRole', user, roles, options]);
          return roles.includes('admin');
        },
      },
    };
  }
  const request = (subject: MediaSubject | null) =>
    ({ ctx: {}, action: 'read', collection: 'avatar', subject }) as MediaAccessRequest;

  it('can(): asks authz for the real human, never the impersonated account', async () => {
    const { calls, service } = fakeAuthz();
    const rule = authz.can(({ collection, action }) => `media.${collection}.${action}`, {
      load: async () => service,
    });
    expect(await rule(request({ id: 'u-2', realId: 'admin-1' }))).toBe(true);
    expect(calls[0]).toEqual(['can', { type: 'user', id: 'admin-1' }, 'media.avatar.read', {}]);
    expect(await rule(request(null))).toBe(false);
    expect(calls).toHaveLength(1); // anonymous never reaches authz
  });

  it('passes the app user object through, and an explicit scope', async () => {
    const { calls, service } = fakeAuthz();
    const appUser = { id: 9, type: 'admin' };
    const rule = authz.can('reports.read', {
      load: async () => service,
      scope: () => ({ tenantId: 'acme' }),
    });
    await rule(request({ id: '9', user: appUser }));
    expect(calls[0]).toEqual(['can', appUser, 'reports.read', { scope: { tenantId: 'acme' } }]);
  });

  it('roles(): hasAnyRole', async () => {
    const { calls, service } = fakeAuthz();
    expect(await authz.roles(['admin'], { load: async () => service })(request({ id: '1' }))).toBe(
      true,
    );
    expect(calls[0]?.[0]).toBe('hasAnyRole');
  });
});

describe('MediaManager wiring', () => {
  it('exposes media.access with the configured identity (access.identity)', async () => {
    const { MediaManager } = await import('../src/media_manager.js');
    const { resolve } = inMemoryDiskResolver(['fs']);
    const manager = new MediaManager({
      defaultDisk: 'fs',
      resolve,
      store: new InMemoryMediaStore(),
      collections: [{ name: 'avatar', access: { read: authorizers.owner() } }],
      accessIdentity: identity,
      emitDiagnostics: false,
    });
    expect(await manager.access.subject({ user: owner })).toEqual(owner);
    const record = await manager.library.attach({
      ownerType: 'User',
      ownerId: '7',
      collection: 'avatar',
      fileName: 'a.txt',
      mimeType: 'text/plain',
      contents: Buffer.from('x'),
    });
    expect(await manager.access.can({ user: owner }, 'read', record)).toBe(true);
  });
});
