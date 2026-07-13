import { useMediaUpload } from '@adonis-agora/media-react';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useDashboard } from '../context';
import { useDisks } from '../queries';
import { Bar, Empty, Panel, useToasts } from '../ui';

interface QueueItem {
  name: string;
  status: 'done' | 'error';
}

/**
 * Upload panel — reuses `@adonis-agora/media-react`'s `useMediaUpload` (resumable TUS) against the
 * core upload routes. Files dropped or picked are uploaded sequentially into the chosen disk; on
 * completion the library/uploads queries are invalidated so the new objects appear.
 */
export function UploadPanel() {
  const { bootstrap } = useDashboard();
  const disks = useDisks();
  const qc = useQueryClient();
  const { push } = useToasts();
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [active, setActive] = useState<string | null>(null);

  const browsable = useMemo(() => disks.data?.disks ?? [], [disks.data]);
  const [disk, setDisk] = useState<string>('');
  const targetDisk = disk || browsable.find((d) => d.default)?.name || browsable[0]?.name || '';

  const uploader = useMediaUpload({
    mode: 'tus',
    baseUrl: '',
    tusPath: bootstrap.tusBase,
    uploadsPath: bootstrap.uploadsBase,
  });

  const handleFiles = async (files: File[]) => {
    for (const file of files) {
      setActive(file.name);
      try {
        await uploader.upload(file, {
          filename: file.name,
          ...(file.type ? { contentType: file.type } : {}),
          key: file.name,
          ...(targetDisk ? { disk: targetDisk } : {}),
        });
        setQueue((prev) => [{ name: file.name, status: 'done' }, ...prev]);
      } catch (err) {
        setQueue((prev) => [{ name: file.name, status: 'error' }, ...prev]);
        push(`${file.name}: ${(err as Error).message}`, 'error');
      }
    }
    setActive(null);
    uploader.reset();
    qc.invalidateQueries({ queryKey: ['objects'] });
    qc.invalidateQueries({ queryKey: ['uploads'] });
  };

  return (
    <Panel title="Upload">
      <div className="stack">
        <div className="field" style={{ maxWidth: 260 }}>
          <label htmlFor="upload-disk">Destination disk</label>
          <select
            id="upload-disk"
            className="input"
            value={targetDisk}
            onChange={(e) => setDisk(e.target.value)}
          >
            {browsable.length === 0 && <option value="">(no disks)</option>}
            {browsable.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
                {d.default ? ' (default)' : ''}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          className={`dropzone${over ? ' over' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            const files = Array.from(e.dataTransfer.files);
            if (files.length) void handleFiles(files);
          }}
        >
          Drop files here, or click to choose
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length) void handleFiles(files);
              e.target.value = '';
            }}
          />
        </button>

        {active && (
          <div className="upload-item">
            <span className="mono" style={{ minWidth: 140 }}>
              {active}
            </span>
            <Bar percent={Math.round(uploader.progress * 100)} />
            <span className="muted tnum">{Math.round(uploader.progress * 100)}%</span>
          </div>
        )}

        {queue.length === 0 && !active ? (
          <Empty>No uploads yet.</Empty>
        ) : (
          queue.map((item, i) => (
            <div key={`${item.name}-${i}`} className="upload-item">
              <span className="mono" style={{ minWidth: 140 }}>
                {item.name}
              </span>
              <span className={item.status === 'done' ? 'muted' : 'danger'}>
                {item.status === 'done' ? 'Uploaded' : 'Failed'}
              </span>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
