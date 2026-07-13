import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import type { CopyMoveBody, DeleteBody, ObjectEntry, ObjectFolder } from '../types';
import { useDashboard } from './context';

export function useTopology() {
  const { client } = useDashboard();
  return useQuery({ queryKey: ['topology'], queryFn: () => client.topology() });
}

export function useDisks() {
  const { client } = useDashboard();
  return useQuery({ queryKey: ['disks'], queryFn: () => client.disks() });
}

const PAGE_LIMIT = 50;

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
        ...(pageParam ? { cursor: pageParam } : {}),
        limit: PAGE_LIMIT,
      }),
    getNextPageParam: (last) => last.cursor,
  });

  const folders = useMemo<ObjectFolder[]>(
    () => (query.data?.pages ?? []).flatMap((p) => p.folders),
    [query.data],
  );
  const files = useMemo<ObjectEntry[]>(
    () => (query.data?.pages ?? []).flatMap((p) => p.files),
    [query.data],
  );

  return { ...query, folders, files };
}

export function useUploads(filter: { disk?: string; prefix?: string } = {}) {
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
