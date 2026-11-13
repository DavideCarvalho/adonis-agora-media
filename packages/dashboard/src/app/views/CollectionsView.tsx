import { useEffect, useState } from 'react';
import { type Column, DataTable } from '../../agora-kit/blocks/data-table';
import { EmptyState } from '../../agora-kit/blocks/empty-state';
import { ErrorBoundary, RegionError } from '../../agora-kit/blocks/error-boundary';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../../agora-kit/blocks/metric-card';
import { PageHeader, Toolbar } from '../../agora-kit/blocks/page-header';
import { LoadMore } from '../../agora-kit/blocks/pager';
import { Panel } from '../../agora-kit/blocks/panel';
import { QueryBoundary } from '../../agora-kit/blocks/query-boundary';
import { FilterIcon } from '../../agora-kit/icons';
import { PageBody } from '../../agora-kit/shell/app-shell';
import { Badge } from '../../agora-kit/ui/badge';
import { Button } from '../../agora-kit/ui/button';
import { Input } from '../../agora-kit/ui/input';
import { Skeleton } from '../../agora-kit/ui/skeleton';
import type {
  CollectionFilter,
  CollectionSummary,
  MediaDetailResponse,
  MediaEntry,
} from '../../types';
import { navigate, type Route } from '../hash-route';
import { ArrowLeftIcon, ExternalIcon, LayersIcon } from '../icons';
import {
  useCollections,
  useCollectionsSummary,
  useDeleteMediaRecord,
  useMediaRecord,
  useTopology,
} from '../queries';
import { tenantLabel, useShowsTenantColumn, useTenantPicker } from '../TenantPicker';
import { Empty, Field, formatBytes, formatDate, useToasts } from '../ui';

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

/** Set or clear `collection` on a filter without the `delete` operator. */
function withCollection(filter: CollectionFilter, key: string | undefined): CollectionFilter {
  const { collection: _dropped, ...rest } = filter;
  return key ? { ...rest, collection: key } : rest;
}

/* ── Summary ────────────────────────────────────────────────────────────────────────────────── */

/** Totals across every collection, presentational. */
export function CollectionMetrics({ collections }: { collections: CollectionSummary[] }) {
  const records = collections.reduce((sum, c) => sum + c.count, 0);
  const bytes = collections.reduce((sum, c) => sum + c.sumSize, 0);
  const largest = [...collections].sort((a, b) => b.sumSize - a.sumSize)[0];
  return (
    <MetricGrid>
      <MetricCard label="Records" value={records} caption="stored media" tone="brand" />
      <MetricCard label="Stored" value={formatBytes(bytes)} caption="originals, summed" />
      <MetricCard
        label="Collections"
        value={collections.length}
        caption="distinct keys"
        tone="violet"
      />
      <MetricCard
        label="Largest"
        value={largest ? formatBytes(largest.sumSize) : '—'}
        caption={largest ? largest.key : 'no records yet'}
      />
    </MetricGrid>
  );
}

/** One chip per collection (count · size), driving the `collection` filter. Presentational. */
export function CollectionChips({
  collections,
  selected,
  onSelect,
}: {
  collections: CollectionSummary[];
  selected: string | undefined;
  onSelect: (key: string | undefined) => void;
}) {
  if (collections.length === 0) return null;
  return (
    <Toolbar label="Collections">
      <Button
        variant="chip"
        size="chip"
        aria-pressed={selected === undefined}
        onClick={() => onSelect(undefined)}
      >
        all
      </Button>
      {collections.map((c) => (
        <Button
          key={c.key}
          variant="chip"
          size="chip"
          aria-pressed={selected === c.key}
          onClick={() => onSelect(c.key)}
        >
          {c.key}
          <span className="mono tnum text-[10.5px] text-faint">
            {c.count} · {formatBytes(c.sumSize)}
          </span>
        </Button>
      ))}
    </Toolbar>
  );
}

/* ── Record detail ──────────────────────────────────────────────────────────────────────────── */

function Fact({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">{label}</dt>
      <dd className={`min-w-0 truncate text-[12.5px] text-fg-2 ${mono ? 'mono text-xs' : ''}`}>
        {children}
      </dd>
    </>
  );
}

/** One stored record, presentational: its facts, delete, and its generated variants. */
export function RecordDetailBody({
  detail,
  deleting,
  deleteError,
  onDelete,
}: {
  detail: MediaDetailResponse;
  deleting: boolean;
  deleteError: string | undefined;
  onDelete: () => void;
}) {
  const { record, variants } = detail;
  return (
    <>
      <Panel
        title="Record"
        description={record.id}
        action={
          <Button variant="destructive" size="sm" onClick={onDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        }
      >
        <dl className="grid grid-cols-[96px_1fr] gap-x-4 gap-y-2.5 sm:grid-cols-[120px_1fr]">
          <Fact label="Collection">{record.collection}</Fact>
          <Fact label="Mime type" mono>
            {record.mimeType}
          </Fact>
          <Fact label="Size">{formatBytes(record.sizeBytes)}</Fact>
          <Fact label="Disk" mono>
            {record.disk}
          </Fact>
          <Fact label="Path" mono>
            {record.path}
          </Fact>
          <Fact label="Owner">
            {record.ownerType} · {record.ownerId}
          </Fact>
          <Fact label="Created">{formatDate(record.createdAt)}</Fact>
        </dl>
        {deleteError && <p className="mt-3 text-xs text-bad">{deleteError}</p>}
      </Panel>

      <Panel title="Variants" description={`${variants.length} generated`}>
        {variants.length === 0 ? (
          <Empty>No variants.</Empty>
        ) : (
          <div className="flex flex-wrap gap-3">
            {variants.map((variant) => (
              <div
                key={variant.name}
                className="flex flex-col gap-2 rounded-md border border-border bg-panel-2 p-2.5"
              >
                <Badge variant="violet">{variant.name}</Badge>
                {isImage(record.mimeType) ? (
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
                    className="flex items-center gap-1 text-xs text-brand hover:underline [&_svg]:size-3"
                  >
                    Open
                    <ExternalIcon />
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}

/** Container: one stored record (`#/collections/<id>`). */
function RecordDetail({ recordId }: { recordId: string }) {
  const detail = useMediaRecord(recordId);
  const del = useDeleteMediaRecord();
  const { push } = useToasts();
  const [deleteError, setDeleteError] = useState<string | undefined>(undefined);

  async function handleDelete(): Promise<void> {
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
    <PageBody>
      <PageHeader
        title={detail.data?.record.fileName ?? 'Record'}
        description="A stored media record and its generated variants."
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate({ tab: 'collections' })}>
            <ArrowLeftIcon />
            Back to collections
          </Button>
        }
      />
      <QueryBoundary
        query={detail}
        label="Record"
        skeleton={
          <Panel title="Record">
            <div className="flex flex-col gap-3" aria-hidden>
              {['a', 'b', 'c', 'd', 'e'].map((k) => (
                <Skeleton key={k} className="h-3 w-2/3" />
              ))}
            </div>
          </Panel>
        }
      >
        {(data) => (
          <RecordDetailBody
            detail={data}
            deleting={del.isPending}
            deleteError={deleteError}
            onDelete={() => void handleDelete()}
          />
        )}
      </QueryBoundary>
    </PageBody>
  );
}

/* ── List ───────────────────────────────────────────────────────────────────────────────────── */

const FIELDS: {
  key: keyof CollectionFilter;
  id: string;
  label: string;
  placeholder: string;
  mono?: boolean;
}[] = [
  { key: 'ownerType', id: 'filter-owner-type', label: 'Owner type', placeholder: 'e.g. Post' },
  { key: 'ownerId', id: 'filter-owner-id', label: 'Owner id', placeholder: 'e.g. 42' },
  { key: 'collection', id: 'filter-collection', label: 'Collection', placeholder: 'e.g. gallery' },
  {
    key: 'prefix',
    id: 'filter-prefix',
    label: 'Path prefix',
    placeholder: 'e.g. Post/42/',
    mono: true,
  },
];

/** The owner / collection / prefix filter form, presentational. */
export function CollectionFilterForm({
  draft,
  onChange,
  onApply,
  onReset,
}: {
  draft: CollectionFilter;
  onChange: (next: CollectionFilter) => void;
  onApply: () => void;
  onReset: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onApply();
      }}
      className="flex flex-wrap items-end gap-3"
    >
      <div className="grid flex-1 grid-cols-2 gap-3 md:grid-cols-4">
        {FIELDS.map((f) => (
          <Field key={f.id} id={f.id} label={f.label}>
            <Input
              id={f.id}
              value={draft[f.key] ?? ''}
              placeholder={f.placeholder}
              onChange={(event) => onChange({ ...draft, [f.key]: event.target.value })}
              className={`h-8 text-[13px] ${f.mono ? 'mono' : ''}`}
            />
          </Field>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button type="button" variant="outline" onClick={onReset}>
          Reset
        </Button>
        <Button type="submit">
          <FilterIcon />
          Apply
        </Button>
      </div>
    </form>
  );
}

/** The records table, presentational. */
export function RecordsTable({
  items,
  showTenant,
  tenantName,
  onOpen,
}: {
  items: MediaEntry[];
  showTenant: boolean;
  tenantName: (id: string) => string;
  onOpen: (id: string) => void;
}) {
  const columns: Column<MediaEntry>[] = [
    {
      id: 'name',
      header: 'Name',
      cell: (m) => (
        <div className="min-w-0 max-w-[22rem]">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onOpen(m.id);
            }}
            className="mono truncate text-left text-[12.5px] text-fg hover:text-brand"
          >
            {m.name}
          </button>
          <div className="mono mt-0.5 truncate text-[10.5px] text-faint">{m.path}</div>
        </div>
      ),
    },
    {
      id: 'owner',
      header: 'Owner',
      hideBelow: 'md',
      cell: (m) => (
        <span className="mono text-[11.5px]">
          {m.ownerType}
          <span className="text-faint"> · {m.ownerId}</span>
        </span>
      ),
    },
    ...(showTenant
      ? [
          {
            id: 'tenant',
            header: 'Organization',
            hideBelow: 'lg' as const,
            cell: (m: MediaEntry) => (
              <span className="mono text-[11px]">{m.tenantId ? tenantName(m.tenantId) : '—'}</span>
            ),
          },
        ]
      : []),
    {
      id: 'collection',
      header: 'Collection',
      cell: (m) => <Badge variant="violet">{m.collection}</Badge>,
    },
    {
      id: 'conversions',
      header: 'Conversions',
      hideBelow: 'lg',
      cell: (m) =>
        m.conversions.length === 0 ? (
          <span className="text-faint">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {m.conversions.map((c) => (
              <Badge key={c} variant="neutral">
                {c}
              </Badge>
            ))}
          </div>
        ),
    },
    {
      id: 'size',
      header: 'Size',
      align: 'right',
      hideBelow: 'sm',
      cell: (m) => <span className="mono tnum">{formatBytes(m.sizeBytes)}</span>,
    },
    {
      id: 'created',
      header: 'Created',
      align: 'right',
      hideBelow: 'md',
      cell: (m) => <span className="mono tnum text-faint">{formatDate(m.createdAt)}</span>,
    },
  ];
  return (
    <DataTable<MediaEntry>
      label="Stored media"
      columns={columns}
      rows={items}
      rowKey={(m) => m.id}
      onRowClick={(m) => onOpen(m.id)}
    />
  );
}

const SKELETON_COLUMNS: Column<never>[] = ['Name', 'Owner', 'Collection', 'Size'].map((header) => ({
  id: header,
  header,
  cell: () => null,
}));

/**
 * Collections (LIBRARY): the stored `MediaRecord`s across every owner and collection, via the
 * cursor-paged `/collections` route (`MediaStore.list`). Chips (count · size per collection) drive
 * the `collection` filter; owner/prefix filters compose with it; a row opens its detail.
 * Container: owns the summary and list queries; everything it renders is presentational.
 */
export function CollectionsView({ route }: { route: Route }) {
  const topology = useTopology();
  const summary = useCollectionsSummary();
  const picker = useTenantPicker();
  const showTenant = useShowsTenantColumn();
  const initial = withCollection(EMPTY_FILTER, route.collection);
  const [draft, setDraft] = useState<CollectionFilter>(initial);
  const [applied, setApplied] = useState<CollectionFilter>(initial);
  // A collection link (`#/collections?collection=…`, e.g. a search hit) followed while this view is
  // already open re-applies the filter.
  useEffect(() => {
    const next = withCollection(EMPTY_FILTER, route.collection);
    setDraft(next);
    setApplied(next);
  }, [route.collection]);

  const records = useCollections(applied);

  if (route.recordId) return <RecordDetail recordId={route.recordId} />;

  const collections = summary.data?.data ?? [];
  const listQuery = {
    data: records.data ? records.items : undefined,
    error: records.error,
    isPending: records.isPending,
    refetch: records.refetch,
  };

  return (
    <PageBody>
      <PageHeader
        title="Collections"
        description="Stored media records across every owner and collection, newest first."
      />
      <ErrorBoundary label="Collection totals">
        {summary.data ? (
          <CollectionMetrics collections={collections} />
        ) : summary.error ? (
          <RegionError
            title="Collection totals could not be loaded"
            error={summary.error}
            onRetry={() => void summary.refetch()}
          />
        ) : (
          <MetricGridSkeleton count={4} />
        )}
      </ErrorBoundary>

      <ErrorBoundary label="Filters">
        <div className="flex flex-col gap-3">
          <CollectionChips
            collections={collections}
            selected={applied.collection}
            onSelect={(key) => {
              setDraft((d) => withCollection(d, key));
              setApplied((a) => withCollection(a, key));
            }}
          />
          <CollectionFilterForm
            draft={draft}
            onChange={setDraft}
            onApply={() => setApplied(cleanFilter(draft))}
            onReset={() => {
              setDraft(EMPTY_FILTER);
              setApplied(EMPTY_FILTER);
            }}
          />
        </div>
      </ErrorBoundary>

      <Panel
        title="Stored media"
        description={
          topology.data && !topology.data.actions
            ? 'read-only console · delete is disabled'
            : records.data
              ? `${records.items.length} loaded`
              : undefined
        }
        flush
      >
        <QueryBoundary
          query={listQuery}
          label="Records"
          skeleton={<DataTable columns={SKELETON_COLUMNS} rows={undefined} rowKey={() => ''} />}
          isEmpty={(items) => items.length === 0}
          empty={
            <EmptyState
              icon={<LayersIcon />}
              title="No media records match this filter."
              description="Clear a filter, or attach media to a model to see it here."
            />
          }
        >
          {(items) => (
            <>
              <RecordsTable
                items={items}
                showTenant={showTenant}
                tenantName={(id) => tenantLabel(picker, id)}
                onOpen={(id) => navigate({ tab: 'collections', recordId: id })}
              />
              <LoadMore
                hasNext={records.hasNextPage}
                loading={records.isFetchingNextPage}
                onLoadMore={() => void records.fetchNextPage()}
                className="border-t border-border"
              />
            </>
          )}
        </QueryBoundary>
      </Panel>
    </PageBody>
  );
}
