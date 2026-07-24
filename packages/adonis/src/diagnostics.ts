/**
 * The `@adonis-agora/diagnostics` emit capability, published on this global slot at that
 * package's module load. `@adonis-agora/media` reads it STRUCTURALLY — it never imports or
 * depends on the diagnostics package. When diagnostics isn't installed the slot is empty
 * and emitting is an inert no-op.
 */
const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (lib: string, event: string, payload: unknown) => void;

/**
 * The `@adonis-agora/diagnostics` trace capability, published on this global slot. Like
 * {@link EMIT_SLOT} it is read STRUCTURALLY — media never imports the diagnostics package.
 * A trace slot wraps a unit of work so an observer can time/inspect it; when no slot is
 * installed the wrapped function simply runs and its result (or error) passes through.
 */
const TRACE_SLOT = Symbol.for('@agora/diagnostics:trace');
type TraceFn = <T>(lib: string, event: string, fn: () => T, payload?: unknown) => T;

/**
 * Every media milestone published on `agora:media:<event>`. The single runtime source for the
 * {@link MediaDiagnosticEvent} union — a Telescope watcher iterates this to subscribe/claim.
 */
export const MEDIA_DIAGNOSTIC_EVENTS = [
  'attach',
  'delete',
  'conversion',
  'attachment.create',
  'attachment.delete',
  'upload.start',
  'upload.progress',
  'upload.complete',
  'upload.abort',
] as const;

export type MediaDiagnosticEvent = (typeof MEDIA_DIAGNOSTIC_EVENTS)[number];

/**
 * The claim registry, published by `@adonis-agora/diagnostics` under this global slot as a
 * reference-counted `Map<`${lib}:${event}`, number>`. Read STRUCTURALLY — same decoupling as
 * {@link EMIT_SLOT}: media never imports the diagnostics package. A lib-specific Telescope watcher
 * claims the channels it records here so the generic `DiagnosticsWatcher` skips them (its
 * `recordClaimed: false` default), avoiding double-recording. The raw convention is documented by
 * `@adonis-agora/diagnostics`' `claims.ts` precisely so a non-dependent package can participate.
 */
const CLAIMS_SLOT = Symbol.for('@agora/diagnostics:claims');

/** The shared claim registry, creating the slot Map on first claim (converges with the diagnostics package's own `globalSlot`, since a `Symbol.for` slot holds one instance). */
function claimsRegistry(): Map<string, number> {
  const g = globalThis as Record<symbol, unknown>;
  let registry = g[CLAIMS_SLOT] as Map<string, number> | undefined;
  if (registry === undefined) {
    registry = new Map<string, number>();
    g[CLAIMS_SLOT] = registry;
  }
  return registry;
}

/**
 * Claim `media:<event>` for every event, so the generic diagnostics→telescope bridge skips them.
 * Reference-counted (mirrors `@adonis-agora/diagnostics`' `claimDiagnostics`): claiming an already
 * claimed key increments its count; the returned release decrements, deleting the key only at zero.
 * Idempotent release.
 */
export function claimMediaDiagnostics(events: readonly string[]): () => void {
  const registry = claimsRegistry();
  const keys = events.map((event) => `media:${event}`);
  for (const key of keys) registry.set(key, (registry.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const key of keys) {
      const count = registry.get(key);
      if (count === undefined) continue;
      if (count <= 1) registry.delete(key);
      else registry.set(key, count - 1);
    }
  };
}

/** Whether `media:<event>` is currently claimed — the structural mirror of the diagnostics package's `isDiagnosticClaimed('media', event)`. */
export function isMediaDiagnosticClaimed(event: string): boolean {
  const registry = (globalThis as Record<symbol, unknown>)[CLAIMS_SLOT] as
    | Map<string, number>
    | undefined;
  return registry?.has(`media:${event}`) ?? false;
}

export interface AttachPayload {
  id: string;
  ownerType: string;
  ownerId: string;
  collection: string;
  disk: string;
  path: string;
  size: number;
  mimeType: string;
}
export interface DeletePayload {
  id: string;
  ownerType: string;
  ownerId: string;
}
export interface ConversionPayload {
  id: string;
  conversion: string;
  path: string;
}
export interface AttachmentCreatePayload {
  disk: string;
  path: string;
  size: number;
  mimeType: string;
  name: string;
  variants: string[];
}
export interface AttachmentDeletePayload {
  disk: string;
  path: string;
  variants: string[];
}
export interface UploadStartPayload {
  id: string;
  disk: string;
  key: string;
  mode: 'proxy' | 'direct';
  size?: number | undefined;
  contentType?: string | undefined;
}
export interface UploadProgressPayload {
  id: string;
  /** Bytes received so far (the resume offset). */
  offset: number;
  /** Number of chunk parts written so far. */
  parts: number;
  /** Total expected size in bytes, when known up front. */
  size?: number | undefined;
}
export interface UploadCompletePayload {
  id: string;
  disk: string;
  key: string;
}
export interface UploadAbortPayload {
  id: string;
  disk: string;
  key: string;
}

/** Maps each event to its payload type, so {@link publishMedia} is checked at the call site. */
export interface MediaDiagnosticPayloads {
  attach: AttachPayload;
  delete: DeletePayload;
  conversion: ConversionPayload;
  'attachment.create': AttachmentCreatePayload;
  'attachment.delete': AttachmentDeletePayload;
  'upload.start': UploadStartPayload;
  'upload.progress': UploadProgressPayload;
  'upload.complete': UploadCompletePayload;
  'upload.abort': UploadAbortPayload;
}

/**
 * Publish a media event on `agora:media:<event>` via the structural diagnostics slot.
 * No-op when diagnostics isn't installed (the slot is empty) — and it never throws back
 * into the library.
 */
export function publishMedia<E extends MediaDiagnosticEvent>(
  event: E,
  payload: MediaDiagnosticPayloads[E],
): void {
  const emit = (globalThis as Record<symbol, unknown>)[EMIT_SLOT] as EmitFn | undefined;
  if (typeof emit === 'function') {
    try {
      emit('media', event, payload);
    } catch {
      // diagnostics must never break a media operation
    }
  }
}

/**
 * Wrap a unit of media work in a structural trace span (`upload.policy.*` and friends). When a
 * diagnostics trace slot is installed it observes the call (lib hard-coded to `'media'`); otherwise
 * the wrapped function runs directly. Unlike {@link publishMedia}, errors are NOT swallowed — a
 * traced policy hook must surface its failure to the caller so the handler can map it.
 */
export function traceMedia<T>(event: string, fn: () => T, payload?: unknown): T {
  const trace = (globalThis as Record<symbol, unknown>)[TRACE_SLOT] as TraceFn | undefined;
  if (typeof trace === 'function') {
    return trace('media', event, fn, payload);
  }
  return fn();
}
