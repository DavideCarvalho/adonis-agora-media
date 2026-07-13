import { useUploads } from '../queries';
import { Bar, Dot, Empty, Panel, formatBytes, relativeAge } from '../ui';

/**
 * Live list of in-progress resumable uploads, polled every 2s from the session store
 * (`UploadSessionStore.list()` via the real `/uploads` route). Mirrors the reference console's
 * "uploads-in-progress" screen.
 */
export function UploadsView() {
  const { data, isLoading, isError, error } = useUploads();
  const uploads = data?.uploads ?? [];

  return (
    <Panel
      title={
        <span className="row-name">
          <Dot tone="live" /> Uploads in progress
        </span>
      }
      actions={<span className="muted">refreshed every 2s</span>}
    >
      {isLoading ? (
        <Empty>Loading sessions…</Empty>
      ) : isError ? (
        <Empty>Failed to load uploads: {(error as Error)?.message}</Empty>
      ) : uploads.length === 0 ? (
        <Empty>No resumable uploads in progress.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Key</th>
              <th>Disk</th>
              <th style={{ width: '30%' }}>Progress</th>
              <th>Parts</th>
              <th>Age</th>
            </tr>
          </thead>
          <tbody>
            {uploads.map((u) => (
              <tr key={u.id}>
                <td className="mono">{u.key}</td>
                <td>{u.disk}</td>
                <td>
                  <div className="row-name">
                    <Bar percent={u.percent} />
                    <span className="muted tnum" style={{ minWidth: 92 }}>
                      {u.percent === null
                        ? `${formatBytes(u.offset)} · unknown size`
                        : `${u.percent}% · ${formatBytes(u.offset)}/${formatBytes(u.size)}`}
                    </span>
                  </div>
                </td>
                <td className="tnum">{u.parts}</td>
                <td className="tnum">{relativeAge(u.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
