/**
 * The authkit account console extension contract (version 1), declared STRUCTURALLY here: media
 * never imports `@adonis-agora/authkit-server` (or authkit-client). authkit binds a registry at
 * `'authkit.accountExtensions'`; media registers its pages into it when it is there.
 *
 * Only the members media uses are declared; authkit's own types are a superset.
 */

/** The container binding authkit's registry lives at. */
export const ACCOUNT_EXTENSIONS_BINDING = 'authkit.accountExtensions';

/** A message key (looked up in the merged catalog) or literal text. Always escaped by authkit. */
export type Text = string | { key: string; params?: Record<string, string | number> };

/** The tenant of the request, as authkit passes it. */
export interface AccountTenantRef {
  id: string;
  kind: string;
  slug?: string;
  role?: string;
}

export interface AccountExtensionContext {
  account: { id: string; email: string | null; name: string | null; roles: readonly string[] };
  activeOrg: { id: string; slug: string; role: string } | null;
  /** The tenant of the request (the active organization), when authkit sends it. */
  tenant?: AccountTenantRef | null;
  /** The account mapped to the app's user by authkit's `accountConsole.subject` hook. */
  subject?: { type: string; id: string } | null;
  impersonatedBy: string | null;
  locale: string;
  query: { cursor?: string; tab?: string };
  url(pageId: string, query?: Record<string, string>): string;
  make(binding: string): Promise<unknown>;
  now(): Date;
}

export type Value =
  | { type: 'text'; text: Text }
  | { type: 'date'; at: Date | string; style?: 'date' | 'datetime' | 'relative' }
  | { type: 'badge'; text: Text; tone?: 'neutral' | 'success' | 'warning' | 'danger' }
  | { type: 'number'; value: number; unit?: Text };

export interface ActionRef {
  action: string;
  target?: string;
}

export interface ListItem {
  title: Text;
  subtitle?: Text;
  meta?: Value[];
  badge?: Value;
  href?: string;
  external?: boolean;
  actions?: ActionRef[];
}

export interface ComponentScript {
  src: string;
  integrity?: string;
  module?: boolean;
}

export type Block =
  | { kind: 'notice'; tone: 'info' | 'success' | 'warning' | 'danger'; text: Text }
  | {
      kind: 'list';
      title?: Text;
      empty: Text;
      items: ReadonlyArray<ListItem>;
      nextCursor?: string | null;
    }
  | {
      kind: 'component';
      provider: string;
      scripts: ReadonlyArray<ComponentScript>;
      props?: Record<string, unknown>;
      submit?: ActionRef;
      fallback?: { label: Text; href: string; external?: boolean };
    };

export interface AccountPageView {
  blocks: readonly Block[];
  tabs?: ReadonlyArray<{ id: string; label: Text }>;
}

export type AccountActionResult =
  | { ok: true; flash?: Text; redirectTo?: { page: string } | { external: string } }
  | { ok: false; error: Text; status?: 400 | 403 | 404 | 409 };

export interface AccountAction {
  label: Text;
  tone?: 'default' | 'danger';
  confirm?: Text;
  sudo?: boolean;
  fields?: ReadonlyArray<{
    name: string;
    label: Text;
    kind: 'text' | 'select' | 'textarea';
    required?: boolean;
    maxLength?: number;
  }>;
  handle(
    ctx: AccountExtensionContext,
    input: { target: string | null; fields: Record<string, string> },
  ): Promise<AccountActionResult>;
}

export interface AccountPage {
  id: string;
  segment: string;
  title: Text;
  nav?: { label?: Text; order?: number; group?: 'account' | 'billing' | 'ai' | 'content' } | false;
  visible?(ctx: AccountExtensionContext): boolean | Promise<boolean>;
  load(ctx: AccountExtensionContext): Promise<AccountPageView>;
  actions?: Readonly<Record<string, AccountAction>>;
}

export interface AccountExtension {
  readonly id: string;
  readonly contract: 1;
  messages?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  scriptOrigins?: readonly string[];
  pages: readonly AccountPage[];
}

/** The registry authkit binds. */
export interface AccountExtensionRegistry {
  readonly contract: number;
  readonly blockKinds?: readonly string[];
  register(extension: AccountExtension): void;
}
