import type { ReactNode } from 'react';
import type { Route } from '../hash-route';
import { navigate } from '../hash-route';
import { useAbortUpload, useTopology, useUploadDetail, useUploads } from '../queries';
import { Bar, Button, Dot, Empty, formatBytes, Panel, relativeAge } from '../ui';

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="mono text-[10px] uppercase tracking-wider text-zinc-600">{label}</dt>
      <dd className="text-zinc-200">{children}</dd>
    </>
  );
}

/** Full detail of one resumable upload session: offset/size/parts, plus a cancel action when
 *  actions are enabled — ported to visual parity with the NestJS sibling console's
 *  `UploadDetailView`. */
function UploadDetail({ uploadId }: { uploadId: string }) {
  const detail = useUploadDetail(uploadId);
  const topology = useTopology();
  const abort = useAbortUpload();
  const actions = topology.data?.actions ?? false;

  async function cancel(): Promise<void> {
    await abort.mutateAsync(uploadId);
    navigate({ tab: 'uploads' });
  }

  return (
    <section className="rise">
      <button
        type="button"
        onClick={() => navigate({ tab: 'uploads' })}
        className="mono text-xs text-zinc-500 hover:text-zinc-300"
      >
        ← back
      </button>
      {detail.isLoading && <Empty>Loading upload…</Empty>}
      {detail.isError && <Empty>Failed to load upload.</Empty>}
      {detail.data && (
        <div className="mt-2">
          <Panel className="p-4">
            <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
              <DetailRow label="Key">
                <span className="mono truncate text-xs">{detail.data.upload.key}</span>
              </DetailRow>
              <DetailRow label="Disk">
                <span className="mono text-xs">{detail.data.upload.disk}</span>
              </DetailRow>
              <DetailRow label="Progress">
                <div className="flex items-center gap-2">
                  <Bar percent={detail.data.upload.percent} />
                  <span className="mono tnum text-[10px] text-zinc-500">
                    {detail.data.upload.percent === null
                      ? `${formatBytes(detail.data.upload.offset)} · unknown size`
                      : `${detail.data.upload.percent}%`}
                  </span>
                </div>
              </DetailRow>
              <DetailRow label="Offset">
                <span className="mono tnum text-xs">{detail.data.upload.offset}</span>
              </DetailRow>
              <DetailRow label="Size">
                <span className="mono tnum text-xs">{detail.data.upload.size ?? 'unknown'}</span>
              </DetailRow>
              <DetailRow label="Multipart">{detail.data.upload.multipart ? 'yes' : 'no'}</DetailRow>
              <DetailRow label="Age">{relativeAge(detail.data.upload.createdAt)}</DetailRow>
            </dl>

            {actions && (
              <div className="mt-4">
                <Button
                  tone="destructive"
                  onClick={cancel}
                  disabled={abort.isPending}
                  title="Removes the resumable session so it stops here. An incomplete underlying multipart upload is reaped by the bucket lifecycle policy, not by this action."
                >
                  {abort.isPending ? 'Canceling…' : 'Cancel session'}
                </Button>
                {abort.isError && <p className="mt-2 text-xs s-error">Failed to cancel session.</p>}
              </div>
            )}
          </Panel>

          <h3 className="mono mb-1 mt-4 text-[10px] uppercase tracking-wider text-zinc-600">
            parts
          </h3>
          {detail.data.parts.length === 0 ? (
            <Empty>No parts uploaded yet.</Empty>
          ) : (
            <Panel className="overflow-hidden">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="mono border-b border-border text-[10px] uppercase tracking-wider text-zinc-600">
                    <th className="px-4 py-2 font-normal">Part</th>
                    <th className="px-4 py-2 font-normal">ETag</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {detail.data.parts.map((part) => (
                    <tr key={part.partNumber} className="hover:bg-zinc-900/40">
                      <td className="mono tnum px-4 py-2 text-xs text-zinc-300">
                        {part.partNumber}
                      </td>
                      <td className="mono px-4 py-2 text-xs text-zinc-500">{part.etag}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Live list of in-progress resumable uploads, polled every 2s from the session store
 * (`UploadSessionStore.list()` via the real `/uploads` route). Clicking a row drills into
 * {@link UploadDetail} — ported to visual parity with the NestJS sibling console's Uploads tab.
 */
export function UploadsView({ route }: { route: Route }) {
  const { data, isLoading, isError, error } = useUploads();
  const uploads = data?.uploads ?? [];

  if (route.uploadId) return <UploadDetail uploadId={route.uploadId} />;

  return (
    <section className="rise">
      <div className="mb-3 flex items-center gap-2">
        <Dot tone="live" pulse />
        <span className="mono text-[11px] text-zinc-500">
          Live resumable sessions · refreshed every 2s
        </span>
      </div>
      {isLoading ? (
        <Empty>Loading sessions…</Empty>
      ) : isError ? (
        <Empty>Failed to load uploads: {(error as Error)?.message}</Empty>
      ) : uploads.length === 0 ? (
        <Empty>No resumable uploads in progress.</Empty>
      ) : (
        <Panel className="overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="mono border-b border-border text-[10px] uppercase tracking-wider text-zinc-600">
                <th className="px-4 py-2 font-normal">Key</th>
                <th className="px-4 py-2 font-normal">Disk</th>
                <th className="px-4 py-2 font-normal">Progress</th>
                <th className="px-4 py-2 font-normal">Parts</th>
                <th className="px-4 py-2 font-normal">Age</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {uploads.map((upload) => (
                <tr key={upload.id} className="hover:bg-zinc-900/40">
                  <td className="max-w-xs truncate px-4 py-2">
                    <button
                      type="button"
                      onClick={() => navigate({ tab: 'uploads', uploadId: upload.id })}
                      className="mono text-xs text-zinc-200 hover:text-accent"
                    >
                      {upload.key}
                    </button>
                  </td>
                  <td className="mono px-4 py-2 text-xs text-zinc-400">{upload.disk}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <Bar percent={upload.percent} />
                      <span className="mono tnum text-[10px] text-zinc-500">
                        {upload.percent === null
                          ? `${formatBytes(upload.offset)} · unknown size`
                          : `${upload.percent}% · ${formatBytes(upload.offset)}/${formatBytes(upload.size)}`}
                      </span>
                    </div>
                  </td>
                  <td className="mono tnum px-4 py-2 text-xs text-zinc-400">{upload.parts}</td>
                  <td className="px-4 py-2 text-xs text-zinc-500">
                    {relativeAge(upload.createdAt) ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </section>
  );
}
