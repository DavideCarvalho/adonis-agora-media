import { useRef, useState } from 'react';
import type { DiskInfo, ObjectEntry } from '../../types';
import { DRAG_MIME, type DragItem, FolderTree } from '../FolderTree';
import { Lightbox, type PreviewItem } from '../Lightbox';
import { useDashboard } from '../context';
import { navigate } from '../hash-route';
import {
  useCopy,
  useCopyFolder,
  useCreateFolder,
  useDelete,
  useDeleteFolder,
  useDisks,
  useMove,
  useMoveFolder,
  useObjects,
  useTopology,
  useUploadObject,
} from '../queries';
import { Alert, Button, Empty, Modal, Panel, formatBytes, formatDate, useToasts } from '../ui';

interface Crumb {
  label: string;
  prefix: string | undefined;
}

/** A file or a folder targeted by a copy/move/rename. A file is addressed by its full key; a folder
 *  by its prefix (which carries a trailing slash from listing). */
type MoveTarget =
  | { type: 'file'; key: string; name: string }
  | { type: 'folder'; prefix: string; name: string };

type DialogState =
  | { kind: 'upload' }
  | { kind: 'folder' }
  | { kind: 'copy' | 'move'; target: MoveTarget }
  | { kind: 'rename'; target: MoveTarget }
  | { kind: 'delete-file'; key: string; name: string }
  | { kind: 'delete-folder'; prefix: string; name: string };

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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The full object key for a name placed into `prefix`. The prefix arrives from listing with a
 *  trailing slash, so strip it before joining — otherwise the key double-slashes into a phantom
 *  subfolder. */
function keyIn(prefix: string | undefined, name: string): string {
  const parent = prefix?.replace(/\/+$/, '');
  return parent ? `${parent}/${name}` : name;
}

function sourceAddress(target: MoveTarget): string {
  return target.type === 'file' ? target.key : target.prefix.replace(/\/+$/, '');
}

function parentDirOf(address: string): string {
  const lastSlash = address.lastIndexOf('/');
  return lastSlash === -1 ? '' : address.slice(0, lastSlash + 1);
}

function startRowDrag(event: React.DragEvent, item: DragItem): void {
  event.dataTransfer.setData(DRAG_MIME, JSON.stringify(item));
  event.dataTransfer.effectAllowed = 'move';
}

/** Modal file uploader: pick or drop files, upload sequentially with per-file progress. Uses the
 *  console's bounded direct upload (`POST /object`), not the resumable TUS path on the Upload tab. */
function UploadDialog({
  disk,
  prefix,
  onClose,
  onUploaded,
}: {
  disk: string;
  prefix: string | undefined;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useUploadObject();

  function addFiles(incoming: FileList | File[]): void {
    setFiles((current) => [...current, ...Array.from(incoming)]);
  }

  async function submit(): Promise<void> {
    if (files.length === 0) return;
    setProgress({ done: 0, total: files.length });
    setError(null);
    try {
      for (let index = 0; index < files.length; index++) {
        const file = files[index];
        if (!file) continue;
        await upload.mutateAsync({ disk, key: keyIn(prefix, file.name), file });
        setProgress({ done: index + 1, total: files.length });
      }
      onUploaded();
      onClose();
    } catch (uploadError) {
      setError(describeError(uploadError));
      setProgress(null);
    }
  }

  const busy = progress !== null;
  return (
    <Modal
      title={`Upload to ${prefix ? `/${prefix}` : disk}`}
      onClose={onClose}
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" tone="accent" onClick={submit} disabled={busy || files.length === 0}>
            {busy ? `Uploading ${progress.done}/${progress.total}…` : 'Upload'}
          </Button>
        </>
      }
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click opens the native file picker; keyboard users reach it via the hidden input */}
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        className={`mono cursor-pointer rounded-md border border-dashed px-3 py-6 text-center text-xs transition-colors ${
          dragOver
            ? 'border-accent/50 bg-accent/5 text-accent'
            : 'border-border text-zinc-500 hover:text-zinc-300'
        }`}
      >
        Drop files here, or click to choose
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {files.length > 0 && (
        <ul className="mt-3 max-h-48 space-y-1 overflow-auto">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${index}`}
              className="mono flex items-center justify-between gap-2 rounded border border-border px-2 py-1 text-[11px]"
            >
              <span className="truncate text-zinc-300">{file.name}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="tnum text-zinc-600">{formatBytes(file.size)}</span>
                {!busy && (
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                    className="text-zinc-600 hover:text-bad"
                  >
                    ✕
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <Alert variant="error" className="mt-3">
          {error}
        </Alert>
      )}
    </Modal>
  );
}

/** Modal folder creator: a name input that writes a `<prefix>/name/` marker. */
function FolderDialog({
  disk,
  prefix,
  onClose,
  onCreated,
}: {
  disk: string;
  prefix: string | undefined;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const create = useCreateFolder();

  async function submit(): Promise<void> {
    const trimmed = name.trim();
    if (trimmed === '') return;
    setError(null);
    try {
      await create.mutateAsync({ disk, prefix: keyIn(prefix, trimmed) });
      onCreated();
      onClose();
    } catch (createError) {
      setError(describeError(createError));
    }
  }

  return (
    <Modal
      title="New folder"
      onClose={onClose}
      initialFocus={inputRef}
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button
            size="sm"
            tone="accent"
            onClick={submit}
            disabled={create.isPending || name.trim() === ''}
          >
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <label
        htmlFor="folder-name"
        className="mono flex flex-col gap-1 text-[10px] uppercase tracking-wider text-zinc-600"
      >
        Folder name
        <input
          id="folder-name"
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="reports"
          className="mono rounded-md border border-border bg-black/30 px-3 py-2 text-sm normal-case tracking-normal text-zinc-100 focus:border-accent/40 focus:outline-none"
        />
      </label>
      <p className="mono mt-2 text-[10px] text-zinc-600">
        Creates {prefix ? `/${prefix}/` : ''}
        <span className="text-zinc-400">{name.trim() || 'name'}</span>/
      </p>
      {error && (
        <Alert variant="error" className="mt-3">
          {error}
        </Alert>
      )}
    </Modal>
  );
}

/** Modal copy/move for a file OR a folder. The destination is picked from a folder tree spanning ALL
 *  disks (so an object can be relocated across buckets) plus an editable name. */
function CopyMoveDialog({
  kind,
  disks,
  sourceDisk,
  target,
  onClose,
  onDone,
  notify,
}: {
  kind: 'copy' | 'move';
  disks: DiskInfo[];
  sourceDisk: string;
  target: MoveTarget;
  onClose: () => void;
  onDone: () => void;
  notify: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const source = sourceAddress(target);
  const [destDisk, setDestDisk] = useState(sourceDisk);
  const [destPrefix, setDestPrefix] = useState(parentDirOf(source));
  const [name, setName] = useState(target.name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const copyFile = useCopy();
  const moveFile = useMove();
  const copyFolder = useCopyFolder();
  const moveFolder = useMoveFolder();

  const noun = target.type === 'folder' ? 'folder' : 'object';
  const verb = kind === 'copy' ? 'Copy' : 'Move';
  const trimmedName = name.trim();
  const destination = keyIn(destPrefix, trimmedName);
  const sameDisk = destDisk === sourceDisk;
  const unchanged = sameDisk && destination === source;
  const intoItself =
    target.type === 'folder' &&
    sameDisk &&
    (destination === source || destination.startsWith(`${source}/`));
  const blocked = trimmedName === '' || unchanged || intoItself;
  const pending =
    copyFile.isPending || moveFile.isPending || copyFolder.isPending || moveFolder.isPending;

  async function submit(): Promise<void> {
    if (blocked) return;
    setError(null);
    try {
      if (target.type === 'folder') {
        const body = { disk: sourceDisk, from: target.prefix, to: destination, toDisk: destDisk };
        await (kind === 'copy' ? copyFolder : moveFolder).mutateAsync(body);
      } else {
        const body = { disk: sourceDisk, from: target.key, to: destination, toDisk: destDisk };
        await (kind === 'copy' ? copyFile : moveFile).mutateAsync(body);
      }
      onDone();
      notify(
        `${kind === 'copy' ? 'Copied' : 'Moved'} ${target.name} to ${destDisk}/${destination}`,
      );
      onClose();
    } catch (actionError) {
      setError(describeError(actionError));
    }
  }

  return (
    <Modal
      title={`${verb} ${noun}`}
      onClose={onClose}
      initialFocus={inputRef}
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            size="sm"
            tone={kind === 'move' ? 'destructive' : 'accent'}
            onClick={submit}
            disabled={pending || blocked}
          >
            {pending ? `${kind === 'copy' ? 'Copying' : 'Moving'}…` : verb}
          </Button>
        </>
      }
    >
      <p className="mono mb-2 text-[11px] text-zinc-500">
        From{' '}
        <span className="text-zinc-300">
          {sourceDisk}/{source}
          {target.type === 'folder' ? '/' : ''}
        </span>
      </p>
      <div className="mono mb-1 text-[10px] uppercase tracking-wider text-zinc-600">
        Destination folder
      </div>
      <div className="max-h-56 overflow-auto rounded-md border border-border bg-black/20 p-1">
        <FolderTree
          disks={disks}
          selectedDisk={destDisk}
          currentPrefix={destPrefix}
          onNavigate={(navDisk, navPrefix) => {
            setDestDisk(navDisk);
            setDestPrefix(navPrefix);
          }}
        />
      </div>
      <label
        htmlFor="copy-move-name"
        className="mono mt-3 flex flex-col gap-1 text-[10px] uppercase tracking-wider text-zinc-600"
      >
        Name
        <input
          id="copy-move-name"
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          className="mono rounded-md border border-border bg-black/30 px-3 py-2 text-sm normal-case tracking-normal text-zinc-100 focus:border-accent/40 focus:outline-none"
        />
      </label>
      <p className="mono mt-2 text-[10px] text-zinc-600">
        To{' '}
        <span className="text-zinc-400">
          {destDisk}/{destination || '—'}
        </span>
        {unchanged && ' (same as source — pick a different folder or name)'}
        {intoItself && ' (a folder cannot go into itself)'}
      </p>
      {error && (
        <Alert variant="error" className="mt-3">
          {error}
        </Alert>
      )}
    </Modal>
  );
}

/** Modal rename-in-place for a file OR folder: a single name input (a same-disk move under the hood). */
function RenameDialog({
  disk,
  target,
  onClose,
  onDone,
  notify,
}: {
  disk: string;
  target: MoveTarget;
  onClose: () => void;
  onDone: () => void;
  notify: (message: string, tone?: 'ok' | 'error') => void;
}) {
  const source = sourceAddress(target);
  const parentDir = parentDirOf(source);
  const [name, setName] = useState(target.name);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const moveFile = useMove();
  const moveFolder = useMoveFolder();
  const pending = moveFile.isPending || moveFolder.isPending;

  const noun = target.type === 'folder' ? 'folder' : 'object';
  const trimmedName = name.trim();
  const destination = keyIn(parentDir, trimmedName);
  const blocked = trimmedName === '' || destination === source;

  async function submit(): Promise<void> {
    if (blocked) return;
    setError(null);
    try {
      if (target.type === 'folder') {
        await moveFolder.mutateAsync({ disk, from: target.prefix, to: destination });
      } else {
        await moveFile.mutateAsync({ disk, from: target.key, to: destination });
      }
      onDone();
      notify(`Renamed ${target.name} to ${trimmedName}`);
      onClose();
    } catch (actionError) {
      setError(describeError(actionError));
    }
  }

  return (
    <Modal
      title={`Rename ${noun}`}
      onClose={onClose}
      initialFocus={inputRef}
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button size="sm" tone="accent" onClick={submit} disabled={pending || blocked}>
            {pending ? 'Renaming…' : 'Rename'}
          </Button>
        </>
      }
    >
      <label
        htmlFor="rename-name"
        className="mono flex flex-col gap-1 text-[10px] uppercase tracking-wider text-zinc-600"
      >
        New name
        <input
          id="rename-name"
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          className="mono rounded-md border border-border bg-black/30 px-3 py-2 text-sm normal-case tracking-normal text-zinc-100 focus:border-accent/40 focus:outline-none"
        />
      </label>
      <p className="mono mt-2 text-[10px] text-zinc-600">
        To <span className="text-zinc-400">{destination || '—'}</span>
        {target.type === 'folder' ? '/' : ''}
      </p>
      {error && (
        <Alert variant="error" className="mt-3">
          {error}
        </Alert>
      )}
    </Modal>
  );
}

/**
 * The media-library browser: a folder tree over every browsable disk on the left, the selected
 * folder's contents on the right. Ported to visual parity with the NestJS sibling console's
 * `DisksView.tsx` — preview (Lightbox), create/rename/copy/move/delete for both files and folders,
 * drag-and-drop upload, and drag-a-row-onto-the-tree to move.
 */
export function LibraryBrowseView({ disk, prefix }: { disk?: string; prefix?: string }) {
  const disks = useDisks();
  const topology = useTopology();
  const actions = topology.data?.actions ?? false;
  const { push } = useToasts();
  const notify = (message: string, tone: 'ok' | 'error' = 'ok') => push(message, tone);

  const allDisks = disks.data?.disks ?? [];
  const browsable = allDisks.filter((d) => d.capabilities.list);
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
    refetch,
  } = useObjects(activeDisk, prefix);

  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<PreviewItem | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const { client } = useDashboard();
  const del = useDelete();
  const deleteFolder = useDeleteFolder();
  const uploadObject = useUploadObject();

  async function handlePreview(diskName: string, key: string, name: string): Promise<void> {
    setBusyKey(key);
    try {
      const detail = await client.object(diskName, key);
      setPreview({ ...detail, disk: diskName, name });
    } catch (previewError) {
      notify(`Failed to open "${key}": ${describeError(previewError)}`, 'error');
    } finally {
      setBusyKey(null);
    }
  }

  async function handleCopyKey(key: string): Promise<void> {
    await navigator.clipboard.writeText(key);
    notify(`Copied "${key}" to clipboard`);
  }

  async function handleTreeDrop(
    item: DragItem,
    targetDisk: string,
    targetPrefix: string,
  ): Promise<void> {
    const destination = keyIn(targetPrefix, item.name);
    const sameDisk = item.disk === targetDisk;
    if (item.kind === 'file' && sameDisk && destination === item.key) return;
    if (item.kind === 'folder' && sameDisk && destination === item.prefix.replace(/\/+$/, ''))
      return;
    try {
      if (item.kind === 'file') {
        await client.move({ disk: item.disk, from: item.key, to: destination, toDisk: targetDisk });
      } else {
        await client.moveFolder({
          disk: item.disk,
          from: item.prefix,
          to: destination,
          toDisk: targetDisk,
        });
      }
      await refetch();
      notify(`Moved ${item.name} to ${targetDisk}/${destination}`);
    } catch (moveError) {
      notify(`Move failed: ${describeError(moveError)}`, 'error');
    }
  }

  async function handleDropUpload(diskName: string, dropped: FileList): Promise<void> {
    const list = Array.from(dropped);
    if (list.length === 0) return;
    try {
      for (const file of list) {
        await uploadObject.mutateAsync({ disk: diskName, key: keyIn(prefix, file.name), file });
      }
      notify(`Uploaded ${list.length === 1 ? list[0]?.name : `${list.length} files`}`);
    } catch (uploadError) {
      notify(`Upload failed: ${describeError(uploadError)}`, 'error');
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!dialog || (dialog.kind !== 'delete-file' && dialog.kind !== 'delete-folder')) return;
    if (!activeDisk) return;
    try {
      if (dialog.kind === 'delete-file') {
        await del.mutateAsync({ disk: activeDisk, keys: [dialog.key] });
      } else {
        await deleteFolder.mutateAsync({ disk: activeDisk, prefix: dialog.prefix });
      }
      notify(`Deleted ${dialog.name}`);
      setDialog(null);
    } catch (deleteError) {
      notify(`Failed to delete: ${describeError(deleteError)}`, 'error');
    }
  }

  if (disks.isLoading) return <Empty>Loading disks…</Empty>;
  if (browsable.length === 0)
    return <Empty>No list-capable disks are configured for the console.</Empty>;
  if (!activeDisk) return <Empty>Select a disk to browse.</Empty>;

  const crumbs = crumbsFor(activeDisk, prefix);
  const isEmpty = !isLoading && !isError && folders.length === 0 && files.length === 0;
  const deletePending = del.isPending || deleteFolder.isPending;

  return (
    <section className="rise">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-[220px_1fr]">
        <Panel className="h-fit p-2">
          <h3 className="mono px-2 py-1 text-[10px] uppercase tracking-wider text-zinc-600">
            explorer
          </h3>
          <FolderTree
            disks={browsable}
            selectedDisk={activeDisk}
            currentPrefix={prefix}
            onNavigate={(navDisk, navPrefix) =>
              navigate({
                tab: 'browse',
                disk: navDisk,
                ...(navPrefix ? { prefix: navPrefix } : {}),
              })
            }
            onDropMove={actions ? handleTreeDrop : undefined}
          />
        </Panel>

        <Panel className="p-3">
          <div
            onDragOver={
              actions
                ? (e) => {
                    e.preventDefault();
                    setDragOver(true);
                  }
                : undefined
            }
            onDragLeave={actions ? () => setDragOver(false) : undefined}
            onDrop={
              actions
                ? (e) => {
                    e.preventDefault();
                    setDragOver(false);
                    void handleDropUpload(activeDisk, e.dataTransfer.files);
                  }
                : undefined
            }
            className={`rounded-md ${dragOver ? 'ring-2 ring-inset ring-accent/50' : ''}`}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <nav className="mono flex flex-wrap items-center gap-1 text-xs text-zinc-500">
                {crumbs.map((crumb, index) => (
                  <span key={crumb.prefix ?? '__root__'} className="flex items-center gap-1">
                    {index > 0 && <span className="text-zinc-700">/</span>}
                    <button
                      type="button"
                      onClick={() =>
                        navigate({
                          tab: 'browse',
                          disk: activeDisk,
                          ...(crumb.prefix ? { prefix: crumb.prefix } : {}),
                        })
                      }
                      className={`rounded px-1.5 py-0.5 hover:bg-zinc-800/60 ${
                        index === crumbs.length - 1 ? 'text-zinc-100' : ''
                      }`}
                    >
                      {crumb.label}
                    </button>
                  </span>
                ))}
              </nav>
              {actions && (
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button tone="accent" onClick={() => setDialog({ kind: 'upload' })}>
                    ↑ Upload
                  </Button>
                  <Button onClick={() => setDialog({ kind: 'folder' })}>+ New folder</Button>
                </div>
              )}
            </div>

            {isLoading ? (
              <Empty>Loading objects…</Empty>
            ) : isError ? (
              <p className="text-sm s-error">Failed to list objects: {(error as Error)?.message}</p>
            ) : isEmpty ? (
              <Empty>This folder is empty.</Empty>
            ) : (
              <>
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="mono border-b border-border text-[10px] uppercase tracking-wider text-zinc-600">
                      <th className="py-2 pr-2 font-normal">Name</th>
                      <th className="py-2 pr-2 font-normal">Size</th>
                      <th className="py-2 pr-2 font-normal">Last modified</th>
                      <th className="py-2 pr-2 font-normal">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {folders.map((folder) => (
                      <tr
                        key={folder.prefix}
                        draggable={actions}
                        onDragStart={
                          actions
                            ? (e) =>
                                startRowDrag(e, {
                                  kind: 'folder',
                                  disk: activeDisk,
                                  prefix: folder.prefix,
                                  name: folder.name,
                                })
                            : undefined
                        }
                        className={`hover:bg-zinc-900/40 ${actions ? 'cursor-grab' : ''}`}
                      >
                        <td className="py-2 pr-2">
                          <button
                            type="button"
                            onClick={() =>
                              navigate({ tab: 'browse', disk: activeDisk, prefix: folder.prefix })
                            }
                            className="flex items-center gap-2 text-zinc-200 hover:text-accent"
                          >
                            <span aria-hidden className="text-zinc-600">
                              ▸
                            </span>
                            {folder.name}
                          </button>
                        </td>
                        <td className="py-2 pr-2 text-zinc-700">—</td>
                        <td className="py-2 pr-2 text-zinc-700">—</td>
                        <td className="py-2 pr-2">
                          {actions && (
                            <div className="flex flex-wrap gap-1.5">
                              <Button
                                onClick={() =>
                                  setDialog({
                                    kind: 'copy',
                                    target: {
                                      type: 'folder',
                                      prefix: folder.prefix,
                                      name: folder.name,
                                    },
                                  })
                                }
                              >
                                Copy to…
                              </Button>
                              <Button
                                onClick={() =>
                                  setDialog({
                                    kind: 'move',
                                    target: {
                                      type: 'folder',
                                      prefix: folder.prefix,
                                      name: folder.name,
                                    },
                                  })
                                }
                              >
                                Move to…
                              </Button>
                              <Button
                                onClick={() =>
                                  setDialog({
                                    kind: 'rename',
                                    target: {
                                      type: 'folder',
                                      prefix: folder.prefix,
                                      name: folder.name,
                                    },
                                  })
                                }
                              >
                                Rename
                              </Button>
                              <Button
                                tone="destructive"
                                onClick={() =>
                                  setDialog({
                                    kind: 'delete-folder',
                                    prefix: folder.prefix,
                                    name: folder.name,
                                  })
                                }
                              >
                                Delete
                              </Button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                    {files.map((file: ObjectEntry) => (
                      <tr
                        key={file.key}
                        draggable={actions}
                        onDragStart={
                          actions
                            ? (e) =>
                                startRowDrag(e, {
                                  kind: 'file',
                                  disk: activeDisk,
                                  key: file.key,
                                  name: file.name,
                                })
                            : undefined
                        }
                        className={`hover:bg-zinc-900/40 ${actions ? 'cursor-grab' : ''}`}
                      >
                        <td className="mono py-2 pr-2 text-[13px] text-zinc-200">{file.name}</td>
                        <td className="mono tnum py-2 pr-2 text-xs text-zinc-500">
                          {formatBytes(file.sizeBytes)}
                        </td>
                        <td className="py-2 pr-2 text-xs text-zinc-500">
                          {formatDate(file.lastModified)}
                        </td>
                        <td className="py-2 pr-2">
                          <div className="flex flex-wrap gap-1.5">
                            <Button
                              disabled={busyKey === file.key}
                              onClick={() => handlePreview(activeDisk, file.key, file.name)}
                            >
                              Preview
                            </Button>
                            <Button onClick={() => handleCopyKey(file.key)}>Copy key</Button>
                            {actions && (
                              <>
                                <Button
                                  onClick={() =>
                                    setDialog({
                                      kind: 'copy',
                                      target: { type: 'file', key: file.key, name: file.name },
                                    })
                                  }
                                >
                                  Copy to…
                                </Button>
                                <Button
                                  onClick={() =>
                                    setDialog({
                                      kind: 'move',
                                      target: { type: 'file', key: file.key, name: file.name },
                                    })
                                  }
                                >
                                  Move to…
                                </Button>
                                <Button
                                  onClick={() =>
                                    setDialog({
                                      kind: 'rename',
                                      target: { type: 'file', key: file.key, name: file.name },
                                    })
                                  }
                                >
                                  Rename
                                </Button>
                                <Button
                                  tone="destructive"
                                  onClick={() =>
                                    setDialog({
                                      kind: 'delete-file',
                                      key: file.key,
                                      name: file.name,
                                    })
                                  }
                                >
                                  Delete
                                </Button>
                              </>
                            )}
                          </div>
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
                {actions && dragOver && (
                  <p className="mono mt-3 rounded-md border border-dashed border-accent/40 bg-accent/5 px-3 py-4 text-center text-xs text-accent/80">
                    Drop files to upload to {prefix ? `/${prefix}` : activeDisk}
                  </p>
                )}
              </>
            )}
          </div>
        </Panel>
      </div>

      {activeDisk && dialog?.kind === 'upload' && (
        <UploadDialog
          disk={activeDisk}
          prefix={prefix}
          onClose={() => setDialog(null)}
          onUploaded={refetch}
        />
      )}
      {activeDisk && dialog?.kind === 'folder' && (
        <FolderDialog
          disk={activeDisk}
          prefix={prefix}
          onClose={() => setDialog(null)}
          onCreated={refetch}
        />
      )}
      {activeDisk && (dialog?.kind === 'copy' || dialog?.kind === 'move') && (
        <CopyMoveDialog
          kind={dialog.kind}
          disks={browsable}
          sourceDisk={activeDisk}
          target={dialog.target}
          onClose={() => setDialog(null)}
          onDone={refetch}
          notify={notify}
        />
      )}
      {activeDisk && dialog?.kind === 'rename' && (
        <RenameDialog
          disk={activeDisk}
          target={dialog.target}
          onClose={() => setDialog(null)}
          onDone={refetch}
          notify={notify}
        />
      )}
      {activeDisk && (dialog?.kind === 'delete-file' || dialog?.kind === 'delete-folder') && (
        <Modal
          title={dialog.kind === 'delete-folder' ? 'Delete folder' : 'Delete object'}
          onClose={() => setDialog(null)}
          footer={
            <>
              <Button size="sm" onClick={() => setDialog(null)} disabled={deletePending}>
                Cancel
              </Button>
              <Button size="sm" tone="destructive" disabled={deletePending} onClick={confirmDelete}>
                {deletePending ? 'Deleting…' : 'Delete'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-zinc-300">
            Delete <span className="mono text-zinc-100">{dialog.name}</span>?
          </p>
          <p className="mono mt-2 text-[11px] text-zinc-600">
            {dialog.kind === 'delete-folder'
              ? 'Every object inside this folder is removed. This cannot be undone.'
              : 'This cannot be undone.'}
          </p>
        </Modal>
      )}

      <Lightbox item={preview} onClose={() => setPreview(null)} />
    </section>
  );
}
