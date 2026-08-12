import { useCallback, useEffect, useRef, useState } from 'react';
import { type OpenConsoleOptions, openMediaDashboard } from './console-session.js';

/**
 * React layer over `openMediaDashboard` — the middle tier between the bare function
 * (`./console-session.ts`) and the drop-in `<OpenMediaDashboardButton>`. Ported from the NestJS
 * sibling console's `use-open-console.ts`.
 *
 * You get the state a launcher UI actually needs (in-flight, error) and keep full control of the
 * markup. Nothing here is media-specific beyond the endpoint: it is a mint-then-navigate call with
 * the two states that call can be in.
 */
export interface UseOpenConsoleResult {
  /** Start the mint-then-navigate. Never rejects — read `error` instead. */
  open: () => void;
  /**
   * True from the click until the navigation starts, or until it fails. Stays true across a
   * successful mint (see below) and is cleared again if the browser restores this page from the
   * back/forward cache.
   */
  isPending: boolean;
  /**
   * The last refusal, or `null`. Cleared when `open()` is called again.
   *
   * Typed as `Error` rather than `ConsoleSessionError` because `ConsoleSessionError` carries the
   * session endpoint it was refused by, and a failure that did not come from the mint (a `navigate`
   * override that throws) has no endpoint to attribute — inventing one would be a lie. Every refusal
   * from the mint itself IS a `ConsoleSessionError`, so `instanceof` narrows.
   */
  error: Error | null;
  /** Drop a stale error without retrying — e.g. when a dialog closes. */
  reset: () => void;
}

export function useOpenMediaDashboard(options: OpenConsoleOptions = {}): UseOpenConsoleResult {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Kept in a ref so a caller passing an inline object literal (the common case) doesn't change the
  // identity of `open` on every render, which would defeat memoizing anything downstream.
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const open = useCallback(() => {
    setIsPending(true);
    setError(null);
    void openMediaDashboard(optionsRef.current)
      .then(() => {
        // Deliberately NOT clearing `isPending` on success: the navigation is already underway and
        // this component is about to be torn down. Flipping the button back to idle first produces
        // a visible flicker of "ready to click again" on a page that is leaving.
        //
        // The page does not always die, though — see the `pageshow` effect below, which is the
        // other half of this decision.
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setIsPending(false);
      });
  }, []);

  // The other half of "don't clear `isPending` on success". Leaving the flag set assumes the page is
  // destroyed by the navigation — but the back/forward cache does NOT destroy it: pressing Back
  // restores this very page from memory with React state intact, so the user returns to a spinner
  // that never stops on a button that is disabled precisely because `isPending` is still true. A
  // bfcache restore is only observable as `pageshow` with `persisted: true`; there is no unmount, no
  // re-render and no fresh mount to hang the reset off, which is why this listener exists.
  useEffect(() => {
    // SSR-safe: no window on the server, and nothing to restore there either.
    if (typeof window === 'undefined') return;
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      setIsPending(false);
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const reset = useCallback(() => setError(null), []);

  return { open, isPending, error, reset };
}

/**
 * TanStack Query integration WITHOUT a TanStack dependency: the returned object is the shape
 * `useMutation` takes, so a host that already uses Query wires the launcher into its own cache,
 * devtools and error handling with no extra adapter.
 *
 * ```ts
 * const { mutate, isPending } = useMutation(openMediaDashboardMutationOptions({ headers }));
 * ```
 */
export function openMediaDashboardMutationOptions(options: OpenConsoleOptions = {}): {
  mutationKey: readonly unknown[];
  mutationFn: () => Promise<void>;
} {
  return {
    // Both mount points are in the key: `apiBasePath` decides which endpoint mints the session and is
    // settable independently of `basePath`, so two mounts differing only in it are two different
    // calls and must not share cache state.
    mutationKey: [
      'media',
      'dashboard',
      'open',
      options.basePath ?? null,
      options.apiBasePath ?? null,
    ] as const,
    mutationFn: () => openMediaDashboard(options),
  };
}
