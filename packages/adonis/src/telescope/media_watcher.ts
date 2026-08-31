import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import {
  claimMediaDiagnostics,
  MEDIA_DIAGNOSTIC_EVENTS,
  type MediaDiagnosticEvent,
} from '../diagnostics.js';
import type { WatcherContext } from './telescope-sdk.js';

/**
 * Record every milestone, but NOT per-chunk `upload.progress` — that would flood the timeline.
 * Progress stays available on its channel for programmatic subscribers.
 */
const RECORDED_EVENTS: MediaDiagnosticEvent[] = MEDIA_DIAGNOSTIC_EVENTS.filter(
  (event) => event !== 'upload.progress',
);

/** The `agora:media:<event>` `node:diagnostics_channel` name — the cross-repo wire contract, replicated structurally (media never imports `@adonis-agora/diagnostics`). */
function mediaChannelName(event: string): string {
  return `agora:media:${event}`;
}

/** The `DiagnosticEvent` envelope shape published on a media channel (structural mirror). */
interface MediaDiagnosticEnvelope {
  event: string;
  ts?: number;
  traceId?: string;
  payload?: Record<string, unknown>;
}

/**
 * A media-specific Telescope watcher: records a richer, per-operation `media` entry for every
 * milestone `agora:media:*` event the library emits (uploads, conversions, attaches, deletes, …),
 * flattening the event's payload into structured content rather than storing the raw envelope like
 * the generic diagnostics bridge does.
 *
 * Zero coupling: media publishes via the structural `@adonis-agora/diagnostics` emit slot, this
 * subscribes to the same `node:diagnostics_channel` channels — neither package is imported.
 *
 * De-dup: `register()` CLAIMS every recorded channel via {@link claimMediaDiagnostics} (the
 * reference-counted `Symbol.for('@agora/diagnostics:claims')` registry), so the generic
 * `DiagnosticsWatcher` (its `recordClaimed: false` default) skips them and no event is recorded
 * twice. `upload.progress` is deliberately NOT claimed or recorded here. `dispose()` releases the
 * claim and detaches every subscription.
 *
 * The Adonis `TelescopeExtension` SDK doesn't itself accept watchers (its watchers are core and
 * emitter-based), so this is offered for standalone wiring by a host that wants the richer typed
 * entries — mirroring nestjs-media's `MediaWatcher`, "kept for standalone use".
 */
export class MediaWatcher {
  readonly type = 'media';
  private readonly disposers: Array<() => void> = [];

  /** Claim the recorded channels and start recording a richer `media` entry for each event. */
  register(ctx: WatcherContext): void {
    this.disposers.push(claimMediaDiagnostics(RECORDED_EVENTS));

    for (const event of RECORDED_EVENTS) {
      const channel = mediaChannelName(event);
      const onMessage = (message: unknown) => {
        const envelope = message as MediaDiagnosticEnvelope;
        if (envelope === null || typeof envelope !== 'object') return;
        ctx.record({
          type: this.type,
          content: {
            event: envelope.event,
            ...(envelope.ts !== undefined ? { ts: envelope.ts } : {}),
            ...(envelope.traceId !== undefined ? { traceId: envelope.traceId } : {}),
            ...(envelope.payload ?? {}),
          },
        });
      };
      subscribe(channel, onMessage);
      this.disposers.push(() => unsubscribe(channel, onMessage));
    }
  }

  /** Release the channel claims and detach every subscription (e.g. on shutdown). */
  dispose(): void {
    while (this.disposers.length) this.disposers.pop()?.();
  }
}
