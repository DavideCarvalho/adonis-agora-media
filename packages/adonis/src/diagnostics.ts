/**
 * The `@adonis-agora/diagnostics` emit capability, published on this global slot at that
 * package's module load. `@adonis-agora/media` reads it STRUCTURALLY — it never imports or
 * depends on the diagnostics package. When diagnostics isn't installed the slot is empty
 * and emitting is an inert no-op.
 */
const EMIT_SLOT = Symbol.for('@agora/diagnostics:emit');
type EmitFn = (lib: string, event: string, payload: unknown) => void;

export type MediaDiagnosticEvent =
  | 'attach'
  | 'delete'
  | 'conversion'
  | 'attachment.create'
  | 'attachment.delete';

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

/** Maps each event to its payload type, so {@link publishMedia} is checked at the call site. */
export interface MediaDiagnosticPayloads {
  attach: AttachPayload;
  delete: DeletePayload;
  conversion: ConversionPayload;
  'attachment.create': AttachmentCreatePayload;
  'attachment.delete': AttachmentDeletePayload;
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
