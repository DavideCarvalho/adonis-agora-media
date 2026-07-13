import type { DashboardSpec } from './telescope-sdk.js';

/** Options for the media "Media" dashboard. */
export interface MediaDashboardOptions {
  /**
   * URL template for deep-linking a completed-upload row (a `LinkSpec.href` with `{key}` placeholders
   * filled from the row, e.g. `/media/uploads/{id}`). Omit to render plain ids with no link.
   */
  uploadHref?: string;
  /** URL template for deep-linking a conversion row, e.g. `/media/{id}`. Omit for plain ids. */
  conversionHref?: string;
}

/**
 * The "Media" overview dashboard — upload health up top (active / success rate / throughput), then
 * upload activity (over-time + recent completed uploads), then storage operations and conversions.
 * Pure data: panels bind to the `media.*` data providers by name; the `*Href` options add an optional
 * `LinkSpec` on the id column so a host media SPA can deep-link a row.
 */
export function mediaDashboard(opts: MediaDashboardOptions = {}): DashboardSpec {
  const uploadId = opts.uploadHref
    ? { key: 'id', label: 'Upload', link: { href: opts.uploadHref } }
    : { key: 'id', label: 'Upload' };
  const conversionId = opts.conversionHref
    ? { key: 'id', label: 'Media', link: { href: opts.conversionHref } }
    : { key: 'id', label: 'Media' };
  return {
    id: 'media.overview',
    label: 'Media',
    panels: [],
    sections: [
      {
        title: 'Uploads',
        cols: 3,
        panels: [
          {
            kind: 'stat',
            title: 'In-flight uploads',
            data: { provider: 'media.activeUploads' },
            spark: false,
          },
          {
            kind: 'gauge',
            title: 'Upload success rate',
            data: { provider: 'media.uploadSuccessRate' },
            max: 1,
            format: 'percent',
            thresholds: { warn: 0.98, bad: 0.95, direction: 'down-bad' },
          },
          {
            kind: 'stat',
            title: 'Throughput (completes/h)',
            data: { provider: 'media.uploadThroughput' },
            format: 'rate',
            spark: true,
          },
        ],
      },
      {
        title: 'Upload activity',
        cols: 2,
        panels: [
          {
            kind: 'timeseries',
            title: 'Uploads over time',
            data: { provider: 'media.uploadsOverTime' },
            series: ['started', 'completed', 'aborted'],
            style: 'stacked',
          },
          {
            kind: 'table',
            title: 'Recent completed uploads',
            data: { provider: 'media.recentUploads' },
            columns: [
              { key: 'time', label: 'Time' },
              uploadId,
              { key: 'disk', label: 'Disk' },
              { key: 'key', label: 'Key' },
            ],
          },
        ],
      },
      {
        title: 'Storage & conversions',
        cols: 3,
        panels: [
          {
            kind: 'timeseries',
            title: 'Storage operations',
            data: { provider: 'media.storageOpsOverTime' },
            series: ['attached', 'deleted'],
            style: 'stacked',
          },
          {
            kind: 'timeseries',
            title: 'Attachment activity',
            data: { provider: 'media.attachmentActivity' },
            series: ['created', 'deleted'],
            style: 'stacked',
          },
          {
            kind: 'timeseries',
            title: 'Conversions over time',
            data: { provider: 'media.conversionsOverTime' },
            series: ['conversions'],
            style: 'area',
          },
        ],
      },
      {
        title: 'Recent conversions',
        panels: [
          {
            kind: 'table',
            title: 'Recent conversions',
            data: { provider: 'media.recentConversions' },
            columns: [
              { key: 'time', label: 'Time' },
              conversionId,
              { key: 'conversion', label: 'Conversion' },
              { key: 'path', label: 'Path' },
            ],
          },
        ],
      },
    ],
  };
}
