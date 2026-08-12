import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { OpenConsoleOptions } from './console-session.js';
import { useOpenMediaDashboard } from './use-open-console.js';

export interface OpenMediaDashboardButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'>,
    OpenConsoleOptions {
  /** Button label. Defaults to "Open Media console". */
  children?: ReactNode;
  /** Shown while the session is being minted. Defaults to "Opening…". */
  pendingLabel?: ReactNode;
  /**
   * Render the refusal yourself. Omit and the button renders a plain `<p role="alert">` under
   * itself; pass `null` to render nothing and read the error from {@link useOpenMediaDashboard}.
   */
  renderError?: ((error: Error) => ReactNode) | null;
}

/**
 * Drop-in launcher for the `@adonis-agora/media-dashboard` console: the top tier, for a host that
 * just wants a working button. Ported from the NestJS sibling console's `open-console-button.tsx`.
 *
 * Deliberately unstyled — it emits a bare `<button>` and forwards `className`/`style`/every other
 * button prop, so it inherits whatever design system the host already has instead of importing CSS
 * that would fight it. When it doesn't fit, drop to {@link useOpenMediaDashboard} (same behaviour,
 * your markup) or to `openMediaDashboard` (no React at all).
 *
 * The error is rendered by default rather than swallowed: a refused mint is the case a launcher most
 * needs to surface, and a button that silently does nothing reads as broken rather than forbidden.
 */
export function OpenMediaDashboardButton({
  children,
  pendingLabel,
  renderError,
  basePath,
  apiBasePath,
  headers,
  fetch: fetchImpl,
  signal,
  navigate,
  disabled,
  ...buttonProps
}: OpenMediaDashboardButtonProps) {
  // Spread conditionally rather than passing `undefined`: `exactOptionalPropertyTypes` is on, and an
  // explicit `undefined` is not the same as an absent key to the option defaulting downstream.
  const { open, isPending, error } = useOpenMediaDashboard({
    ...(basePath !== undefined ? { basePath } : {}),
    ...(apiBasePath !== undefined ? { apiBasePath } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
    ...(signal !== undefined ? { signal } : {}),
    ...(navigate !== undefined ? { navigate } : {}),
  });

  return (
    <>
      <button
        type="button"
        {...buttonProps}
        onClick={open}
        disabled={disabled || isPending}
        aria-busy={isPending || undefined}
      >
        {isPending ? (pendingLabel ?? 'Opening…') : (children ?? 'Open Media console')}
      </button>
      {error &&
        renderError !== null &&
        (renderError?.(error) ?? <p role="alert">{error.message}</p>)}
    </>
  );
}
