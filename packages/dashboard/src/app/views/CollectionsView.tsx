import { useState } from 'react';
import type { CollectionFilter } from '../../types';
import { navigate, type Route } from '../hash-route';
import {
  useCollections,
  useCollectionsSummary,
  useDeleteMediaRecord,
  useMediaRecord,
  useTopology,
} from '../queries';
import { Button, Empty, formatBytes, formatDate, Panel, useToasts } from '../ui';

const EMPTY_FILTER: CollectionFilter = {};

/** Trim blank inputs so empty fields don't narrow the query (the server `AND`s only present filters). */
function cleanFilter(draft: CollectionFilter): CollectionFilter {
  const filter: CollectionFilter = {};
  if (draft.collection?.trim()) filter.collection = draft.collection.trim();
  if (draft.ownerType?.trim()) filter.ownerType = draft.ownerType.trim();
  if (draft.ownerId?.trim()) filter.ownerId = draft.ownerId.trim();
  if (draft.prefix?.trim()) filter.prefix = draft.prefix.trim();
  return filter;
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/** Set or clear `collection` on a filter without the `delete` operator (avoids de-optimizing the
 *  object's shape). */
function withCollection(filter: CollectionFilter, key: string | undefined): CollectionFilter {
  const { collection: _dropped, ...rest } = filter;
  return key ? { ...rest, collection: key } : rest;
}

/** Chips summarizing each collection's record count + total size, driving the `collection` filter
 *  with one click. Styled like the NestJS sibling console's `CollectionsBar` (pill `Button`s, not a
 *  bespoke chip component). */
function CollectionsBar({
  selected,
  onSelect,
}: {
  selected: string | undefined;
  onSelect: (key: string | undefined) => void;
}) {
  const summary = useCollectionsSummary();
  const collections = summary.data?.collections ?? [];
  if (collections.length === 0) return null;
  return (
    <div className="mb-4 flex flex-wrap gap-1">
      <Button
        tone={selected === undefined ? 'selected' : 'quiet'}
        className="px-2.5 py-1 text-xs"
        onClick={() => onSelect(undefined)}
      >
        all
      </Button>
      {collections.map((c) => (
        <Button
          key={c.key}
          tone={selected === c.key ? 'selected' : 'quiet'}
          className="gap-2 px-2.5 py-1 text-xs"
          onClick={() => onSelect(c.key)}
        >
          {c.key}
          <span className="mono tnum text-zinc-600">
            {c.count} · {formatBytes(c.sumSize)}
          </span>
        </Button>
      ))}
    </div>
  );
}

/** Full detail of one stored record: metadata, a delete action, and its generated variants — ported
 *  to visual parity with the NestJS sibling console's `RecordDetail`. */
function RecordDetail({ route }: { route: Route }) {
  const recordId = route.recordId;
  const detail = useMediaRecord(recordId);
  const del = useDeleteMediaRecord();
  const { push } = useToasts();
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  async function handleDelete(): Promise<void> {
    if (!recordId) return;
    setDeleteError(undefined);
    try {
      await del.mutateAsync(recordId);
      push('Record deleted');
      navigate({ tab: 'collections' });
    } catch {
      setDeleteError('Delete failed (actions may be disabled)');
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => navigate({ tab: 'collections' })}
        className="mono text-xs text-zinc-500 hover:text-zinc-300"
      >
        ← back to collections
      </button>
      {detail.isLoading && <Empty>Loading record…</Empty>}
      {detail.isError && <p className="mt-3 text-sm s-error">Failed to load record.</p>}
      {detail.data && (
        <div className="mt-3">
          <Panel className="p-4">
            <h3 className="font-semibold text-zinc-100">{detail.data.record.fileName}</h3>
            <dl className="mt-3 grid grid-cols-[110px_1fr] gap-x-4 gap-y-2 text-xs">
              <dt className="mono text-[10px] uppercase tracking-wider text-zinc-600">
                Collection
              </dt>
              <dd className="truncate text-zinc-200">{detail.data.record.collection}</dd>
              <dt className="mono text-[10px] uppercase tracking-wider text-zinc-600">Mime type</dt>
              <dd className="mono truncate text-zinc-200">{detail.data.record.mimeType}</dd>
              <dt className="mono text-[10px] uppercase tracking-wider text-zinc-600">Size</dt>
              <dd className="truncate text-zinc-200">
                {formatBytes(detail.data.record.sizeBytes)}
              </dd>
              <dt className="mono text-[10px] uppercase tracking-wider text-zinc-600">Disk</dt>
              <dd className="mono truncate text-zinc-200">{detail.data.record.disk}</dd>
              <dt className="mono text-[10px] uppercase tracking-wider text-zinc-600">Path</dt>
              <dd className="mono truncate text-zinc-200">{detail.data.record.path}</dd>
              <dt className="mono text-[10px] uppercase tracking-wider text-zinc-600">Owner</dt>
              <dd className="truncate text-zinc-200">
                {detail.data.record.ownerType} · {detail.data.record.ownerId}
              </dd>
              <dt className="mono text-[10px] uppercase tracking-wider text-zinc-600">Created</dt>
              <dd className="truncate text-zinc-200">{formatDate(detail.data.record.createdAt)}</dd>
            </dl>
            <div className="mt-4">
              <Button tone="destructive" onClick={handleDelete} disabled={del.isPending}>
                {del.isPending ? 'Deleting…' : 'Delete'}
              </Button>
              {deleteError && <p className="mt-2 text-xs s-error">{deleteError}</p>}
            </div>
          </Panel>

          <h4 className="mono mb-2 mt-4 text-[10px] uppercase tracking-wider text-zinc-600">
            variants
          </h4>
          {detail.data.variants.length === 0 ? (
            <Empty>No variants.</Empty>
          ) : (
            <div className="flex flex-wrap gap-3">
              {detail.data.variants.map((variant) => (
                <div
                  key={variant.name}
                  className="rounded-lg border border-border bg-panel p-2 text-xs"
                >
                  <div className="mono mb-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
                    {variant.name}
                  </div>
                  {isImage(detail.data.record.mimeType) ? (
                    <img
                      src={variant.url}
                      alt={variant.name}
                      className="max-h-40 rounded-sm border border-border"
                    />
                  ) : (
                    <a
                      href={variant.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-accent hover:text-accent"
                    >
                      Open ↗
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FilterField({
  id,
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label htmlFor={id} className="flex min-w-[150px] flex-col gap-1">
      <span className="mono text-[10px] uppercase tracking-wider text-zinc-600">{label}</span>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...(placeholder ? { placeholder } : {})}
        className={`rounded-md border border-border bg-black/30 px-3 py-2 text-sm text-zinc-100 focus:border-accent/40 focus:outline-hidden ${mono ? 'mono' : ''}`}
      />
    </label>
  );
}

/**
 * The MediaStore library view: browses stored `MediaRecord`s across every owner and collection via the
 * cursor-paginated `/collections` route (backed by `MediaStore.list`). A chip bar (record count + size
 * per collection) drives the `collection` filter; owner/prefix filters compose with it. Clicking a row
 * opens its full detail (metadata, delete, generated variants).
 */
export function CollectionsView({ route }: { route: Route }) {
  const topology = useTopology();
  const [draft, setDraft] = useState<CollectionFilter>(EMPTY_FILTER);
  const [applied, setApplied] = useState<CollectionFilter>(EMPTY_FILTER);

  const { items, isLoading, isError, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useCollections(applied);

  if (route.recordId) return <RecordDetail route={route} />;

  const apply = (event: React.FormEvent) => {
    event.preventDefault();
    setApplied(cleanFilter(draft));
  };

  const reset = () => {
    setDraft(EMPTY_FILTER);
    setApplied(EMPTY_FILTER);
  };

  return (
    <section className="rise">
      <CollectionsBar
        selected={applied.collection}
        onSelect={(key) => {
          setDraft((d) => withCollection(d, key));
          setApplied((a) => withCollection(a, key));
        }}
      />

      <form onSubmit={apply} className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap gap-3">
          <FilterField
            id="filter-owner-type"
            label="Owner type"
            placeholder="e.g. Post"
            value={draft.ownerType ?? ''}
            onChange={(value) => setDraft((d) => ({ ...d, ownerType: value }))}
          />
          <FilterField
            id="filter-owner-id"
            label="Owner id"
            placeholder="e.g. 42"
            value={draft.ownerId ?? ''}
            onChange={(value) => setDraft((d) => ({ ...d, ownerId: value }))}
          />
          <FilterField
            id="filter-collection"
            label="Collection"
            placeholder="e.g. gallery"
            value={draft.collection ?? ''}
            onChange={(value) => setDraft((d) => ({ ...d, collection: value }))}
          />
          <FilterField
            id="filter-prefix"
            label="Path prefix"
            placeholder="e.g. Post/42/"
            mono
            value={draft.prefix ?? ''}
            onChange={(value) => setDraft((d) => ({ ...d, prefix: value }))}
          />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button type="button" onClick={reset}>
            Reset
          </Button>
          <Button type="submit" tone="accent">
            Apply
          </Button>
        </div>
      </form>

      <Panel className="p-3">
        <h3 className="mono mb-3 text-[10px] uppercase tracking-wider text-zinc-600">
          Stored media
        </h3>
        {isLoading ? (
          <Empty>Loading records…</Empty>
        ) : isError ? (
          <p className="text-sm s-error">Failed to list records: {(error as Error)?.message}</p>
        ) : items.length === 0 ? (
          <Empty>No media records match this filter.</Empty>
        ) : (
          <>
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="mono border-b border-border text-[10px] uppercase tracking-wider text-zinc-600">
                  <th className="py-2 pr-2 font-normal">Name</th>
                  <th className="py-2 pr-2 font-normal">Owner</th>
                  <th className="py-2 pr-2 font-normal">Collection</th>
                  <th className="py-2 pr-2 font-normal">Conversions</th>
                  <th className="py-2 pr-2 font-normal">Size</th>
                  <th className="py-2 pr-2 font-normal">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {items.map((m) => (
                  <tr key={m.id} className="hover:bg-zinc-900/40">
                    <td className="py-2 pr-2">
                      <button
                        type="button"
                        onClick={() => navigate({ tab: 'collections', recordId: m.id })}
                        className="flex items-center gap-2 text-zinc-200 hover:text-accent"
                      >
                        <span className="mono">{m.name}</span>
                      </button>
                      <div className="mono mt-0.5 text-[10px] text-zinc-600">{m.path}</div>
                    </td>
                    <td className="mono py-2 pr-2 text-xs text-zinc-400">
                      {m.ownerType}
                      <span className="text-zinc-600"> · {m.ownerId}</span>
                    </td>
                    <td className="py-2 pr-2 text-zinc-300">{m.collection}</td>
                    <td className="py-2 pr-2">
                      {m.conversions.length === 0 ? (
                        <span className="text-zinc-700">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {m.conversions.map((c) => (
                            <span
                              key={c}
                              className="mono rounded-full border border-border px-2 py-0.5 text-[10px] text-zinc-400"
                            >
                              {c}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="mono tnum py-2 pr-2 text-xs text-zinc-500">
                      {formatBytes(m.sizeBytes)}
                    </td>
                    <td className="tnum py-2 pr-2 text-xs text-zinc-600">
                      {formatDate(m.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hasNextPage && (
              <div className="mt-3">
                <Button disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>
                  {isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
      {topology.data && !topology.data.actions && (
        <p className="mono mt-2 text-[10px] text-zinc-600">
          Delete is disabled on a read-only console.
        </p>
      )}
    </section>
  );
}
