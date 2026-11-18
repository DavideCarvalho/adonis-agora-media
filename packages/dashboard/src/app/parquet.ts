/**
 * Parquet detection for the Lightbox. Only this stays in the console's main bundle: the preview
 * itself (`ParquetPreview.tsx`, `parquet-reader.ts` and `hyparquet`) is a lazy chunk loaded the
 * first time someone opens a Parquet file.
 */

const PARQUET_TYPES = new Set(['application/vnd.apache.parquet', 'application/x-parquet']);

/** Whether an object is a Parquet file, by content type or by a `.parquet` key/name. */
export function isParquet(item: { key: string; name: string; contentType?: string }): boolean {
  const type = item.contentType?.toLowerCase().split(';')[0]?.trim() ?? '';
  if (PARQUET_TYPES.has(type)) return true;
  return /\.parquet$/i.test(item.key) || /\.parquet$/i.test(item.name);
}
