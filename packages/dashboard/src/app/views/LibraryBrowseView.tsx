import { useMemo, useState } from 'react';
import type { DiskInfo, ObjectEntry } from '../../types';
import { navigate } from '../hash-route';
import { useCopy, useDelete, useDisks, useMove, useObjects, useTopology } from '../queries';
import { Bar, Empty, Modal, Panel, formatBytes, formatDate, useToasts } from '../ui';

interface Crumb {
  label: string;
  prefix: string | undefined;
}

function crumbsFor(disk: string, prefix: string | undefined): Crumb[] {
  const crumbs: Crumb[] = [{ label: disk, prefix: undefined }];
  if (!prefix) return crumbs;
  const parts = prefix.replace(/\/+$/, '').split('/').filter(Boolean);
  let acc = '';
  for (const part of parts) {
    acc += `${part}/`;
    crumbs.push({ label: part, prefix: acc });
  }
  return crumbs;
}

/**
 * The media-library browser: pick a disk (bucket), walk folders via the cursor-paginated `list`, and
 * (when actions are enabled) copy/move objects across buckets or delete them. Consumes the real
 * `/objects`, `/copy`, `/move`, `/delete` routes.
 */
export function LibraryBrowseView({ disk, prefix }: { disk?: string; prefix?: string }) {
  const disks = useDisks();
  const topology = useTopology();
  const actions = topology.data?.actions ?? false;

  const browsable = useMemo<DiskInfo[]>(
    () => (disks.data?.disks ?? []).filter((d) => d.capabilities.list),
    [disks.data],
  );
  const activeDisk = disk ?? browsable.find((d) => d.default)?.name ?? browsable[0]?.name;

  const {
    folders,
    files,
    isLoading,
    isError,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useObjects(activeDisk, prefix);

  const [transfer, setTransfer] = useState<{ mode: 'copy' | 'move'; entry: ObjectEntry } | null>(
    null,
  );
  const [toDelete, setToDelete] = useState<ObjectEntry | null>(null);

  if (disks.isLoading) return <Empty>Loading disks…</Empty>;
  if (browsable.length === 0)
    return <Empty>No list-capable disks are configured for the console.</Empty>;
  if (!activeDisk) return <Empty>Select a disk to browse.</Empty>;

  const crumbs = crumbsFor(activeDisk, prefix);

  return (
    <div className="stack">
      <div className="spread">
        <div className="field" style={{ minWidth: 200 }}>
          <label htmlFor="disk-select">Disk</label>
          <select
            id="disk-select"
            className="input"
            value={activeDisk}
            onChange={(e) => navigate({ tab: 'browse', disk: e.target.value })}
          >
            {browsable.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
                {d.default ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Panel
        title={
          <nav className="crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={c.prefix ?? '__root__'}>
                {i > 0 && <span className="sep">/</span>}{' '}
                <button
                  type="button"
                  className="linklike"
                  onClick={() =>
                    navigate({
                      tab: 'browse',
                      disk: activeDisk,
                      ...(c.prefix ? { prefix: c.prefix } : {}),
                    })
                  }
                >
                  {c.label}
                </button>
              </span>
            ))}
          </nav>
        }
      >
        {isLoading ? (
          <Empty>Loading objects…</Empty>
        ) : isError ? (
          <Empty>Failed to list objects: {(error as Error)?.message}</Empty>
        ) : folders.length === 0 && files.length === 0 ? (
          <Empty>This location is empty.</Empty>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Size</th>
                  <th>Last modified</th>
                  {actions && <th />}
                </tr>
              </thead>
              <tbody>
                {folders.map((f) => (
                  <tr key={f.prefix}>
                    <td>
                      <button
                        type="button"
                        className="linklike row-name"
                        onClick={() =>
                          navigate({ tab: 'browse', disk: activeDisk, prefix: f.prefix })
                        }
                      >
                        <span aria-hidden>📁</span> {f.name}
                      </button>
                    </td>
                    <td className="muted">—</td>
                    <td className="muted">—</td>
                    {actions && <td />}
                  </tr>
                ))}
                {files.map((file) => (
                  <tr key={file.key}>
                    <td className="mono">{file.name}</td>
                    <td className="tnum">{formatBytes(file.sizeBytes)}</td>
                    <td className="tnum muted">{formatDate(file.lastModified)}</td>
                    {actions && (
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() => setTransfer({ mode: 'copy', entry: file })}
                          >
                            Copy to…
                          </button>
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() => setTransfer({ mode: 'move', entry: file })}
                          >
                            Move to…
                          </button>
                          <button
                            type="button"
                            className="btn ghost danger"
                            onClick={() => setToDelete(file)}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    )}
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

      {transfer && (
        <TransferDialog
          mode={transfer.mode}
          entry={transfer.entry}
          fromDisk={activeDisk}
          disks={browsable}
          onClose={() => setTransfer(null)}
        />
      )}
      {toDelete && (
        <DeleteDialog disk={activeDisk} entry={toDelete} onClose={() => setToDelete(null)} />
      )}
    </div>
  );
}

function TransferDialog({
  mode,
  entry,
  fromDisk,
  disks,
  onClose,
}: {
  mode: 'copy' | 'move';
  entry: ObjectEntry;
  fromDisk: string;
  disks: DiskInfo[];
  onClose: () => void;
}) {
  const [toDisk, setToDisk] = useState(fromDisk);
  const [to, setTo] = useState(entry.key);
  const copy = useCopy();
  const move = useMove();
  const { push } = useToasts();
  const mutation = mode === 'copy' ? copy : move;

  const submit = async () => {
    try {
      await mutation.mutateAsync({ disk: fromDisk, from: entry.key, to, toDisk });
      push(`${mode === 'copy' ? 'Copied' : 'Moved'} ${entry.name}`);
      onClose();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };

  return (
    <Modal
      title={`${mode === 'copy' ? 'Copy' : 'Move'} object`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${mode === 'move' ? 'danger' : 'primary'}`}
            disabled={mutation.isPending}
            onClick={submit}
          >
            {mutation.isPending ? 'Working…' : mode === 'copy' ? 'Copy' : 'Move'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="to-disk">Destination disk</label>
        <select
          id="to-disk"
          className="input"
          value={toDisk}
          onChange={(e) => setToDisk(e.target.value)}
        >
          {disks.map((d) => (
            <option key={d.name} value={d.name}>
              {d.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="to-key">Destination key</label>
        <input
          id="to-key"
          className="input mono"
          value={to}
          onChange={(e) => setTo(e.target.value)}
        />
      </div>
    </Modal>
  );
}

function DeleteDialog({
  disk,
  entry,
  onClose,
}: { disk: string; entry: ObjectEntry; onClose: () => void }) {
  const del = useDelete();
  const { push } = useToasts();
  const submit = async () => {
    try {
      await del.mutateAsync({ disk, keys: [entry.key] });
      push(`Deleted ${entry.name}`);
      onClose();
    } catch (err) {
      push((err as Error).message, 'error');
    }
  };
  return (
    <Modal
      title="Delete object"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn danger" disabled={del.isPending} onClick={submit}>
            {del.isPending ? 'Deleting…' : 'Delete'}
          </button>
        </>
      }
    >
      <p>
        Permanently delete <span className="mono">{entry.key}</span>? This cannot be undone.
      </p>
    </Modal>
  );
}
