import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from './ui';

/** Fixed body-row height (px). Windowing math and the spacer rows depend on every row being exactly
 *  this tall, so cells are single-line (`whitespace-nowrap`) and carry no vertical padding. */
const ROW_HEIGHT = 26;

/** Extra rows rendered above and below the viewport so a fast scroll never flashes blank. */
const OVERSCAN = 12;

type SortDir = 'asc' | 'desc';
interface SortState {
  index: number;
  dir: SortDir;
}

/** Compares two cells numerically when both parse as numbers, else as a natural-order string sort
 *  (so "row2" precedes "row10"). Empty cells sort as strings. */
function compareCells(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  const bothNumeric =
    left.trim() !== '' &&
    right.trim() !== '' &&
    !Number.isNaN(leftNumber) &&
    !Number.isNaN(rightNumber);
  if (bothNumeric) return leftNumber - rightNumber;
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * A scrollable, windowed data grid for the Lightbox's CSV/TSV preview tab. Ported to visual parity
 * with the NestJS sibling console's `DataTable.tsx`. Each column header both sorts (click to cycle
 * asc → desc → off) and filters (a per-column substring box); a global box filters across every
 * column. Only the rows in view are rendered — the body is windowed with top/bottom spacer rows — so
 * a many-thousand-row file scrolls without mounting every `<tr>`.
 */
export function DataTable({ header, body }: { header: string[]; body: string[][] }) {
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnFilters, setColumnFilters] = useState<Record<number, string>>({});
  const [sort, setSort] = useState<SortState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  // Track the scroll viewport's height so the visible window is sized to whatever the modal gives us.
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setViewportHeight(node.clientHeight));
    observer.observe(node);
    setViewportHeight(node.clientHeight);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => {
    const needle = globalFilter.trim().toLowerCase();
    const activeColumns = Object.entries(columnFilters)
      .map(([index, value]) => [Number(index), value.trim().toLowerCase()] as const)
      .filter(([, value]) => value !== '');
    let result = body.filter((cells) => {
      if (needle && !cells.some((cell) => cell.toLowerCase().includes(needle))) return false;
      return activeColumns.every(([index, value]) =>
        (cells[index] ?? '').toLowerCase().includes(value),
      );
    });
    if (sort) {
      const direction = sort.dir === 'asc' ? 1 : -1;
      result = [...result].sort(
        (left, right) => direction * compareCells(left[sort.index] ?? '', right[sort.index] ?? ''),
      );
    }
    return result;
  }, [body, globalFilter, columnFilters, sort]);

  const total = rows.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const windowSize =
    (viewportHeight > 0 ? Math.ceil(viewportHeight / ROW_HEIGHT) : 40) + OVERSCAN * 2;
  const endIndex = Math.min(total, startIndex + windowSize);
  const topPad = startIndex * ROW_HEIGHT;
  const bottomPad = Math.max(0, (total - endIndex) * ROW_HEIGHT);
  const visible = rows.slice(startIndex, endIndex);

  const isFiltered =
    globalFilter.trim() !== '' || Object.values(columnFilters).some((value) => value.trim() !== '');
  const hasControls = sort !== null || isFiltered;

  function toggleSort(index: number): void {
    setSort((previous) => {
      if (!previous || previous.index !== index) return { index, dir: 'asc' };
      if (previous.dir === 'asc') return { index, dir: 'desc' };
      return null;
    });
  }

  function reset(): void {
    setSort(null);
    setColumnFilters({});
    setGlobalFilter('');
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="flex flex-1 items-center gap-1.5 rounded-md border border-border px-2">
          <span className="text-zinc-600">⌕</span>
          <input
            value={globalFilter}
            onChange={(event) => setGlobalFilter(event.target.value)}
            placeholder="filter all columns…"
            className="mono w-full bg-transparent py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-hidden"
          />
        </div>
        {hasControls && (
          <Button tone="ghost" onClick={reset} className="shrink-0 text-[10px]">
            reset
          </Button>
        )}
        <span className="mono tnum shrink-0 text-[10px] text-zinc-600">
          {total}
          {isFiltered ? ` / ${body.length}` : ''} {body.length === 1 ? 'row' : 'rows'}
        </span>
      </div>
      <div
        ref={scrollRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="min-h-0 flex-1 overflow-auto rounded-md border border-border"
      >
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr className="border-b border-border">
              {header.map((cell, index) => {
                const active = sort?.index === index;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: table header cells have no stable id
                  <th key={index} className="px-3 py-1.5 align-top">
                    <button
                      type="button"
                      onClick={() => toggleSort(index)}
                      className="mono flex max-w-full items-center gap-1 whitespace-nowrap uppercase tracking-wider text-zinc-500 transition-colors hover:text-zinc-200"
                    >
                      <span className="truncate">{cell}</span>
                      <span className="shrink-0 text-[9px] text-zinc-600">
                        {active ? (sort?.dir === 'asc' ? '▲' : '▼') : '↕'}
                      </span>
                    </button>
                    <input
                      value={columnFilters[index] ?? ''}
                      onChange={(event) =>
                        setColumnFilters((previous) => ({
                          ...previous,
                          [index]: event.target.value,
                        }))
                      }
                      placeholder="filter"
                      className="mono mt-1 w-full min-w-20 rounded-sm border border-border bg-transparent px-1 py-0.5 text-[10px] font-normal normal-case tracking-normal text-zinc-300 placeholder:text-zinc-700 focus:border-accent/40 focus:outline-hidden"
                    />
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {topPad > 0 && (
              <tr aria-hidden>
                <td colSpan={header.length} style={{ height: topPad }} />
              </tr>
            )}
            {visible.map((cells, rowIndex) => (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id; the windowed index is unique per render
                key={startIndex + rowIndex}
                style={{ height: ROW_HEIGHT }}
                className="hover:bg-zinc-900/40"
              >
                {header.map((_, cellIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: table cells have no stable id
                  <td key={cellIndex} className="mono whitespace-nowrap px-3 text-zinc-300">
                    {cells[cellIndex] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
            {bottomPad > 0 && (
              <tr aria-hidden>
                <td colSpan={header.length} style={{ height: bottomPad }} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
