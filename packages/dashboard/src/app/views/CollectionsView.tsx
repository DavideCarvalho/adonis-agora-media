import { useState } from 'react';
import type { CollectionFilter } from '../../types';
import { useCollections } from '../queries';
import { Empty, Panel, formatBytes, formatDate } from '../ui';

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

/**
 * The MediaStore library view: browses stored `MediaRecord`s across every owner and collection via the
 * cursor-paginated `/collections` route (backed by `MediaStore.list`). Filter by owner/collection/path
 * prefix; each row shows the owner, collection, size and the generated conversions on that record.
 */
export function CollectionsView() {
  const [draft, setDraft] = useState<CollectionFilter>(EMPTY_FILTER);
  const [applied, setApplied] = useState<CollectionFilter>(EMPTY_FILTER);

  const { items, isLoading, isError, error, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useCollections(applied);

  const apply = (event: React.FormEvent) => {
    event.preventDefault();
    setApplied(cleanFilter(draft));
  };

  const reset = () => {
    setDraft(EMPTY_FILTER);
    setApplied(EMPTY_FILTER);
  };

  return (
    <div className="stack">
      <form className="spread" onSubmit={apply}>
        <div className="toolbar" style={{ flexWrap: 'wrap' }}>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="filter-owner-type">Owner type</label>
            <input
              id="filter-owner-type"
              className="input"
              placeholder="e.g. Post"
              value={draft.ownerType ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, ownerType: e.target.value }))}
            />
          </div>
          <div className="field" style={{ minWidth: 120 }}>
            <label htmlFor="filter-owner-id">Owner id</label>
            <input
              id="filter-owner-id"
              className="input"
              placeholder="e.g. 42"
              value={draft.ownerId ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, ownerId: e.target.value }))}
            />
          </div>
          <div className="field" style={{ minWidth: 150 }}>
            <label htmlFor="filter-collection">Collection</label>
            <input
              id="filter-collection"
              className="input"
              placeholder="e.g. gallery"
              value={draft.collection ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, collection: e.target.value }))}
            />
          </div>
          <div className="field" style={{ minWidth: 180 }}>
            <label htmlFor="filter-prefix">Path prefix</label>
            <input
              id="filter-prefix"
              className="input mono"
              placeholder="e.g. Post/42/"
              value={draft.prefix ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, prefix: e.target.value }))}
            />
          </div>
        </div>
        <div className="toolbar">
          <button type="button" className="btn" onClick={reset}>
            Reset
          </button>
          <button type="submit" className="btn primary">
            Apply
          </button>
        </div>
      </form>

      <Panel title="Stored media">
        {isLoading ? (
          <Empty>Loading records…</Empty>
        ) : isError ? (
          <Empty>Failed to list records: {(error as Error)?.message}</Empty>
        ) : items.length === 0 ? (
          <Empty>No media records match this filter.</Empty>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Owner</th>
                  <th>Collection</th>
                  <th>Conversions</th>
                  <th>Size</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {items.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <span className="row-name">
                        <span className="mono">{m.name}</span>
                      </span>
                      <div className="muted mono" style={{ fontSize: '0.72rem' }}>
                        {m.path}
                      </div>
                    </td>
                    <td className="mono">
                      {m.ownerType}
                      <span className="muted"> · {m.ownerId}</span>
                    </td>
                    <td>{m.collection}</td>
                    <td>
                      {m.conversions.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <div className="chips">
                          {m.conversions.map((c) => (
                            <span key={c} className="chip">
                              {c}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="tnum">{formatBytes(m.sizeBytes)}</td>
                    <td className="tnum muted">{formatDate(m.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {hasNextPage && (
              <div style={{ paddingTop: '0.75rem' }}>
                <button
                  type="button"
                  className="btn"
                  disabled={isFetchingNextPage}
                  onClick={() => fetchNextPage()}
                >
                  {isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
