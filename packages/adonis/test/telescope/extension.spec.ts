import { describe, expect, it } from 'vitest';
import { mediaDashboard } from '../../src/telescope/dashboard.js';
import {
  mediaActiveUploadsProvider,
  mediaConversionsOverTimeProvider,
  mediaRecentConversionsProvider,
  mediaRecentUploadsProvider,
  mediaStorageOpsOverTimeProvider,
  mediaUploadSuccessRateProvider,
  mediaUploadsOverTimeProvider,
} from '../../src/telescope/data-providers.js';
import { mediaTelescopeExtension } from '../../src/telescope/extension.js';
import type { ExtensionContext, TelescopeEntryLike } from '../../src/telescope/telescope-sdk.js';

/**
 * A captured `agora:media:<event>` diagnostic entry, exactly as `@adonis-agora/telescope`'s generic
 * diagnostics watcher records it: `content` is the `DiagnosticEntryContent` envelope with the media
 * payload nested under `content.payload`, filed as `type: 'diagnostic'`, `tag: 'lib:media'`.
 */
function entry(
  event: string,
  payload: Record<string, unknown> = {},
  createdAt = new Date(),
): TelescopeEntryLike {
  return { content: { v: 1, lib: 'media', event, ts: +createdAt, payload }, createdAt };
}

/** An ExtensionContext over a fixed list of captured media diagnostic entries. */
function makeCtx(entries: TelescopeEntryLike[] = []): ExtensionContext {
  return {
    store: {
      list: async (query) => {
        // Assert providers query the media diagnostics slice, not everything.
        expect(query).toMatchObject({ type: 'diagnostic', tag: 'lib:media' });
        return entries;
      },
    },
    container: { make: async () => undefined as never },
    config: {},
  };
}

describe('mediaTelescopeExtension registration', () => {
  it('is a plain structural object (no @adonis-agora/telescope import needed)', () => {
    const ext = mediaTelescopeExtension();
    expect(ext.name).toBe('media');
    // Capture is handled by the generic diagnostics watcher, so no watcher/entryType is contributed.
    expect(ext.entryTypes).toBeUndefined();
    expect(typeof ext.dashboards).toBe('function');
    expect(typeof ext.dataProviders).toBe('function');
  });

  it('registers the "Media" dashboard spec', () => {
    const ctx = makeCtx();
    const [dash] = mediaTelescopeExtension().dashboards?.(ctx) ?? [];
    expect(dash?.id).toBe('media.overview');
    expect(dash?.label).toBe('Media');
    // Every panel binds to a provider the extension also registers.
    const providerNames = new Set(
      (mediaTelescopeExtension().dataProviders?.(ctx) ?? []).map((p) => p.name),
    );
    const boundProviders = (dash?.sections ?? []).flatMap((s) =>
      s.panels.map((p) => p.data.provider),
    );
    for (const name of boundProviders) expect(providerNames.has(name)).toBe(true);
  });

  it('exposes the expected media data-provider channels', () => {
    const names = (mediaTelescopeExtension().dataProviders?.(makeCtx()) ?? []).map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'media.activeUploads',
        'media.uploadSuccessRate',
        'media.uploadThroughput',
        'media.uploadsOverTime',
        'media.recentUploads',
        'media.storageOpsOverTime',
        'media.attachmentActivity',
        'media.conversionsOverTime',
        'media.recentConversions',
      ]),
    );
  });

  it('emits a LinkSpec on the upload/conversion id column when hrefs are configured', () => {
    const dash = mediaDashboard({
      uploadHref: '/media/uploads/{id}',
      conversionHref: '/media/{id}',
    });
    const columns = (dash.sections ?? []).flatMap((s) =>
      s.panels.flatMap((p) => (p.kind === 'table' ? p.columns : [])),
    );
    const uploadCol = columns.find((c) => c.label === 'Upload');
    const conversionCol = columns.find((c) => c.label === 'Media');
    expect(uploadCol?.link).toEqual({ href: '/media/uploads/{id}' });
    expect(conversionCol?.link).toEqual({ href: '/media/{id}' });
  });

  it('omits the LinkSpec when no href is configured', () => {
    const dash = mediaDashboard();
    const columns = (dash.sections ?? []).flatMap((s) =>
      s.panels.flatMap((p) => (p.kind === 'table' ? p.columns : [])),
    );
    expect(columns.find((c) => c.label === 'Upload')?.link).toBeUndefined();
  });
});

describe('media diagnostics events map to telescope entry shapes', () => {
  it('recentUploads maps an upload.complete entry to a row (id/disk/key from payload)', async () => {
    const ctx = makeCtx([
      entry('upload.complete', { id: 'up-1', disk: 's3', key: 'photos/a.jpg' }),
      entry('upload.start', { id: 'up-2', disk: 's3', key: 'photos/b.jpg' }),
    ]);
    const res = (await mediaRecentUploadsProvider().resolve(undefined, ctx)) as {
      rows: Array<{ id: string; disk: string; key: string }>;
    };
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ id: 'up-1', disk: 's3', key: 'photos/a.jpg' });
  });

  it('uploadSuccessRate = complete / (complete + abort)', async () => {
    const ctx = makeCtx([
      entry('upload.complete'),
      entry('upload.complete'),
      entry('upload.complete'),
      entry('upload.abort'),
    ]);
    const res = (await mediaUploadSuccessRateProvider().resolve(undefined, ctx)) as {
      value: number;
    };
    expect(res.value).toBeCloseTo(0.75);
  });

  it('activeUploads = starts - (completes + aborts), floored at 0', async () => {
    const ctx = makeCtx([
      entry('upload.start'),
      entry('upload.start'),
      entry('upload.start'),
      entry('upload.complete'),
    ]);
    const res = (await mediaActiveUploadsProvider().resolve(undefined, ctx)) as { value: number };
    expect(res.value).toBe(2);
  });

  it('uploadsOverTime buckets started/completed/aborted', async () => {
    const ctx = makeCtx([entry('upload.start'), entry('upload.complete'), entry('upload.abort')]);
    const res = (await mediaUploadsOverTimeProvider().resolve({ buckets: 1 }, ctx)) as {
      rows: Array<{ started: number; completed: number; aborted: number }>;
    };
    const total = res.rows.reduce(
      (acc, r) => ({
        started: acc.started + r.started,
        completed: acc.completed + r.completed,
        aborted: acc.aborted + r.aborted,
      }),
      { started: 0, completed: 0, aborted: 0 },
    );
    expect(total).toEqual({ started: 1, completed: 1, aborted: 1 });
  });

  it('storageOpsOverTime buckets attach/delete', async () => {
    const ctx = makeCtx([entry('attach'), entry('attach'), entry('delete')]);
    const res = (await mediaStorageOpsOverTimeProvider().resolve({ buckets: 1 }, ctx)) as {
      rows: Array<{ attached: number; deleted: number }>;
    };
    expect(res.rows[0]).toMatchObject({ attached: 2, deleted: 1 });
  });

  it('conversion events surface in over-time and recent-conversions views', async () => {
    const ctx = makeCtx([
      entry('conversion', { id: 'm-1', conversion: 'thumb', path: 'photos/a-thumb.jpg' }),
    ]);
    const overTime = (await mediaConversionsOverTimeProvider().resolve({ buckets: 1 }, ctx)) as {
      rows: Array<{ conversions: number }>;
    };
    expect(overTime.rows[0]?.conversions).toBe(1);

    const recent = (await mediaRecentConversionsProvider().resolve(undefined, ctx)) as {
      rows: Array<{ id: string; conversion: string; path: string }>;
    };
    expect(recent.rows[0]).toMatchObject({
      id: 'm-1',
      conversion: 'thumb',
      path: 'photos/a-thumb.jpg',
    });
  });
});

describe('no-op when unconfigured / no telescope data', () => {
  it('providers degrade gracefully against an empty store', async () => {
    const ctx = makeCtx([]);
    expect(await mediaUploadSuccessRateProvider().resolve(undefined, ctx)).toMatchObject({
      value: 1,
    });
    expect(await mediaActiveUploadsProvider().resolve(undefined, ctx)).toMatchObject({ value: 0 });
    expect(await mediaRecentUploadsProvider().resolve(undefined, ctx)).toMatchObject({ rows: [] });
    expect(await mediaRecentConversionsProvider().resolve(undefined, ctx)).toMatchObject({
      rows: [],
    });
  });
});
