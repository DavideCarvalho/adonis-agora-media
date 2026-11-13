import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type {
  CollectionFilter,
  CopyMoveBody,
  DeleteBody,
  FolderBody,
  MediaEntry,
  ObjectEntry,
  ObjectFolder,
  UploadFilter,
} from '../types';
import { useDashboard } from './context';

export function useTopology(options: { enabled?: boolean } = {}) {
  const { client } = useDashboard();
  return useQuery({
    queryKey: ['topology'],
    queryFn: () => client.topology(),
    enabled: options.enabled ?? true,
  });
}

export function useDisks() {
  const { client } = useDashboard();
  return useQuery({ queryKey: ['disks'], queryFn: () => client.disks() });
}

/** Page size requested as `first`. */
const PAGE_SIZE = 50;

/** Cursor-paginated listing of one disk under `prefix`, flattened across loaded pages. */
export function useObjects(disk: string | undefined, prefix: string | undefined) {
  const { client } = useDashboard();
  const query = useInfiniteQuery({
    queryKey: ['objects', disk, prefix ?? ''],
    enabled: Boolean(disk),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.objects(disk as string, {
        ...(prefix ? { prefix } : {}),
        ...(pageParam ? { after: pageParam } : {}),
        first: PAGE_SIZE,
      }),
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });

  const folders = useMemo<ObjectFolder[]>(
    () =>
      (query.data?.pages ?? []).flatMap((p) =>
        p.data.flatMap((item) =>
          item.type === 'folder' ? [{ name: item.name, prefix: item.prefix }] : [],
        ),
      ),
    [query.data],
  );
  const files = useMemo<ObjectEntry[]>(
    () =>
      (query.data?.pages ?? []).flatMap((p) =>
        p.data.flatMap((item) =>
          item.type === 'file'
            ? [
                {
                  key: item.key,
                  name: item.name,
                  sizeBytes: item.sizeBytes,
                  lastModified: item.lastModified,
                },
              ]
            : [],
        ),
      ),
    [query.data],
  );

  return { ...query, folders, files };
}

/** Cursor-paginated listing of stored media-library records, flattened across loaded pages. */
export function useCollections(filter: CollectionFilter) {
  const { client } = useDashboard();
  const query = useInfiniteQuery({
    queryKey: [
      'collections',
      filter.collection ?? '',
      filter.ownerType ?? '',
      filter.ownerId ?? '',
      filter.prefix ?? '',
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      client.collections({
        ...filter,
        ...(pageParam ? { after: pageParam } : {}),
        first: PAGE_SIZE,
      }),
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
  });

  const items = useMemo<MediaEntry[]>(
    () => (query.data?.pages ?? []).flatMap((p) => p.data),
    [query.data],
  );

  return { ...query, items };
}

export function useUploads(filter: UploadFilter = {}) {
  const { client } = useDashboard();
  return useQuery({
    queryKey: ['uploads', filter.disk ?? '', filter.prefix ?? ''],
    queryFn: () => client.uploads(filter),
    refetchInterval: 2000,
  });
}

export function useCopy() {
  const { client } = useDashboard();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CopyMoveBody) => client.copy(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['objects'] }),
  });
}

export function useMove() {
  const { client } = useDashboard();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CopyMoveBody) => client.move(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['objects'] }),
  });
}

export function useDelete() {
  const { client } = useDashboard();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DeleteBody) => client.remove(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['objects'] }),
  });
}

/** The console's convenience direct upload (bounded, buffered) — distinct from the resumable TUS
 *  uploader on the Upload tab. Used by the disk browser's "Upload" dialog. */
export function useUploadObject() {
  const { client } = useDashboard();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ disk, key, file }: { disk: string; key: string; file: File }) =>
      client.uploadObject(disk, key, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['objects'] }),
  });
}

export function useCreateFolder() {
  const { client } = useDashboard();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FolderBody) => client.createFolder(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['objects'] }),
  });
}

export function useDeleteFolder() {
  const { client } = useDashboard();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: FolderBody) => client.deleteFolder(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['objects'] }),
  });
}

export function useCopyFolder() {
  const { client } = useDashboard();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CopyMoveBody) => client.copyFolder(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['objects'] }),
  });
}

export function useMoveFolder() {
  const { client } = useDashboard();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CopyMoveBody) => client.moveFolder(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['objects'] }),
  });
}

/** Object metadata + a short-lived signed URL, fetched on demand when a preview opens. */
export function useObjectDetail() {
  const { client } = useDashboard();
  return useMutation({
    mutationFn: ({ disk, key }: { disk: string; key: string }) => client.object(disk, key),
  });
}

export function useObjectInsights(disk: string | undefined, key: string | undefined) {
  const { client } = useDashboard();
  return useQuery({
    queryKey: ['object-insights', disk ?? '', key ?? ''],
    queryFn: () => client.objectInsights(disk as string, key as string),
    enabled: Boolean(disk && key),
    staleTime: 30_000,
  });
}

export function useUploadDetail(id: string | undefined) {
  const { client } = useDashboard();
  return useQuery({
    queryKey: ['upload', id ?? ''],
    queryFn: () => client.uploadDetail(id as string),
    enabled: Boolean(id),
  });
}

export function useAbortUpload() {
  const { client } = useDashboard();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.abortUpload(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['uploads'] }),
  });
}

export function useCollectionsSummary() {
  const { client } = useDashboard();
  return useQuery({
    queryKey: ['collections-summary'],
    queryFn: () => client.collectionsSummary(),
  });
}

export function useMediaRecord(id: string | undefined) {
  const { client } = useDashboard();
  return useQuery({
    queryKey: ['media-record', id ?? ''],
    queryFn: () => client.mediaRecord(id as string),
    enabled: Boolean(id),
  });
}

export function useDeleteMediaRecord() {
  const { client } = useDashboard();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => client.deleteMediaRecord(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collections'] });
      qc.invalidateQueries({ queryKey: ['collections-summary'] });
    },
  });
}
