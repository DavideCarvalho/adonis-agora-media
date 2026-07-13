import type { DataProvider, ExtensionContext, TelescopeEntryLike } from './telescope-sdk.js';

/**
 * The media "Media" dashboard data providers. Every provider here is ENTRY-BACKED: it aggregates the
 * `agora:media:*` lifecycle events that `@adonis-agora/media` emits through `@adonis-agora/diagnostics`
 * (via `src/diagnostics.ts`'s `publishMedia`) and that `@adonis-agora/telescope`'s generic diagnostics
 * watcher records — one entry per publish, stored as `type: 'diagnostic'`, `tag: 'lib:media'`, with the
 * media payload preserved verbatim under `content.payload`.
 *
 * No media-specific watcher is contributed: capture is entirely handled by the generic bridge, so the
 * extension only has to SURFACE the recorded history. This mirrors `@adonis-agora/durable/telescope`'s
 * entry-backed providers, and needs zero coupling to the media container internals.
 */

/** Newest-first cap on how many recorded media entries a provider scans. */
const ENTRY_LIMIT = 5_000;

/** Default rollup window: 24h. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The Telescope diagnostic-entry `content` the generic watcher produces for a media event. `event` is the
 * media event name (e.g. `upload.complete`); the media library's own payload is nested under `payload`.
 */
interface MediaEntryContent {
  event?: string;
  payload?: {
    id?: string;
    disk?: string;
    key?: string;
    path?: string;
    size?: number;
    conversion?: string;
    collection?: string;
    mimeType?: string;
  };
}

const contentOf = (e: TelescopeEntryLike): MediaEntryContent =>
  (e.content ?? {}) as MediaEntryContent;

const atOf = (e: TelescopeEntryLike): number => (e.createdAt ? +new Date(e.createdAt) : 0);

/** Fetch captured `agora:media:*` entries from Telescope storage (newest-first). */
async function fetchEntries(
  ctx: ExtensionContext,
  limit = ENTRY_LIMIT,
): Promise<TelescopeEntryLike[]> {
  return ctx.store.list({ type: 'diagnostic', tag: 'lib:media', limit });
}

function countEvent(entries: TelescopeEntryLike[], event: string): number {
  let n = 0;
  for (const e of entries) if (contentOf(e).event === event) n += 1;
  return n;
}

/** Split entries into current `(now-window, now]` and previous `(now-2window, now-window]`. */
function splitWindows(
  entries: TelescopeEntryLike[],
  windowMs: number,
  now: number,
): { current: TelescopeEntryLike[]; previous: TelescopeEntryLike[] } {
  if (windowMs <= 0) return { current: entries, previous: [] };
  const start = now - windowMs;
  const prevStart = start - windowMs;
  return {
    current: entries.filter((e) => atOf(e) > start && atOf(e) <= now),
    previous: entries.filter((e) => atOf(e) > prevStart && atOf(e) <= start),
  };
}

/** Build N equal-width time buckets spanning from the oldest entry to now, each starting empty. */
function timeBuckets<TRow extends Record<string, number>>(
  entries: TelescopeEntryLike[],
  count: number,
  emptyRow: () => TRow,
): { rows: Array<{ label: string } & TRow>; minTime: number; bucketSize: number } {
  const now = Date.now();
  let minTime = now;
  for (const e of entries) {
    const at = atOf(e) || now;
    if (at < minTime) minTime = at;
  }
  const span = Math.max(now - minTime, 1);
  const bucketSize = span / count;
  const rows = Array.from({ length: count }, (_, i) => ({
    label: new Date(minTime + i * bucketSize).toISOString().slice(11, 16),
    ...emptyRow(),
  }));
  return { rows, minTime, bucketSize };
}

function bucketIndexFor(
  e: TelescopeEntryLike,
  minTime: number,
  bucketSize: number,
  count: number,
): number {
  const at = atOf(e) || minTime;
  return Math.min(count - 1, Math.max(0, Math.floor((at - minTime) / bucketSize)));
}

// ─── Upload activity ────────────────────────────────────────────────────────

/**
 * Net in-flight uploads = `upload.start` − (`upload.complete` + `upload.abort`) over the window
 * (default 24h; `windowMs: 0` = all-time). Floored at 0. A cheap "how busy is the pipeline right now"
 * stat derived purely from the captured event stream — no live upload-session store is consulted.
 */
export function mediaActiveUploadsProvider(): DataProvider {
  return {
    name: 'media.activeUploads',
    async resolve(query, ctx) {
      const windowMs = Number(query?.windowMs ?? DAY_MS);
      const { current } = splitWindows(await fetchEntries(ctx), windowMs, Date.now());
      const started = countEvent(current, 'upload.start');
      const finished = countEvent(current, 'upload.complete') + countEvent(current, 'upload.abort');
      return { value: Math.max(0, started - finished) };
    },
  };
}

/** Upload success rate = complete / (complete + abort) over the window; 1 when no data. */
export function mediaUploadSuccessRateProvider(): DataProvider {
  return {
    name: 'media.uploadSuccessRate',
    async resolve(query, ctx) {
      const windowMs = Number(query?.windowMs ?? DAY_MS);
      const { current } = splitWindows(await fetchEntries(ctx), windowMs, Date.now());
      const completed = countEvent(current, 'upload.complete');
      const aborted = countEvent(current, 'upload.abort');
      const total = completed + aborted;
      return { value: total === 0 ? 1 : completed / total, min: 0, max: 1 };
    },
  };
}

/**
 * Upload throughput = completes/hour over the window (default 24h), with `delta` vs the prior window
 * and an 8-point spark.
 *
 * CAVEAT: `upload.progress` is high-frequency and is intentionally rolled up as a rate, not a byte
 * curve — direct (S3 presigned) completions carry no client-PUT byte count, so a bytes/s metric would
 * silently undercount. We report completes/hour (count-based).
 */
export function mediaUploadThroughputProvider(): DataProvider {
  return {
    name: 'media.uploadThroughput',
    async resolve(query, ctx) {
      const windowMs = Number(query?.windowMs ?? DAY_MS);
      const now = Date.now();
      const { current, previous } = splitWindows(await fetchEntries(ctx), windowMs, now);
      const hours = windowMs > 0 ? windowMs / (60 * 60 * 1000) : 1;
      const value = countEvent(current, 'upload.complete') / hours;
      const delta =
        previous.length > 0 ? value - countEvent(previous, 'upload.complete') / hours : undefined;
      const sparkBuckets = 8;
      const bucketMs = (windowMs > 0 ? windowMs : Math.max(now, 1)) / sparkBuckets;
      const bucketHours = bucketMs / (60 * 60 * 1000);
      const start = now - (windowMs > 0 ? windowMs : now);
      const spark = Array.from({ length: sparkBuckets }, (_, i) => {
        const from = start + i * bucketMs;
        const bucket = current.filter((e) => atOf(e) > from && atOf(e) <= from + bucketMs);
        return countEvent(bucket, 'upload.complete') / (bucketHours || 1);
      });
      return delta === undefined ? { value, spark } : { value, delta, spark };
    },
  };
}

/** Uploads over time — started/completed/aborted counts per bucket (`query.buckets ?? 24`). */
export function mediaUploadsOverTimeProvider(): DataProvider {
  return {
    name: 'media.uploadsOverTime',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const buckets = Math.max(1, Number(query?.buckets ?? 24));
      const { rows, minTime, bucketSize } = timeBuckets(entries, buckets, () => ({
        started: 0,
        completed: 0,
        aborted: 0,
      }));
      for (const e of entries) {
        const event = contentOf(e).event;
        if (event !== 'upload.start' && event !== 'upload.complete' && event !== 'upload.abort')
          continue;
        const row = rows[bucketIndexFor(e, minTime, bucketSize, buckets)];
        if (!row) continue;
        if (event === 'upload.start') row.started += 1;
        else if (event === 'upload.complete') row.completed += 1;
        else row.aborted += 1;
      }
      return { rows };
    },
  };
}

/** Recent completed uploads (newest first) as table rows: time, id, disk, key. */
export function mediaRecentUploadsProvider(): DataProvider {
  return {
    name: 'media.recentUploads',
    async resolve(query, ctx) {
      const limit = Math.min(200, Math.max(10, Number(query?.limit ?? 50)));
      const rows = (await fetchEntries(ctx))
        .filter((e) => contentOf(e).event === 'upload.complete')
        .sort((a, b) => atOf(b) - atOf(a))
        .slice(0, limit)
        .map((e) => {
          const p = contentOf(e).payload ?? {};
          return {
            time: atOf(e)
              ? `${new Date(atOf(e)).toISOString().replace('T', ' ').slice(0, 19)}Z`
              : '',
            id: p.id ?? '',
            disk: p.disk ?? '',
            key: p.key ?? '',
          };
        });
      return { rows };
    },
  };
}

// ─── Storage operations ───────────────────────────────────────────────────────

/** Storage operations over time — `attach` (writes) vs `delete` (removes) per bucket. */
export function mediaStorageOpsOverTimeProvider(): DataProvider {
  return {
    name: 'media.storageOpsOverTime',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const buckets = Math.max(1, Number(query?.buckets ?? 24));
      const { rows, minTime, bucketSize } = timeBuckets(entries, buckets, () => ({
        attached: 0,
        deleted: 0,
      }));
      for (const e of entries) {
        const event = contentOf(e).event;
        if (event !== 'attach' && event !== 'delete') continue;
        const row = rows[bucketIndexFor(e, minTime, bucketSize, buckets)];
        if (!row) continue;
        if (event === 'attach') row.attached += 1;
        else row.deleted += 1;
      }
      return { rows };
    },
  };
}

/**
 * Attachment create/delete activity over time.
 *
 * CAVEAT: column attachments have no inventory table — the events are the ONLY signal — so this shows
 * create/delete RATES, never a current count.
 */
export function mediaAttachmentActivityProvider(): DataProvider {
  return {
    name: 'media.attachmentActivity',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const buckets = Math.max(1, Number(query?.buckets ?? 24));
      const { rows, minTime, bucketSize } = timeBuckets(entries, buckets, () => ({
        created: 0,
        deleted: 0,
      }));
      for (const e of entries) {
        const event = contentOf(e).event;
        if (event !== 'attachment.create' && event !== 'attachment.delete') continue;
        const row = rows[bucketIndexFor(e, minTime, bucketSize, buckets)];
        if (!row) continue;
        if (event === 'attachment.create') row.created += 1;
        else row.deleted += 1;
      }
      return { rows };
    },
  };
}

// ─── Conversions ──────────────────────────────────────────────────────────────

/** Image conversion volume over time (the `conversion` event). */
export function mediaConversionsOverTimeProvider(): DataProvider {
  return {
    name: 'media.conversionsOverTime',
    async resolve(query, ctx) {
      const entries = await fetchEntries(ctx);
      const buckets = Math.max(1, Number(query?.buckets ?? 24));
      const { rows, minTime, bucketSize } = timeBuckets(entries, buckets, () => ({
        conversions: 0,
      }));
      for (const e of entries) {
        if (contentOf(e).event !== 'conversion') continue;
        const row = rows[bucketIndexFor(e, minTime, bucketSize, buckets)];
        if (row) row.conversions += 1;
      }
      return { rows };
    },
  };
}

/** Recent image conversions (newest first) as table rows: time, id, conversion, path. */
export function mediaRecentConversionsProvider(): DataProvider {
  return {
    name: 'media.recentConversions',
    async resolve(query, ctx) {
      const limit = Math.min(200, Math.max(10, Number(query?.limit ?? 50)));
      const rows = (await fetchEntries(ctx))
        .filter((e) => contentOf(e).event === 'conversion')
        .sort((a, b) => atOf(b) - atOf(a))
        .slice(0, limit)
        .map((e) => {
          const p = contentOf(e).payload ?? {};
          return {
            time: atOf(e)
              ? `${new Date(atOf(e)).toISOString().replace('T', ' ').slice(0, 19)}Z`
              : '',
            id: p.id ?? '',
            conversion: p.conversion ?? '',
            path: p.path ?? '',
          };
        });
      return { rows };
    },
  };
}
