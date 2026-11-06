import { AssertionError } from 'node:assert';
import type { ImageProcessor } from '../image_processor.js';
import type { MediaLibrary } from '../media_library.js';
import type { MediaStore } from '../media_store.js';
import { type DiskVisibility, InMemoryDisk } from './in_memory_disk.js';

/**
 * The {@link MediaLibrary} methods a {@link MediaFake} records and lets you {@link MediaFake.stub}.
 * `for(...)` is not listed: its binding calls `attach`/`attachExisting`/`list` through the fake,
 * so those are what get recorded.
 */
export const MEDIA_FAKE_METHODS = [
  'attach',
  'attachExisting',
  'list',
  'find',
  'delete',
  'url',
  'deliver',
  'signedUrl',
  'ensureConversion',
  'transform',
] as const;

/** A {@link MediaLibrary} method name a {@link MediaFake} records. */
export type MediaFakeMethod = (typeof MEDIA_FAKE_METHODS)[number];

/** The arguments of one recorded call, typed per method (`signedUrl` → `[id, expiresIn, options?]`). */
export type MediaFakeCall<K extends MediaFakeMethod> = Parameters<MediaLibrary[K]>;

/** Every recorded call, per method, in call order. */
export type MediaFakeCalls = { readonly [K in MediaFakeMethod]: MediaFakeCall<K>[] };

/**
 * A replacement for one library method. May return the value or a promise of it, and may throw —
 * a synchronous throw still surfaces as a rejected promise, like the real method.
 */
export type MediaFakeStub<K extends MediaFakeMethod> = (
  ...args: MediaFakeCall<K>
) => Awaited<ReturnType<MediaLibrary[K]>> | ReturnType<MediaLibrary[K]>;

/** Options for `media.fake()`. */
export interface MediaFakeOptions {
  /**
   * Visibility every in-memory disk reports — drives `delivery.mode: 'auto'` (`private` → signed
   * redirect, `public` → public redirect, `unknown` → proxy stream). Default `private`.
   */
  visibility?: DiskVisibility;
  /** Store backing the fake. Default: a fresh `InMemoryMediaStore`. */
  store?: MediaStore;
  /** Image processor for conversions. Default: a fresh `FakeImageProcessor` (no sharp). */
  imageProcessor?: ImageProcessor;
}

/**
 * In-memory disks created on demand for ANY name, so every disk a config or collection names
 * resolves without listing them up front. `undefined` resolves to `defaultDisk`.
 */
export function lazyInMemoryDiskResolver(
  defaultDisk: string,
  visibility: DiskVisibility = 'private',
): { resolve: (name?: string) => InMemoryDisk; disks: Record<string, InMemoryDisk> } {
  const disks: Record<string, InMemoryDisk> = {};
  const resolve = (name?: string): InMemoryDisk => {
    const key = name ?? defaultDisk;
    disks[key] ??= new InMemoryDisk(`memory://${key}`, visibility);
    return disks[key];
  };
  return { resolve, disks };
}

function isFakeMethod(prop: string | symbol): prop is MediaFakeMethod {
  return typeof prop === 'string' && (MEDIA_FAKE_METHODS as readonly string[]).includes(prop);
}

/**
 * The handle `media.fake()` returns. While it is active, `media.library` (and `media.store`,
 * `media.storage`, `media.attachments`, …) run on real library code over in-memory doubles, and
 * every library call is recorded here.
 *
 * ```ts
 * const fake = media.fake()
 * await someCodeThatUploads()
 * fake.assertCalled('attach', (input) => input.collection === 'avatar')
 * assert.equal(fake.calls.signedUrl[0]?.[1], 300) // TTL
 * fake.stub('deliver', async () => ({ kind: 'redirect', url: 'https://x.test' }))
 * media.restore()
 * ```
 *
 * Built by `MediaManager.fake()`; not meant to be constructed directly.
 */
export class MediaFake {
  /** Recorded calls per method — the args tuple of each call, in order. Stubbed calls included. */
  readonly calls: MediaFakeCalls;
  /** The faked library — the very object `media.library` returns while this fake is active. */
  readonly library: MediaLibrary;
  /** The store backing the fake (an `InMemoryMediaStore` unless one was passed). */
  readonly store: MediaStore;
  /** In-memory disks created so far, by name (every name resolves; this lists the ones touched). */
  readonly disks: Record<string, InMemoryDisk>;

  readonly #resolve: (name?: string) => InMemoryDisk;
  readonly #stubs = new Map<MediaFakeMethod, (...args: never[]) => unknown>();
  readonly #onRestore: () => void;

  constructor(input: {
    library: MediaLibrary;
    store: MediaStore;
    resolve: (name?: string) => InMemoryDisk;
    disks: Record<string, InMemoryDisk>;
    onRestore: () => void;
  }) {
    this.store = input.store;
    this.disks = input.disks;
    this.#resolve = input.resolve;
    this.#onRestore = input.onRestore;
    this.calls = Object.fromEntries(
      MEDIA_FAKE_METHODS.map((method) => [method, []]),
    ) as unknown as MediaFakeCalls;
    this.library = this.#record(input.library);
  }

  /** The in-memory disk behind `name` (default disk when omitted) — inspect `.files` for bytes. */
  disk(name?: string): InMemoryDisk {
    return this.#resolve(name);
  }

  /**
   * Replace one library method for the rest of this fake (calls are still recorded). Use it to
   * force a result or an error the in-memory library would not produce on its own.
   */
  stub<K extends MediaFakeMethod>(method: K, implementation: MediaFakeStub<K>): this {
    this.#stubs.set(method, implementation as (...args: never[]) => unknown);
    return this;
  }

  /** Drop a {@link stub}, so the method runs the real in-memory library again. */
  unstub(method: MediaFakeMethod): this {
    this.#stubs.delete(method);
    return this;
  }

  /** Throws unless `method` was called (and, with `predicate`, called with matching args). */
  assertCalled<K extends MediaFakeMethod>(
    method: K,
    predicate?: (...args: MediaFakeCall<K>) => boolean,
  ): void {
    if (this.#matching(method, predicate).length > 0) return;
    throw new AssertionError({
      message: predicate
        ? `Expected media.library.${method} to be called with matching arguments`
        : `Expected media.library.${method} to be called`,
      actual: this.calls[method],
    });
  }

  /** Throws if `method` was called (or, with `predicate`, called with matching args). */
  assertNotCalled<K extends MediaFakeMethod>(
    method: K,
    predicate?: (...args: MediaFakeCall<K>) => boolean,
  ): void {
    const matching = this.#matching(method, predicate);
    if (matching.length === 0) return;
    throw new AssertionError({
      message: predicate
        ? `Expected media.library.${method} not to be called with matching arguments`
        : `Expected media.library.${method} not to be called`,
      actual: matching,
    });
  }

  /** Same as `media.restore()`, but a no-op once a newer fake has replaced this one. */
  restore(): void {
    this.#onRestore();
  }

  #matching<K extends MediaFakeMethod>(
    method: K,
    predicate?: (...args: MediaFakeCall<K>) => boolean,
  ): MediaFakeCall<K>[] {
    const calls = this.calls[method] as MediaFakeCall<K>[];
    return predicate ? calls.filter((args) => predicate(...args)) : calls;
  }

  /**
   * Wrap the library so the recorded methods log their args and honour stubs. A Proxy (rather than
   * a subclass) keeps the library's internal `this.x()` calls on the real object, so only calls
   * made from outside — the app's — are recorded. `for()` runs against the proxy so the binding's
   * `attach`/`list` are recorded too.
   */
  #record(library: MediaLibrary): MediaLibrary {
    const proxy: MediaLibrary = new Proxy(library, {
      get: (target, prop) => {
        if (prop === 'for') {
          return (ownerType: string, ownerId: string | number) =>
            target.for.call(proxy, ownerType, ownerId);
        }
        if (!isFakeMethod(prop)) return Reflect.get(target, prop, target);
        return (...args: unknown[]) => {
          (this.calls[prop] as unknown[][]).push(args);
          const stub = this.#stubs.get(prop) as ((...a: unknown[]) => unknown) | undefined;
          if (stub) return (async () => stub(...args))();
          return (target[prop] as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    return proxy;
  }
}
