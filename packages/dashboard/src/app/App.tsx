import { useMemo } from 'react';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { AppShell, type NavSection } from '../agora-kit/shell/app-shell';
import { readShellConfig } from '../agora-kit/shell-config';
import { CONFIG_ELEMENT_ID } from '../client/dashboard-client';
import type { Tab } from './hash-route';
import { navigate, toHash, useHashRoute } from './hash-route';
import { FolderIcon, LayersIcon, LogoMark, TransferIcon, UploadIcon } from './icons';
import { useTopology } from './queries';
import { TenantPickerControl } from './TenantPicker';
import { Dot } from './ui';
import { CollectionsView } from './views/CollectionsView';
import { LibraryBrowseView } from './views/LibraryBrowseView';
import { UploadPanel } from './views/UploadPanel';
import { UploadsView } from './views/UploadsView';

/** Media's accent (amber): passed to the kit's ThemeProvider in `main.tsx`. */
export const MEDIA_ACCENT = '#fbbf24';

const TITLES: Record<Tab, string> = {
  browse: 'Library',
  collections: 'Collections',
  uploads: 'Uploads',
  upload: 'Upload',
};

/** The deployment at a glance, in the topbar: disk count, whether resumable uploads and mutating
 *  actions are on, and the live dot. Hidden on phones (the pages say the same thing). */
function TopologyPills() {
  const topology = useTopology();
  if (!topology.data) return null;
  const { disks, hasUploads, actions } = topology.data;
  const pill = (label: string, on: boolean, title: string) => (
    <span
      className={`mono flex items-center gap-1.5 text-[11px] ${on ? 'text-dim' : 'text-faint'}`}
      title={title}
    >
      <Dot tone={on ? 'ok' : 'idle'} />
      {label}
    </span>
  );
  return (
    <div className="hidden items-center gap-3 lg:flex">
      <span className="mono tnum text-[11px] text-dim">
        {disks} {disks === 1 ? 'disk' : 'disks'}
      </span>
      {pill(
        'uploads',
        hasUploads,
        hasUploads ? 'Resumable uploads are on' : 'Resumable uploads are off',
      )}
      {pill(
        'actions',
        actions,
        actions ? 'Copy, move, delete and upload are enabled' : 'Read-only console',
      )}
    </div>
  );
}

function LiveIndicator() {
  return (
    <span className="hidden items-center gap-1.5 text-[12px] text-dim sm:flex">
      <Dot tone="ok" pulse />
      live
    </span>
  );
}

/**
 * The media console: the Agora shell (kit) around four pages — LIBRARY (Library, Collections) and
 * TRANSFERS (Uploads, Upload). Routing is the URL hash (`hash-route.ts`); every page renders inside
 * its own error boundary, and every region inside it has its own.
 */
export function App() {
  // What the provider put in the page: switcher, ⌘K search, viewer, sign-out (all optional).
  const shell = useMemo(() => readShellConfig(CONFIG_ELEMENT_ID), []);
  const route = useHashRoute();

  const nav = useMemo<NavSection[]>(() => {
    const item = (id: Tab, icon: React.ReactNode) => ({
      id,
      label: TITLES[id],
      icon,
      href: toHash({ tab: id }),
      onSelect: () => navigate({ tab: id }),
    });
    return [
      {
        section: 'Library',
        items: [item('browse', <FolderIcon />), item('collections', <LayersIcon />)],
      },
      {
        section: 'Transfers',
        items: [item('uploads', <TransferIcon />), item('upload', <UploadIcon />)],
      },
    ];
  }, []);

  return (
    <AppShell
      brand={{
        name: 'media',
        subtitle: 'media library',
        mark: <LogoMark />,
        current: { title: 'Media', package: '@adonis-agora/media', icon: 'media' },
      }}
      nav={nav}
      activeId={route.tab}
      shell={shell}
      title={TITLES[route.tab]}
      searchPlaceholder="Search media, runs, payments, users…"
      actions={
        <>
          <TenantPickerControl />
          <TopologyPills />
          <LiveIndicator />
        </>
      }
    >
      <ErrorBoundary label={TITLES[route.tab]} resetKeys={[route.tab]}>
        {route.tab === 'browse' && (
          <LibraryBrowseView
            {...(route.disk ? { disk: route.disk } : {})}
            {...(route.prefix ? { prefix: route.prefix } : {})}
          />
        )}
        {route.tab === 'collections' && <CollectionsView route={route} />}
        {route.tab === 'uploads' && <UploadsView route={route} />}
        {route.tab === 'upload' && <UploadPanel />}
      </ErrorBoundary>
    </AppShell>
  );
}
