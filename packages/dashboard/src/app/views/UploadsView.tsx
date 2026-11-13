import type { ReactNode } from 'react';
import { type Column, DataTable } from '../../agora-kit/blocks/data-table';
import { EmptyState } from '../../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../../agora-kit/blocks/error-boundary';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../../agora-kit/blocks/metric-card';
import { PageHeader } from '../../agora-kit/blocks/page-header';
import { Panel } from '../../agora-kit/blocks/panel';
import { QueryBoundary } from '../../agora-kit/blocks/query-boundary';
import { PageBody } from '../../agora-kit/shell/app-shell';
import { Badge } from '../../agora-kit/ui/badge';
import { Button } from '../../agora-kit/ui/button';
import { Skeleton } from '../../agora-kit/ui/skeleton';
import type { UploadDetailResponse, UploadInfo, UploadPart } from '../../types';
import type { Route } from '../hash-route';
import { navigate } from '../hash-route';
import { ArrowLeftIcon, TransferIcon } from '../icons';
import { useAbortUpload, useTopology, useUploadDetail, useUploads } from '../queries';
import { tenantLabel, useShowsTenantColumn, useTenantPicker } from '../TenantPicker';
import { Bar, Dot, formatBytes, relativeAge } from '../ui';

function progressText(upload: UploadInfo): string {
  return upload.percent === null
    ? `${formatBytes(upload.offset)} · unknown size`
    : `${upload.percent}% · ${formatBytes(upload.offset)}/${formatBytes(upload.size)}`;
}

function Progress({ upload }: { upload: UploadInfo }) {
  return (
    <div className="flex items-center gap-2">
      <Bar percent={upload.percent} className="w-20 md:w-28" />
      <span className="mono tnum text-[10.5px] text-faint">{progressText(upload)}</span>
    </div>
  );
}

/* ── Detail ─────────────────────────────────────────────────────────────────────────────────── */

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">{label}</dt>
      <dd className="min-w-0 truncate text-[12.5px] text-fg-2">{children}</dd>
    </>
  );
}

/** One upload session, presentational: metrics, the session's facts, its parts, a cancel action. */
export function UploadDetailBody({
  detail,
  actions,
  canceling,
  cancelFailed,
  onCancel,
}: {
  detail: UploadDetailResponse;
  actions: boolean;
  canceling: boolean;
  cancelFailed: boolean;
  onCancel: () => void;
}) {
  const { upload, parts } = detail;
  return (
    <>
      <MetricGrid>
        <MetricCard
          label="Progress"
          value={upload.percent === null ? '—' : `${upload.percent}%`}
          caption={upload.percent === null ? 'unknown total size' : 'of the declared size'}
          tone="brand"
        />
        <MetricCard
          label="Received"
          value={formatBytes(upload.offset)}
          caption={`offset ${upload.offset}`}
        />
        <MetricCard
          label="Size"
          value={formatBytes(upload.size)}
          caption={upload.size === null ? 'not declared' : `${upload.size} bytes`}
        />
        <MetricCard
          label="Parts"
          value={parts.length}
          caption={upload.multipart ? 'multipart' : 'single part'}
          tone="info"
        />
      </MetricGrid>

      <Panel
        title="Session"
        description={upload.id}
        action={
          actions ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={onCancel}
              disabled={canceling}
              title="Removes the resumable session so it stops here. An incomplete underlying multipart upload is reaped by the bucket lifecycle policy, not by this action."
            >
              {canceling ? 'Canceling…' : 'Cancel session'}
            </Button>
          ) : undefined
        }
      >
        <dl className="grid grid-cols-[96px_1fr] gap-x-4 gap-y-2.5 sm:grid-cols-[120px_1fr]">
          <DetailRow label="Key">
            <span className="mono text-xs">{upload.key}</span>
          </DetailRow>
          <DetailRow label="Disk">
            <span className="mono text-xs">{upload.disk}</span>
          </DetailRow>
          <DetailRow label="Progress">
            <Progress upload={upload} />
          </DetailRow>
          <DetailRow label="Offset">
            <span className="mono tnum text-xs">{upload.offset}</span>
          </DetailRow>
          <DetailRow label="Size">
            <span className="mono tnum text-xs">{upload.size ?? 'unknown'}</span>
          </DetailRow>
          <DetailRow label="Multipart">{upload.multipart ? 'yes' : 'no'}</DetailRow>
          <DetailRow label="Age">{relativeAge(upload.createdAt)}</DetailRow>
        </dl>
        {cancelFailed && <p className="mt-3 text-xs text-bad">Failed to cancel session.</p>}
      </Panel>

      <Panel title="Parts" description="uploaded so far" flush>
        <DataTable<UploadPart>
          label="Parts"
          rows={parts}
          rowKey={(part) => String(part.partNumber)}
          columns={[
            {
              id: 'part',
              header: 'Part',
              cell: (part) => <span className="mono tnum text-fg">{part.partNumber}</span>,
            },
            {
              id: 'etag',
              header: 'ETag',
              cell: (part) => <span className="mono text-[11px] text-faint">{part.etag}</span>,
            },
          ]}
          empty={
            <EmptyState
              title="No parts uploaded yet."
              description="Parts appear as the client sends them."
            />
          }
        />
      </Panel>
    </>
  );
}

function DetailSkeleton() {
  return (
    <>
      <MetricGridSkeleton count={4} />
      <Panel title="Session">
        <div className="flex flex-col gap-3" aria-hidden>
          {['a', 'b', 'c', 'd'].map((k) => (
            <Skeleton key={k} className="h-3 w-2/3" />
          ))}
        </div>
      </Panel>
    </>
  );
}

/** Container: one upload session (`#/uploads/<id>`). */
function UploadDetail({ uploadId }: { uploadId: string }) {
  const detail = useUploadDetail(uploadId);
  const topology = useTopology();
  const abort = useAbortUpload();

  async function cancel(): Promise<void> {
    await abort.mutateAsync(uploadId);
    navigate({ tab: 'uploads' });
  }

  return (
    <PageBody>
      <PageHeader
        title={
          <span className="mono break-all text-base">{detail.data?.upload.key ?? 'Upload'}</span>
        }
        description="One resumable upload session."
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate({ tab: 'uploads' })}>
            <ArrowLeftIcon />
            Back
          </Button>
        }
      />
      <QueryBoundary query={detail} label="Upload" skeleton={<DetailSkeleton />}>
        {(data) => (
          <UploadDetailBody
            detail={data}
            actions={topology.data?.actions ?? false}
            canceling={abort.isPending}
            cancelFailed={abort.isError}
            onCancel={() => void cancel().catch(() => undefined)}
          />
        )}
      </QueryBoundary>
    </PageBody>
  );
}

/* ── List ───────────────────────────────────────────────────────────────────────────────────── */

/** The sessions table, presentational. */
export function UploadsTable({
  uploads,
  showTenant,
  tenantName,
  onOpen,
}: {
  uploads: UploadInfo[];
  showTenant: boolean;
  tenantName: (id: string) => string;
  onOpen: (id: string) => void;
}) {
  const columns: Column<UploadInfo>[] = [
    {
      id: 'key',
      header: 'Key',
      className: 'max-w-[18rem] truncate',
      cell: (u) => <span className="mono text-[12px] text-fg">{u.key}</span>,
    },
    ...(showTenant
      ? [
          {
            id: 'tenant',
            header: 'Organization',
            hideBelow: 'md' as const,
            cell: (u: UploadInfo) => (
              <span className="mono text-[11px]">{u.tenantId ? tenantName(u.tenantId) : '—'}</span>
            ),
          },
        ]
      : []),
    {
      id: 'disk',
      header: 'Disk',
      hideBelow: 'sm',
      cell: (u) => <Badge variant="neutral">{u.disk}</Badge>,
    },
    { id: 'progress', header: 'Progress', cell: (u) => <Progress upload={u} /> },
    {
      id: 'parts',
      header: 'Parts',
      hideBelow: 'md',
      align: 'right',
      cell: (u) => <span className="mono tnum">{u.parts}</span>,
    },
    {
      id: 'age',
      header: 'Age',
      hideBelow: 'sm',
      align: 'right',
      cell: (u) => <span className="mono tnum text-faint">{relativeAge(u.createdAt)}</span>,
    },
  ];
  return (
    <DataTable<UploadInfo>
      label="Upload sessions"
      columns={columns}
      rows={uploads}
      rowKey={(u) => u.id}
      onRowClick={(u) => onOpen(u.id)}
    />
  );
}

function UploadMetrics({ uploads }: { uploads: UploadInfo[] }) {
  const received = uploads.reduce((sum, u) => sum + u.offset, 0);
  const multipart = uploads.filter((u) => u.multipart).length;
  const unknown = uploads.filter((u) => u.percent === null).length;
  return (
    <MetricGrid>
      <MetricCard
        label="In progress"
        value={uploads.length}
        caption="resumable sessions"
        tone="brand"
      />
      <MetricCard label="Received" value={formatBytes(received)} caption="across every session" />
      <MetricCard label="Multipart" value={multipart} caption="split into parts" tone="info" />
      <MetricCard
        label="Unknown size"
        value={unknown}
        caption="no declared length"
        tone={unknown > 0 ? 'warn' : 'default'}
      />
    </MetricGrid>
  );
}

/**
 * Uploads (TRANSFERS): the resumable sessions in progress, polled every 2s from the session store
 * (`UploadSessionStore.list()` via `/uploads`). A row opens {@link UploadDetail}. Container: owns
 * the poll; the table and metrics are presentational.
 */
export function UploadsView({ route }: { route: Route }) {
  const uploads = useUploads();
  const picker = useTenantPicker();
  const showTenant = useShowsTenantColumn();

  if (route.uploadId) return <UploadDetail uploadId={route.uploadId} />;

  return (
    <PageBody>
      <PageHeader
        title="Uploads"
        description="Resumable sessions in progress, refreshed every 2 seconds."
        actions={
          <span className="mono flex items-center gap-1.5 text-[11px] text-dim">
            <Dot tone="live" pulse />
            live
          </span>
        }
      />
      <ErrorBoundary label="Upload metrics">
        {uploads.data ? (
          <UploadMetrics uploads={uploads.data.data} />
        ) : (
          <MetricGridSkeleton count={4} />
        )}
      </ErrorBoundary>
      <Panel title="Sessions" description="newest first" flush>
        <QueryBoundary
          query={uploads}
          label="Uploads"
          skeleton={<DataTable columns={SKELETON_COLUMNS} rows={undefined} rowKey={() => ''} />}
          isEmpty={(data) => data.data.length === 0}
          empty={
            <EmptyState
              icon={<TransferIcon />}
              title="No resumable uploads in progress."
              description="Sessions show up here while a client is sending a file."
            />
          }
        >
          {(data) => (
            <UploadsTable
              uploads={data.data}
              showTenant={showTenant}
              tenantName={(id) => tenantLabel(picker, id)}
              onOpen={(id) => navigate({ tab: 'uploads', uploadId: id })}
            />
          )}
        </QueryBoundary>
      </Panel>
    </PageBody>
  );
}

const SKELETON_COLUMNS: Column<never>[] = ['Key', 'Disk', 'Progress', 'Age'].map((header) => ({
  id: header,
  header,
  cell: () => null,
}));
