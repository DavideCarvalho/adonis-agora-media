import { type ReactNode, useRef, useState } from 'react';
import { EmptyState } from '../../agora-kit/blocks/empty-state';
import { ErrorBoundary, RegionError } from '../../agora-kit/blocks/error-boundary';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../../agora-kit/blocks/metric-card';
import { PageHeader } from '../../agora-kit/blocks/page-header';
import { LoadMore } from '../../agora-kit/blocks/pager';
import { Panel } from '../../agora-kit/blocks/panel';
import { ChevronRightIcon, MoreHorizontalIcon } from '../../agora-kit/icons';
import { PageBody } from '../../agora-kit/shell/app-shell';
import { Button } from '../../agora-kit/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../agora-kit/ui/dropdown-menu';
import { Input } from '../../agora-kit/ui/input';
import { Skeleton } from '../../agora-kit/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../agora-kit/ui/table';
import type { DiskInfo, ObjectEntry, ObjectFolder } from '../../types';
import { useDashboard } from '../context';
import { DRAG_MIME, type DragItem, FolderTree } from '../FolderTree';
import { navigate } from '../hash-route';
import { EyeIcon, FileIcon, FolderIcon, PlusIcon, UploadIcon } from '../icons';
import { Lightbox, type PreviewItem } from '../Lightbox';
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
import { Alert, Field, formatBytes, formatDate, Modal, useToasts } from '../ui';

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
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || files.length === 0}>
            {busy ? `Uploading ${progress.done}/${progress.total}…` : 'Upload'}
          </Button>
        </>
      }
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click opens the native file picker; keyboard users reach it via the hidden input */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone; ARIA has no role for drag-and-drop targets and the hidden input is the accessible control */}
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
        className={`cursor-pointer rounded-md border border-dashed px-3 py-8 text-center text-xs transition-colors ${
          dragOver
            ? 'border-brand-border bg-brand-soft text-brand'
            : 'border-line-strong text-dim hover:border-brand-border hover:text-fg'
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
              // biome-ignore lint/suspicious/noArrayIndexKey: the same file can be picked twice and `File` has no id; the index is the only thing that disambiguates duplicates
              key={`${file.name}-${index}`}
              className="mono flex items-center justify-between gap-2 rounded-md border border-border bg-panel-2 px-2 py-1 text-[11px]"
            >
              <span className="truncate text-fg-2">{file.name}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="tnum text-faint">{formatBytes(file.size)}</span>
                {!busy && (
                  <button
                    type="button"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                    className="text-faint hover:text-bad"
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
          <Button variant="outline" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={create.isPending || name.trim() === ''}>
            {create.isPending ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <Field id="folder-name" label="Folder name">
        <Input
          id="folder-name"
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          placeholder="reports"
          className="mono h-8 text-[13px]"
        />
      </Field>
      <p className="mono mt-2 text-[10.5px] text-faint">
        Creates {prefix ? `/${prefix}/` : ''}
        <span className="text-fg-2">{name.trim() || 'name'}</span>/
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
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant={kind === 'move' ? 'destructive' : 'default'}
            onClick={submit}
            disabled={pending || blocked}
          >
            {pending ? `${kind === 'copy' ? 'Copying' : 'Moving'}…` : verb}
          </Button>
        </>
      }
    >
      <p className="mono mb-3 text-[11px] text-dim">
        From{' '}
        <span className="text-fg-2">
          {sourceDisk}/{source}
          {target.type === 'folder' ? '/' : ''}
        </span>
      </p>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
        Destination folder
      </div>
      <div className="max-h-56 overflow-auto rounded-md border border-border bg-sunken/20 p-1">
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
      <Field id="copy-move-name" label="Name" className="mt-3">
        <Input
          id="copy-move-name"
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          className="mono h-8 text-[13px]"
        />
      </Field>
      <p className="mono mt-2 text-[10.5px] text-faint">
        To{' '}
        <span className="text-fg-2">
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
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || blocked}>
            {pending ? 'Renaming…' : 'Rename'}
          </Button>
        </>
      }
    >
      <Field id="rename-name" label="New name">
        <Input
          id="rename-name"
          ref={inputRef}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
          }}
          className="mono h-8 text-[13px]"
        />
      </Field>
      <p className="mono mt-2 text-[10.5px] text-faint">
        To <span className="text-fg-2">{destination || '—'}</span>
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

/* ── Presentational pieces of the browser ───────────────────────────────────────────────────── */

/** What the current folder holds, plus the disk count. Counts are of the loaded pages. */
export function LibraryMetrics({
  disks,
  browsable,
  folders,
  files,
  more,
}: {
  disks: number;
  browsable: number;
  folders: number;
  files: ObjectEntry[];
  more: boolean;
}) {
  const bytes = files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0);
  const plus = more ? '+' : '';
  return (
    <MetricGrid>
      <MetricCard label="Disks" value={disks} caption={`${browsable} browsable`} tone="brand" />
      <MetricCard
        label="Folders"
        value={`${folders}${plus}`}
        caption="in this folder"
        tone="violet"
      />
      <MetricCard label="Files" value={`${files.length}${plus}`} caption="in this folder" />
      <MetricCard
        label="Size"
        value={formatBytes(bytes)}
        caption={more ? 'of the loaded files' : 'files in this folder'}
      />
    </MetricGrid>
  );
}

/** Clickable path: disk / folder / folder. */
function Breadcrumbs({
  crumbs,
  onOpen,
}: {
  crumbs: Crumb[];
  onOpen: (prefix: string | undefined) => void;
}) {
  return (
    <nav
      aria-label="Path"
      className="mono flex min-w-0 flex-wrap items-center gap-0.5 text-[12px] text-dim"
    >
      {crumbs.map((crumb, index) => (
        <span key={crumb.prefix ?? '__root__'} className="flex items-center gap-0.5">
          {index > 0 && (
            <span className="text-faint [&_svg]:size-3" aria-hidden>
              <ChevronRightIcon />
            </span>
          )}
          <button
            type="button"
            onClick={() => onOpen(crumb.prefix)}
            aria-current={index === crumbs.length - 1 ? 'location' : undefined}
            className="rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg aria-[current=location]:font-semibold aria-[current=location]:text-fg"
          >
            {crumb.label}
          </button>
        </span>
      ))}
    </nav>
  );
}

type RowAction = { label: string; onSelect: () => void; destructive?: boolean };

/** A row's secondary actions behind a "…" menu (shadcn DropdownMenu). */
function RowMenu({ name, items }: { name: string; items: RowAction[] }) {
  const safe = items.filter((i) => !i.destructive);
  const danger = items.filter((i) => i.destructive);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label={`Actions for ${name}`} />}
      >
        <MoreHorizontalIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {safe.map((item) => (
          <DropdownMenuItem key={item.label} onClick={item.onSelect} className="text-[12.5px]">
            {item.label}
          </DropdownMenuItem>
        ))}
        {danger.length > 0 && safe.length > 0 && <DropdownMenuSeparator />}
        {danger.map((item) => (
          <DropdownMenuItem
            key={item.label}
            variant="destructive"
            onClick={item.onSelect}
            className="text-[12.5px]"
          >
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const headClass =
  'h-auto px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint';

/** The folder's contents (folders first, then files), presentational. Rows drag onto the tree. */
export function ObjectsTable({
  disk,
  folders,
  files,
  actions,
  busyKey,
  onOpenFolder,
  onPreview,
  onRowAction,
}: {
  disk: string;
  folders: ObjectFolder[];
  files: ObjectEntry[];
  actions: boolean;
  busyKey: string | null;
  onOpenFolder: (prefix: string) => void;
  onPreview: (file: ObjectEntry) => void;
  onRowAction: (dialog: DialogState | { kind: 'copy-key'; key: string }) => void;
}) {
  const moveActions = (target: MoveTarget): RowAction[] => [
    { label: 'Copy to…', onSelect: () => onRowAction({ kind: 'copy', target }) },
    { label: 'Move to…', onSelect: () => onRowAction({ kind: 'move', target }) },
    { label: 'Rename', onSelect: () => onRowAction({ kind: 'rename', target }) },
  ];
  return (
    <Table aria-label="Objects">
      <TableHeader>
        <TableRow className="border-border hover:bg-transparent">
          <TableHead className={headClass}>Name</TableHead>
          <TableHead className={`${headClass} hidden text-right sm:table-cell`}>Size</TableHead>
          <TableHead className={`${headClass} hidden text-right md:table-cell`}>
            Last modified
          </TableHead>
          <TableHead className={`${headClass} w-px text-right`}>
            <span className="sr-only">Actions</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {folders.map((folder) => (
          <TableRow
            key={folder.prefix}
            draggable={actions}
            onDragStart={
              actions
                ? (e) =>
                    startRowDrag(e, {
                      kind: 'folder',
                      disk,
                      prefix: folder.prefix,
                      name: folder.name,
                    })
                : undefined
            }
            className={`border-border hover:bg-hover ${actions ? 'cursor-grab' : ''}`}
          >
            <TableCell className="px-3 py-2">
              <button
                type="button"
                onClick={() => onOpenFolder(folder.prefix)}
                className="flex items-center gap-2 text-[12.5px] font-medium text-fg hover:text-brand [&_svg]:size-3.5"
              >
                <span className="text-brand" aria-hidden>
                  <FolderIcon />
                </span>
                {folder.name}
              </button>
            </TableCell>
            <TableCell className="hidden px-3 py-2 text-right text-faint sm:table-cell">
              —
            </TableCell>
            <TableCell className="hidden px-3 py-2 text-right text-faint md:table-cell">
              —
            </TableCell>
            <TableCell className="px-3 py-1.5 text-right">
              {actions && (
                <RowMenu
                  name={folder.name}
                  items={[
                    ...moveActions({ type: 'folder', prefix: folder.prefix, name: folder.name }),
                    {
                      label: 'Delete',
                      destructive: true,
                      onSelect: () =>
                        onRowAction({
                          kind: 'delete-folder',
                          prefix: folder.prefix,
                          name: folder.name,
                        }),
                    },
                  ]}
                />
              )}
            </TableCell>
          </TableRow>
        ))}
        {files.map((file) => (
          <TableRow
            key={file.key}
            draggable={actions}
            onDragStart={
              actions
                ? (e) => startRowDrag(e, { kind: 'file', disk, key: file.key, name: file.name })
                : undefined
            }
            className={`border-border hover:bg-hover ${actions ? 'cursor-grab' : ''}`}
          >
            <TableCell className="max-w-[16rem] px-3 py-2 sm:max-w-none">
              <span className="flex min-w-0 items-center gap-2 [&_svg]:size-3.5">
                <span className="shrink-0 text-faint" aria-hidden>
                  <FileIcon />
                </span>
                <span className="mono truncate text-[12.5px] text-fg-2">{file.name}</span>
              </span>
            </TableCell>
            <TableCell className="mono tnum hidden px-3 py-2 text-right text-[11.5px] text-dim sm:table-cell">
              {formatBytes(file.sizeBytes)}
            </TableCell>
            <TableCell className="mono tnum hidden px-3 py-2 text-right text-[11.5px] text-faint md:table-cell">
              {formatDate(file.lastModified)}
            </TableCell>
            <TableCell className="px-3 py-1.5">
              <div className="flex items-center justify-end gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyKey === file.key}
                  onClick={() => onPreview(file)}
                >
                  <EyeIcon />
                  <span className="hidden sm:inline">Preview</span>
                  <span className="sr-only sm:hidden">Preview</span>
                </Button>
                <RowMenu
                  name={file.name}
                  items={[
                    {
                      label: 'Copy key',
                      onSelect: () => onRowAction({ kind: 'copy-key', key: file.key }),
                    },
                    ...(actions
                      ? [
                          ...moveActions({ type: 'file', key: file.key, name: file.name }),
                          {
                            label: 'Delete',
                            destructive: true,
                            onSelect: () =>
                              onRowAction({ kind: 'delete-file', key: file.key, name: file.name }),
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RowsSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 py-4" aria-hidden>
      {['a', 'b', 'c', 'd', 'e'].map((k, i) => (
        <div key={k} className="flex items-center gap-3">
          <Skeleton className="size-4 rounded-sm" />
          <Skeleton className={`h-3 ${i % 2 ? 'w-40' : 'w-56'}`} />
          <Skeleton className="ml-auto h-3 w-14" />
        </div>
      ))}
    </div>
  );
}

function TreeSkeleton() {
  return (
    <div className="flex flex-col gap-2.5 p-2" aria-hidden>
      <Skeleton className="h-3 w-28" />
      <Skeleton className="ml-4 h-3 w-20" />
      <Skeleton className="ml-4 h-3 w-24" />
      <Skeleton className="h-3 w-24" />
    </div>
  );
}

/**
 * Library (LIBRARY): the disk browser. A folder tree over every browsable disk on the left, the
 * selected folder's contents on the right — preview (Lightbox), create / rename / copy / move /
 * delete for files and folders, drag-and-drop upload, and drag-a-row-onto-the-tree to move.
 * Container: owns the disk/topology/object queries, the mutations and the open dialog; the
 * metrics, breadcrumbs, table and dialogs are presentational.
 */
export function LibraryBrowseView({ disk, prefix }: { disk?: string; prefix?: string }) {
  const disks = useDisks();
  const topology = useTopology();
  const actions = topology.data?.actions ?? false;
  const { push } = useToasts();
  const notify = (message: string, tone: 'ok' | 'error' = 'ok') => push(message, tone);

  const allDisks = disks.data?.data ?? [];
  const browsable = allDisks.filter((d) => d.capabilities.list);
  const activeDisk = disk ?? browsable.find((d) => d.default)?.name ?? browsable[0]?.name;

  const objects = useObjects(activeDisk, prefix);
  const { folders, files, hasNextPage, isFetchingNextPage, fetchNextPage, refetch } = objects;

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
    try {
      await navigator.clipboard.writeText(key);
      notify(`Copied "${key}" to clipboard`);
    } catch {
      notify('The clipboard is not available here', 'error');
    }
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

  const header = (
    <PageHeader
      title="Library"
      description="Browse every disk, preview objects, and copy or move them across buckets."
      actions={
        actions && activeDisk ? (
          <>
            <Button variant="outline" onClick={() => setDialog({ kind: 'folder' })}>
              <PlusIcon />
              New folder
            </Button>
            <Button onClick={() => setDialog({ kind: 'upload' })}>
              <UploadIcon />
              Upload
            </Button>
          </>
        ) : undefined
      }
    />
  );

  let body: ReactNode;
  if (disks.error && !disks.data) {
    body = (
      <RegionError
        title="Disks could not be loaded"
        error={disks.error}
        onRetry={() => void disks.refetch()}
      />
    );
  } else if (!disks.data) {
    body = (
      <>
        <MetricGridSkeleton count={4} />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[240px_1fr]">
          <Panel title="Explorer" bodyClassName="p-2">
            <TreeSkeleton />
          </Panel>
          <Panel title="Objects" flush>
            <RowsSkeleton />
          </Panel>
        </div>
      </>
    );
  } else if (browsable.length === 0 || !activeDisk) {
    body = (
      <Panel title="Objects">
        <EmptyState
          title="No list-capable disks are configured for the console."
          description="Only disks whose driver can list keys (S3, local fs, GCS…) are browsable."
        />
      </Panel>
    );
  } else {
    const crumbs = crumbsFor(activeDisk, prefix);
    const loaded = objects.data !== undefined;
    const isEmpty = loaded && folders.length === 0 && files.length === 0;
    const open = (navPrefix: string | undefined) =>
      navigate({ tab: 'browse', disk: activeDisk, ...(navPrefix ? { prefix: navPrefix } : {}) });

    body = (
      <>
        <ErrorBoundary label="Library metrics">
          {loaded ? (
            <LibraryMetrics
              disks={allDisks.length}
              browsable={browsable.length}
              folders={folders.length}
              files={files}
              more={hasNextPage}
            />
          ) : (
            <MetricGridSkeleton count={4} />
          )}
        </ErrorBoundary>
        <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[240px_1fr]">
          <ErrorBoundary label="Explorer">
            {/* On phones the folder list comes first; the tree follows it. */}
            <Panel
              title="Explorer"
              description={`${browsable.length} browsable`}
              bodyClassName="p-2"
              className="order-2 md:order-none"
            >
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
          </ErrorBoundary>

          <ErrorBoundary label="Objects" resetKeys={[activeDisk, prefix]}>
            <Panel
              title="Objects"
              description={actions ? 'drop files here to upload' : 'read-only'}
              flush
              className={dragOver ? 'ring-2 ring-brand-border' : ''}
            >
              {/* biome-ignore lint/a11y/noStaticElementInteractions: whole-panel drop target for uploads; ARIA has no role for drag-and-drop targets and every control inside stays keyboard-reachable */}
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
              >
                <div className="border-b border-border px-2.5 py-2">
                  <Breadcrumbs crumbs={crumbs} onOpen={open} />
                </div>
                {objects.error && !loaded ? (
                  <div className="p-4">
                    <RegionError
                      title="Objects could not be listed"
                      error={objects.error}
                      onRetry={() => void refetch()}
                    />
                  </div>
                ) : !loaded ? (
                  <RowsSkeleton />
                ) : isEmpty ? (
                  <EmptyState
                    icon={<FolderIcon />}
                    title="This folder is empty."
                    description={
                      actions
                        ? 'Drop files here, or use Upload above.'
                        : 'Nothing is stored under this path.'
                    }
                  />
                ) : (
                  <>
                    <ObjectsTable
                      disk={activeDisk}
                      folders={folders}
                      files={files}
                      actions={actions}
                      busyKey={busyKey}
                      onOpenFolder={(p) => open(p)}
                      onPreview={(file) => void handlePreview(activeDisk, file.key, file.name)}
                      onRowAction={(next) =>
                        next.kind === 'copy-key' ? void handleCopyKey(next.key) : setDialog(next)
                      }
                    />
                    <LoadMore
                      hasNext={hasNextPage}
                      loading={isFetchingNextPage}
                      onLoadMore={() => void fetchNextPage()}
                      className="border-t border-border"
                    />
                  </>
                )}
                {actions && dragOver && (
                  <p className="m-3 rounded-md border border-dashed border-brand-border bg-brand-soft px-3 py-4 text-center text-xs text-brand">
                    Drop files to upload to {prefix ? `/${prefix}` : activeDisk}
                  </p>
                )}
              </div>
            </Panel>
          </ErrorBoundary>
        </div>
      </>
    );
  }

  const deletePending = del.isPending || deleteFolder.isPending;

  return (
    <PageBody>
      {header}
      {body}

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
              <Button variant="outline" onClick={() => setDialog(null)} disabled={deletePending}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={deletePending} onClick={confirmDelete}>
                {deletePending ? 'Deleting…' : 'Delete'}
              </Button>
            </>
          }
        >
          <p className="text-sm text-fg-2">
            Delete <span className="mono text-fg">{dialog.name}</span>?
          </p>
          <p className="mono mt-2 text-[11px] text-faint">
            {dialog.kind === 'delete-folder'
              ? 'Every object inside this folder is removed. This cannot be undone.'
              : 'This cannot be undone.'}
          </p>
        </Modal>
      )}

      <Lightbox item={preview} onClose={() => setPreview(null)} />
    </PageBody>
  );
}
