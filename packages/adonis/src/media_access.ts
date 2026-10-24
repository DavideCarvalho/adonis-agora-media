import type { Readable } from 'node:stream';
import {
  adonisAuthIdentity,
  type MediaAction,
  type MediaAuthorizer,
  type MediaIdentityResolver,
  type MediaSubject,
  toAuthorizer,
} from './access.js';
import type { DeliveryMode } from './delivery.js';
import { deliveryQueryString } from './delivery_signing.js';
import {
  ConversionArtifactMissingError,
  ConversionNotDefinedError,
  DeliverySignatureError,
  ImageSizeNotAllowedError,
  MediaAccessDeniedError,
  MediaNotFoundError,
  NotAnImageError,
  TransformNotReadyError,
} from './errors.js';
import type { MediaLibrary } from './media_library.js';
import type { MediaRecord } from './media_record.js';
import type { ResponsiveImage, ResponsiveImageOptions } from './responsive_image.js';
import { type MediaStream, streamFormatOf } from './streaming.js';

/**
 * The slice of an AdonisJS `HttpContext` the delivery route uses — typed structurally so the
 * route works with the real context and with a test double alike.
 */
export interface DeliveryRouteContext {
  params: Record<string, unknown>;
  request: {
    qs(): Record<string, unknown>;
    header(name: string): string | undefined | null;
  };
  response: {
    status(code: number): { json(body: unknown): unknown } | unknown;
    header(name: string, value: string): unknown;
    redirect(url: string): unknown;
    stream(stream: Readable): unknown;
  };
}

export interface MediaDeliveryRouteOptions {
  /**
   * Who may read. Default: the record's collection `access.read`. With neither, every request is
   * refused — the route never serves by default.
   */
  authorize?: MediaAuthorizer;
  /** Route parameter holding the media id. Default `'id'`. */
  param?: string;
  /**
   * `Cache-Control` for what the route serves. Default `'private, max-age=60'`: a personal file
   * must not be kept by a shared cache, and a minute absorbs a page rendering it many times.
   */
  cacheControl?: string;
  /** Override `delivery.mode` for this route. */
  mode?: DeliveryMode;
  /** Signed-URL lifetime when the resolved mode is `signed`. */
  signedTtlSeconds?: number;
}

/** {@link DeliveryRouteContext}, plus the `response.send` a manifest is answered with. */
export interface StreamRouteContext extends DeliveryRouteContext {
  response: DeliveryRouteContext['response'] & { send(body: unknown): unknown };
}

export interface MediaStreamRouteOptions {
  /** Who may watch. Default: the record's collection `access.read`; neither ⇒ refused. */
  authorize?: MediaAuthorizer;
  /** `Cache-Control` for manifests and redirects. Default `'private, max-age=60'`. */
  cacheControl?: string;
  /**
   * `Cache-Control` for segments streamed through the app (`mode: 'proxy'`). Default
   * `'private, max-age=86400'`: a segment never changes once written.
   */
  segmentCacheControl?: string;
  /** How segments reach the player. Default `delivery.mode`. */
  mode?: DeliveryMode;
  /** Lifetime of the signed URL a segment request is redirected to, in `signed` mode. */
  signedTtlSeconds?: number;
  /**
   * Lifetime of the package signature handed to the player with `delivery.signing`, in seconds.
   * Default `delivery.signing.expiresIn`, never shorter than the video plus an hour.
   */
  expiresIn?: number;
}

/**
 * Authorization for media, wired to the app's identity (`access.identity` — authkit, AdonisJS
 * auth or your own) and the collections' `access` policies. `media.access` on the manager.
 *
 * The library still never decides authorization by itself: every rule comes from the app —
 * a collection's `access`, or an `authorize` passed in. This is the plumbing that applies them.
 */
export class MediaAccess {
  readonly #library: MediaLibrary;
  readonly #identity: MediaIdentityResolver;

  constructor(options: { library: MediaLibrary; identity?: MediaIdentityResolver | undefined }) {
    this.#library = options.library;
    this.#identity = options.identity ?? adonisAuthIdentity;
  }

  /** The current user per the configured identity resolver, or `null`. */
  async subject(ctx: unknown): Promise<MediaSubject | null> {
    return (await this.#identity(ctx)) ?? null;
  }

  /**
   * May the current user perform `action`? `target` is the record (read) or the collection a file
   * is going into (write). The rule is `authorize` when given, otherwise the collection's
   * `access[action]`; neither ⇒ `false`.
   */
  async can(
    ctx: unknown,
    action: MediaAction,
    target: MediaRecord | { collection: string },
    authorize?: MediaAuthorizer,
  ): Promise<boolean> {
    return (await this.#decide(ctx, action, target, authorize)).allowed;
  }

  /** Resolve the subject ONCE and run the rule — so a denial's 401/403 matches what the rule saw. */
  async #decide(
    ctx: unknown,
    action: MediaAction,
    target: MediaRecord | { collection: string },
    authorize: MediaAuthorizer | undefined,
  ): Promise<{ allowed: boolean; subject: MediaSubject | null }> {
    const collection = target.collection;
    const record = 'id' in target ? (target as MediaRecord) : undefined;
    const rule =
      authorize ?? toAuthorizer(this.#library.collections.get(collection).access?.[action]);
    const subject = await this.subject(ctx);
    return { allowed: await rule({ ctx, action, collection, record, subject }), subject };
  }

  /**
   * {@link can}, throwing {@link MediaAccessDeniedError} when refused — `401` for an anonymous
   * request, `403` otherwise. Use it in your own controllers and upload policies:
   *
   * ```ts
   * // DirectUploadPolicy.onInitiate
   * await media.access.authorize(ctx, 'write', { collection: 'avatar' })
   * ```
   */
  async authorize(
    ctx: unknown,
    action: MediaAction,
    target: MediaRecord | { collection: string },
    authorize?: MediaAuthorizer,
  ): Promise<void> {
    const { allowed, subject } = await this.#decide(ctx, action, target, authorize);
    if (allowed) return;
    throw new MediaAccessDeniedError(
      action,
      target.collection,
      'id' in target ? (target as MediaRecord).id : undefined,
      subject === null,
    );
  }

  /**
   * `media.library.image(id)` for the current user: checks read access first (the collection's
   * `access.read`, or `authorize`), so the URLs it hands out — signed ones especially, which
   * carry their authorization — only ever reach someone allowed to see the file.
   */
  async image(
    ctx: unknown,
    id: string,
    options: ResponsiveImageOptions & { authorize?: MediaAuthorizer } = {},
  ): Promise<ResponsiveImage> {
    const { authorize, ...imageOptions } = options;
    const record = await this.#library.find(id);
    if (!record) throw new MediaNotFoundError(id);
    await this.authorize(ctx, 'read', record, authorize);
    return this.#library.image(id, imageOptions);
  }

  /**
   * `media.library.stream(id)` for the current user: checks read access first (the collection's
   * `access.read`, or `authorize`), then returns the HLS/DASH manifest URLs a player needs — for
   * `useMediaStream` from `@adonis-agora/media-react`.
   *
   * ```ts
   * return inertia.render('lessons/show', { video: await media.access.stream(ctx, lesson.videoId) })
   * ```
   */
  async stream(
    ctx: unknown,
    id: string,
    options: {
      conversions?: readonly string[];
      expiresIn?: number;
      authorize?: MediaAuthorizer;
    } = {},
  ): Promise<MediaStream> {
    const { authorize, ...streamOptions } = options;
    const record = await this.#library.find(id);
    if (!record) throw new MediaNotFoundError(id);
    await this.authorize(ctx, 'read', record, authorize);
    return this.#library.stream(id, streamOptions);
  }

  /**
   * Authorize and answer one request for a file of a streaming package (HLS or DASH) — the core
   * of {@link streamRoute}, for a controller that finds the record its own way.
   *
   * A request carrying a valid package signature (`?exp=&sig=`, from `media.library.stream()`
   * with `delivery.signing`) is served without asking the app again; anything else is authorized
   * like a read. A manifest is answered as text, with the signature carried onto its references
   * (a fresh one when the request was authorized by session), so the player's segment requests
   * stay authorized. Segments are redirected to storage or streamed, per `mode`.
   */
  async serveStream(
    ctx: StreamRouteContext,
    target: MediaRecord | string | null | undefined,
    conversion: string,
    file: string,
    options: MediaStreamRouteOptions = {},
  ): Promise<unknown> {
    const { request, response } = ctx;
    const cacheControl = options.cacheControl ?? 'private, max-age=60';
    try {
      const record =
        typeof target === 'string' ? await this.#library.find(target) : (target ?? null);
      if (!record) throw new MediaNotFoundError(typeof target === 'string' ? target : '');

      const qs = request.qs();
      const expires = stringParam(qs.exp);
      const signature = stringParam(qs.sig);
      const trusted = this.#library.checkDeliverySignature(
        { mediaId: record.id, conversion, expires, signature },
        { required: false },
      );
      if (!trusted) await this.authorize(ctx, 'read', record, options.authorize);

      // Only a manifest needs the signature its references will carry.
      const query = !streamFormatOf(file)
        ? ''
        : trusted
          ? deliveryQueryString({ expires: Number(expires), signature }).slice(1)
          : this.#library.streamQuery(record, conversion, options.expiresIn);
      const result = await this.#library.streamFile(record, conversion, file, {
        query,
        mode: options.mode,
        signedTtlSeconds: options.signedTtlSeconds,
      });

      if (result.kind === 'manifest') {
        response.header('cache-control', cacheControl);
        response.header('content-type', result.contentType);
        return response.send(result.content);
      }
      if (result.kind === 'redirect') {
        response.header('cache-control', cacheControl);
        return response.redirect(result.url);
      }
      response.header('cache-control', options.segmentCacheControl ?? 'private, max-age=86400');
      response.header('content-type', result.mimeType);
      if (result.size !== undefined) response.header('content-length', String(result.size));
      return response.stream(result.stream);
    } catch (error) {
      return answerError(error, response);
    }
  }

  /**
   * A ready AdonisJS route handler for HLS/DASH packages — the read side of `transformers.video()`:
   *
   * ```ts
   * const serveStream = media.access.streamRoute()
   * router.get('/media/:id/stream/:conversion/*', serveStream)
   * ```
   *
   * The URL mirrors the package: `/media/<id>/stream/<conversion>/<file>`, so the relative
   * references a manifest stores resolve back to this same route. See {@link serveStream}.
   */
  streamRoute(
    options: MediaStreamRouteOptions = {},
  ): (ctx: StreamRouteContext) => Promise<unknown> {
    return (ctx) => {
      const wildcard = ctx.params['*'];
      const file = Array.isArray(wildcard)
        ? wildcard.map(String).join('/')
        : String(ctx.params.file ?? wildcard ?? '');
      return this.serveStream(
        ctx,
        String(ctx.params.id ?? ''),
        String(ctx.params.conversion ?? ''),
        file,
        options,
      );
    };
  }

  /**
   * Authorize and answer one media read — the core of {@link deliveryRoute}, for a controller that
   * finds the record its own way (a stable `/profiles/:id/photo` URL, a record looked up by its
   * owner):
   *
   * ```ts
   * async show(ctx) {
   *   const [avatar] = await media.library.list('User', ctx.params.id, 'avatar')
   *   return media.access.serve(ctx, avatar, { authorize: canSeeProfile })
   * }
   * ```
   *
   * `target` is the record, its id, or `null`/`undefined` (answered 404). Everything else is as in
   * {@link deliveryRoute}: the read is authorized unless the URL carries a valid signature, the query
   * (`?conversion`, `?w`, `?q`, `?exp`, `?sig`) and `Accept` are honoured, the file is redirected or
   * streamed with its headers, and the library's errors are answered as HTTP.
   */
  async serve(
    ctx: DeliveryRouteContext,
    target: MediaRecord | string | null | undefined,
    options: Omit<MediaDeliveryRouteOptions, 'param'> = {},
  ): Promise<unknown> {
    const { request, response } = ctx;
    const cacheControl = options.cacheControl ?? 'private, max-age=60';
    try {
      const record =
        typeof target === 'string' ? await this.#library.find(target) : (target ?? null);
      if (!record) throw new MediaNotFoundError(typeof target === 'string' ? target : '');
      const id = record.id;

      const qs = request.qs();
      const signed = {
        mediaId: id,
        conversion: stringParam(qs.conversion),
        width: stringParam(qs.w),
        quality: stringParam(qs.q),
        expires: stringParam(qs.exp),
        signature: stringParam(qs.sig),
      };
      // A valid signature is a prior authorization; an invalid or expired one is refused
      // (DeliverySignatureError). Unsigned requests are this caller's to authorize.
      const trusted = this.#library.checkDeliverySignature(signed, { required: false });
      if (!trusted) await this.authorize(ctx, 'read', record, options.authorize);

      const result = await this.#library.deliver(id, {
        ...(signed.conversion !== undefined ? { conversion: signed.conversion } : {}),
        ...(signed.width !== undefined && signed.width !== ''
          ? {
              width: signed.width,
              quality: signed.quality,
              accept: request.header('accept') ?? undefined,
            }
          : {}),
        ...(trusted ? { trusted: true } : {}),
        ...(options.mode !== undefined ? { mode: options.mode } : {}),
        ...(options.signedTtlSeconds !== undefined
          ? { signedTtlSeconds: options.signedTtlSeconds }
          : {}),
      });

      response.header('cache-control', cacheControl);
      if (result.vary) response.header('vary', result.vary);
      if (result.kind === 'redirect') return response.redirect(result.url);

      response.header('content-type', result.mimeType);
      if (result.size !== undefined) response.header('content-length', String(result.size));
      if (result.fileName) {
        response.header('content-disposition', inlineDisposition(result.fileName));
      }
      return response.stream(result.stream);
    } catch (error) {
      return answerError(error, response);
    }
  }

  /**
   * A ready AdonisJS route handler that serves a media record — the delivery route every app was
   * hand-writing:
   *
   * ```ts
   * const serveMedia = media.access.deliveryRoute({ authorize: authorizers.owner() })
   * router.get('/media/:id', serveMedia)
   * ```
   *
   * - authorizes the read (`authorize`, or the collection's `access.read`; neither ⇒ refused),
   *   unless the URL carries a valid `delivery.signing` signature — that signature IS the
   *   authorization the app made when it issued the URL;
   * - passes `?conversion`, `?w`, `?q`, `Accept`, `?exp`, `?sig` through (on-demand resize,
   *   format negotiation, signed URLs);
   * - redirects or streams per `delivery.mode`, with `Content-Type`, `Content-Length`,
   *   `Content-Disposition: inline`, `Cache-Control` (private by default) and `Vary: Accept`;
   * - answers the library's errors as HTTP: 404 (unknown record or conversion), 400 (size not
   *   allowed, not an image), 401/403 (not signed in / not allowed / bad signature).
   */
  deliveryRoute(
    options: MediaDeliveryRouteOptions = {},
  ): (ctx: DeliveryRouteContext) => Promise<unknown> {
    const param = options.param ?? 'id';
    return (ctx) => this.serve(ctx, String(ctx.params[param] ?? ''), options);
  }
}

/** Answer a library error as `{ code, message }` with its HTTP status; rethrow anything else. */
function answerError(error: unknown, response: DeliveryRouteContext['response']): unknown {
  const status = httpStatusOf(error);
  if (status === undefined) throw error;
  const { code, message } = error as { code: string; message: string };
  const replied = response.status(status) as { json?: (body: unknown) => unknown };
  return replied.json?.({ code, message });
}

/** The HTTP status for an error the delivery route answers itself; `undefined` ⇒ rethrow. */
function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof MediaAccessDeniedError) return error.status;
  if (error instanceof DeliverySignatureError) return 403;
  if (error instanceof MediaNotFoundError) return 404;
  if (error instanceof ConversionNotDefinedError) return 404;
  if (error instanceof TransformNotReadyError) return 404;
  if (error instanceof ConversionArtifactMissingError) return 404;
  if (error instanceof ImageSizeNotAllowedError) return 400;
  if (error instanceof NotAnImageError) return 400;
  return undefined;
}

function stringParam(value: unknown): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined || first === null) return undefined;
  return String(first);
}

/** `inline; filename="…"; filename*=UTF-8''…` — ASCII fallback plus the exact name (RFC 6266). */
function inlineDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  // RFC 5987 `attr-char` excludes ' ( ) * — which encodeURIComponent leaves alone; `'` would
  // even end the value early.
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
