import { channel } from 'node:diagnostics_channel';
import { afterEach, describe, expect, it } from 'vitest';
import { isMediaDiagnosticClaimed } from '../../src/diagnostics.js';
import { MediaWatcher } from '../../src/telescope/media_watcher.js';
import type { TelescopeRecordInput } from '../../src/telescope/telescope-sdk.js';

/** The recorded (non-progress) media milestones the watcher claims + records. */
const RECORDED_EVENTS = [
  'attach',
  'delete',
  'conversion',
  'attachment.create',
  'attachment.delete',
  'upload.start',
  'upload.complete',
  'upload.abort',
] as const;

/** Publish a `DiagnosticEvent`-shaped envelope on `agora:media:<event>`, as the diagnostics emit slot would. */
function publish(event: string, payload: Record<string, unknown>): void {
  channel(`agora:media:${event}`).publish({ v: 1, ts: 111, lib: 'media', event, payload });
}

function ctx() {
  const recorded: TelescopeRecordInput[] = [];
  return { recorded, record: (entry: TelescopeRecordInput) => recorded.push(entry) };
}

let watcher: MediaWatcher | undefined;
afterEach(() => watcher?.dispose());

describe('MediaWatcher', () => {
  it('records a richer per-operation `media` entry (event + flattened payload) for a media op', () => {
    watcher = new MediaWatcher();
    const c = ctx();
    watcher.register(c);

    publish('attach', {
      id: 'm1',
      ownerType: 'Post',
      ownerId: '42',
      collection: 'gallery',
      disk: 'fs',
      path: 'Post/42/gallery/m1/a.png',
      size: 12,
      mimeType: 'image/png',
    });

    expect(c.recorded).toHaveLength(1);
    expect(c.recorded[0]).toEqual({
      type: 'media',
      content: {
        event: 'attach',
        ts: 111,
        id: 'm1',
        ownerType: 'Post',
        ownerId: '42',
        collection: 'gallery',
        disk: 'fs',
        path: 'Post/42/gallery/m1/a.png',
        size: 12,
        mimeType: 'image/png',
      },
    });
  });

  it('claims every recorded channel on register, but not upload.progress', () => {
    watcher = new MediaWatcher();
    watcher.register(ctx());

    for (const event of RECORDED_EVENTS) {
      expect(isMediaDiagnosticClaimed(event)).toBe(true);
    }
    expect(isMediaDiagnosticClaimed('upload.progress')).toBe(false);
  });

  it('releases every claim on dispose', () => {
    watcher = new MediaWatcher();
    watcher.register(ctx());
    watcher.dispose();
    watcher = undefined;

    for (const event of RECORDED_EVENTS) {
      expect(isMediaDiagnosticClaimed(event)).toBe(false);
    }
  });

  it('does not record the high-frequency upload.progress event, and stops after dispose', () => {
    watcher = new MediaWatcher();
    const c = ctx();
    watcher.register(c);

    publish('upload.progress', { id: 'm1', offset: 10, parts: 1 });
    expect(c.recorded).toHaveLength(0);

    watcher.dispose();
    watcher = undefined;
    publish('attach', { id: 'm2' });
    expect(c.recorded).toHaveLength(0);
  });
});
