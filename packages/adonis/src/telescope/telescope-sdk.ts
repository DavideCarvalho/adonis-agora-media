/**
 * A local, structural mirror of the `@adonis-agora/telescope` extension SDK contract.
 *
 * We deliberately do NOT import `@adonis-agora/telescope` — it lives in a separate repo, so a workspace
 * dependency would not resolve, and `@adonis-agora/telescope` is only an OPTIONAL peer (a host may run
 * `@adonis-agora/media` without any observability at all). This is the same cross-repo decoupling
 * `@adonis-agora/telescope` itself uses to read `@adonis-agora/diagnostics` without importing it, and the
 * same pattern `@adonis-agora/durable/telescope` follows. Instead we declare the same shapes here; the
 * exported extension object structurally satisfies `@adonis-agora/telescope`'s `TelescopeExtension` when
 * an app wires it into `config/telescope.ts` (where both packages are installed). Keep these in lockstep
 * with `@adonis-agora/telescope`'s `src/extension/types.ts`.
 */

/** The slice of a telescope entry the data providers read. */
export interface TelescopeEntryLike {
  content?: unknown;
  createdAt?: Date;
}

/** The slice of the telescope store the data providers read (a subset of `TelescopeStore`). */
export interface TelescopeStoreLike {
  list(query?: { type?: string; tag?: string; limit?: number }): Promise<TelescopeEntryLike[]>;
}

/** The slice of the AdonisJS container an extension uses to resolve host services. */
export interface ContainerLike {
  make<T>(token: unknown): Promise<T>;
}

/** Read-only context handed to every extension hook (mirror of `@adonis-agora/telescope`'s). */
export interface ExtensionContext {
  readonly store: TelescopeStoreLike;
  readonly container: ContainerLike;
  readonly config: unknown;
}

export interface ExtensionEntryType {
  id: string;
  label: string;
  dot: string;
}

export interface PanelThresholds {
  warn: number;
  bad: number;
  direction: 'up-bad' | 'down-bad';
}

export interface DashboardSection {
  title?: string;
  cols?: 2 | 3 | 4;
  panels: Panel[];
}

export interface DashboardSpec {
  id: string;
  label: string;
  navGroup?: string;
  panels: Panel[];
  sections?: DashboardSection[];
}

export interface DataBinding {
  provider: string;
  query?: Record<string, unknown>;
}

export interface LinkSpec {
  href: string;
  external?: boolean;
}

export interface Column {
  key: string;
  label: string;
  link?: LinkSpec;
}

export type Panel =
  | {
      kind: 'stat';
      title: string;
      data: DataBinding;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      accent?: string;
      spark?: boolean;
      thresholds?: PanelThresholds;
    }
  | {
      kind: 'timeseries';
      title: string;
      data: DataBinding;
      series: string[];
      style?: 'area' | 'stacked';
    }
  | { kind: 'topN'; title: string; data: DataBinding; limit?: number }
  | { kind: 'table'; title: string; data: DataBinding; columns: Column[] }
  | {
      kind: 'distribution';
      title: string;
      data: DataBinding;
      markers?: Array<'p50' | 'p95' | 'p99'>;
      format?: 'duration' | 'number';
    }
  | {
      kind: 'gauge';
      title: string;
      data: DataBinding;
      min?: number;
      max?: number;
      format?: 'number' | 'percent' | 'duration' | 'rate';
      thresholds?: PanelThresholds;
    }
  | { kind: 'breakdown'; title: string; data: DataBinding; style?: 'donut' | 'bar' };

export interface DataProvider {
  name: string;
  resolve(query: Record<string, unknown> | undefined, ctx: ExtensionContext): Promise<unknown>;
}

export interface TelescopeExtension {
  name: string;
  entryTypes?(ctx: ExtensionContext): ExtensionEntryType[];
  dashboards?(ctx: ExtensionContext): DashboardSpec[];
  dataProviders?(ctx: ExtensionContext): DataProvider[];
}

/** A telescope entry a watcher records — the structural slice of `@adonis-agora/telescope`'s `RecordInput`. */
export interface TelescopeRecordInput {
  /** The entry `type`/`tag` this entry is filed and navigated under, e.g. `'media'`. */
  type: string;
  /** Type-specific structured content. For media: `{ event, ts, traceId?, ...payload }`. */
  content: unknown;
}

/**
 * The recording surface a {@link MediaWatcher}-style watcher is handed on `register`. Mirror of the
 * `WatcherContext` a `@adonis-agora/telescope` watcher receives — declared structurally here so
 * `@adonis-agora/telescope` stays an optional, never-imported peer (same reasoning as the rest of
 * this file). A host wires the watcher to a real telescope store's `record`.
 */
export interface WatcherContext {
  record(entry: TelescopeRecordInput): void;
}
