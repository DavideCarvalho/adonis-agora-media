import { useEffect, useState } from 'react';
import { splitHash, subscribeHashUrl } from '../agora-kit/url-state/hash-url';

export type Tab = 'browse' | 'collections' | 'uploads' | 'upload';

export interface Route {
  tab: Tab;
  disk?: string;
  prefix?: string;
  /** Object key whose preview panel is open (Library tab). Deep-linkable so a preview survives a
   *  reload/share, mirroring the NestJS sibling console's `?preview=` param. */
  preview?: string;
  /** Selected media-record id whose detail is open (Collections tab). */
  recordId?: string;
  /** Selected upload id whose detail is open (Uploads tab). */
  uploadId?: string;
  /** Collection the Collections tab opens filtered on (`#/collections?collection=avatar`). */
  collection?: string;
}

const TABS: Tab[] = ['browse', 'collections', 'uploads', 'upload'];

/** Parse `#/browse/{disk}?prefix={prefix}&preview={key}` into a {@link Route}. */
export function parseHash(hash: string): Route {
  const { path, search: queryPart } = splitHash(hash);
  const pathPart = path.replace(/^\/?/, '');
  const segments = pathPart.split('/').filter(Boolean);
  const tab = (segments[0] as Tab) ?? 'browse';
  const route: Route = { tab: TABS.includes(tab) ? tab : 'browse' };
  if (segments[1]) route.disk = decodeURIComponent(segments[1]);
  const query = new URLSearchParams(queryPart ?? '');
  const prefix = query.get('prefix');
  if (prefix) route.prefix = prefix;
  const preview = query.get('preview');
  if (preview) route.preview = decodeURIComponent(preview);
  const collection = query.get('collection');
  if (tab === 'collections' && collection) route.collection = collection;
  if (tab === 'collections' && segments[1]) route.recordId = decodeURIComponent(segments[1]);
  if (tab === 'uploads' && segments[1]) route.uploadId = decodeURIComponent(segments[1]);
  return route;
}

/** Build a hash string for a {@link Route}. */
export function toHash(route: Route): string {
  let path = `#/${route.tab}`;
  if (route.disk) path += `/${encodeURIComponent(route.disk)}`;
  else if (route.recordId) path += `/${encodeURIComponent(route.recordId)}`;
  else if (route.uploadId) path += `/${encodeURIComponent(route.uploadId)}`;
  const params = new URLSearchParams();
  if (route.prefix) params.set('prefix', route.prefix);
  if (route.preview) params.set('preview', route.preview);
  if (route.collection) params.set('collection', route.collection);
  const qs = params.toString();
  if (qs) path += `?${qs}`;
  return path;
}

export function navigate(route: Route): void {
  window.location.hash = toHash(route);
}

/**
 * The current route, following links and back/forward (`hashchange`, `popstate`) and the views'
 * own filter writes (nuqs, through the kit's `NuqsHashAdapter`), which are query-only and fire no
 * `hashchange`. The route object is kept while the route itself is unchanged.
 */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    parseHash(typeof window === 'undefined' ? '' : window.location.hash),
  );
  useEffect(
    () =>
      subscribeHashUrl(() =>
        setRoute((prev) => {
          const next = parseHash(window.location.hash);
          return toHash(next) === toHash(prev) ? prev : next;
        }),
      ),
    [],
  );
  return route;
}
