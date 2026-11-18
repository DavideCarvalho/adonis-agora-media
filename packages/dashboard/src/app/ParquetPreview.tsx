import { useQuery } from '@tanstack/react-query';
import { useDashboard } from './context';
import { FallbackCard } from './FallbackCard';
import type { PreviewItem } from './Lightbox';
import { readParquetPreview, unsupportedCodec } from './parquet-reader';
import { Empty, formatBytes } from './ui';

/** Parquet needs random access to its footer, so the preview reads the whole file — up to this. */
const PARQUET_MAX_BYTES = 25 * 1024 * 1024;

/** How many leading rows the Parquet preview decodes and shows. */
const PARQUET_PREVIEW_ROWS = 50;

/**
 * The Lightbox's Parquet tab: the schema (column names + types) and row count from the footer, then
 * the first rows as a table. Default export so the Lightbox can `React.lazy` it.
 */
export default function ParquetPreview({ item }: { item: PreviewItem }) {
  const { client } = useDashboard();
  const tooLarge = item.size > PARQUET_MAX_BYTES;
  const query = useQuery({
    queryKey: ['object-parquet-head', item.disk, item.key],
    queryFn: async () =>
      readParquetPreview(
        await client.objectBytes(item.disk, item.key, PARQUET_MAX_BYTES),
        PARQUET_PREVIEW_ROWS,
      ),
    enabled: !tooLarge,
    retry: false,
    staleTime: 60_000,
  });

  if (tooLarge) {
    return (
      <FallbackCard
        item={item}
        message={`Parquet preview reads files up to ${formatBytes(PARQUET_MAX_BYTES)}; this one is ${formatBytes(item.size)}.`}
      />
    );
  }
  if (query.isLoading) return <Empty>Loading…</Empty>;
  if (query.isError || !query.data) {
    const codec = unsupportedCodec(query.error);
    return (
      <FallbackCard
        item={item}
        message={
          codec
            ? `This file is compressed with ${codec}, which the preview can't decode (Snappy and uncompressed only).`
            : 'Could not read this Parquet file.'
        }
      />
    );
  }

  const { columns, rowCount, rows } = query.data;
  const caption =
    BigInt(rows.length) < rowCount
      ? `First ${rows.length} of ${rowCount.toLocaleString()} rows`
      : `${rowCount.toLocaleString()} ${rowCount === 1n ? 'row' : 'rows'}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <section aria-label="Schema" className="shrink-0">
        <div className="mb-1.5 flex items-baseline gap-2">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
            Schema
          </h3>
          <span className="mono tnum text-[10px] text-faint">
            {columns.length} {columns.length === 1 ? 'column' : 'columns'} ·{' '}
            {rowCount.toLocaleString()} {rowCount === 1n ? 'row' : 'rows'}
          </span>
        </div>
        <ul className="flex max-h-24 flex-wrap gap-1.5 overflow-auto">
          {columns.map((column) => (
            <li
              key={column.name}
              className="mono flex items-baseline gap-1.5 rounded-sm border border-border bg-panel-2 px-1.5 py-0.5 text-[11px]"
            >
              <span className="text-fg">{column.name}</span>
              <span className="text-dim">
                {column.type}
                {column.nullable ? '?' : ''}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {columns.length === 0 ? (
        <Empty>No columns.</Empty>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border">
          <table className="w-max min-w-full text-left text-xs">
            <caption className="sr-only">{caption}</caption>
            <thead className="sticky top-0 z-10 bg-popover">
              <tr className="border-b border-border">
                {columns.map((column) => (
                  <th
                    key={column.name}
                    scope="col"
                    className="mono whitespace-nowrap px-3 py-1.5 font-normal uppercase tracking-wider text-faint"
                  >
                    {column.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((cells, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: preview rows have no stable id
                <tr key={rowIndex} className="hover:bg-hover">
                  {cells.map((cell, cellIndex) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: table cells have no stable id
                      key={cellIndex}
                      title={cell ?? 'null'}
                      className="mono max-w-64 truncate whitespace-nowrap px-3 py-1 text-fg-2"
                    >
                      {cell === null ? <span className="italic text-faint">null</span> : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p aria-hidden className="mono tnum shrink-0 text-[10px] text-faint">
        {caption}
      </p>
    </div>
  );
}
