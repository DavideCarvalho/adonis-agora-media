import {
  type ReactNode,
  type RefObject,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import {
  DialogBackdrop,
  DialogClose,
  DialogPopup,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from './ui/dialog';

/** Console-specific surface primitives, built on the vendored shadcn primitives in `./ui/` so they
 *  inherit the Aviary tokens: a dark panel, a status dot, a progress bar, a modal, a toast stack,
 *  and the byte/date/age formatters every view reuses. Mirrors the NestJS sibling console's own
 *  `src/app/ui.tsx` as closely as this console's slightly different toast architecture (a single
 *  app-wide `ToastProvider` instead of a per-view `useToasts` hook) allows.
 *
 *  `Button` and `Alert` are re-exported here so a view has one import path for the whole kit. */

export { Button, Alert };
export type { ButtonProps } from './ui/button';

/** Human-readable byte size (`1.4 MB`). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** Short absolute date (`2026-07-13 14:02`). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(0, 16).replace('T', ' ');
}

/** Compact relative age (`3m`, `2h`, `5d`). */
export function relativeAge(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

/** The dark card container — a bordered panel over the blueprint backdrop. */
export function Panel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`rounded-lg border border-border bg-panel ${className}`}>{children}</div>;
}

export type Tone = 'ok' | 'live' | 'warn' | 'error' | 'info' | 'idle';

/** A 7px status pip in the tone's hue (see `.s-*` in styles.css), optionally pulsing for live state. */
export function Dot({ tone, pulse }: { tone?: Tone; pulse?: boolean }) {
  return <span className={`dot s-${tone ?? 'idle'} ${pulse ? 'pulse' : ''}`} aria-hidden />;
}

/** A slim progress track — percent-filled, or empty (0%) when the total size is unknown; the caller
 *  renders the "unknown size" text alongside it. */
export function Bar({ percent }: { percent: number | null }) {
  const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div
      className="h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-zinc-800"
      aria-hidden="true"
    >
      <span
        className="block h-full rounded-full bg-accent/80 transition-[width]"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/** Centered muted message for empty / loading / error panes. */
export function Empty({ children }: { children: ReactNode }) {
  return <Alert variant="muted">{children}</Alert>;
}

/**
 * A themed modal dialog on the vendored shadcn/Base UI Dialog (see `./ui/dialog.tsx`). The focus
 * trap, focus restore, scroll lock, `aria-modal` wiring and Esc / outside-press dismissal come from
 * the primitive. Optional `footer` pins actions to the bottom; `initialFocus` picks the field that
 * should be focused (and, for a text input, selected) once it opens.
 *
 * Mounted-means-open: every caller renders this conditionally, so `open` is constant and closing is
 * reported through `onClose`, which unmounts it.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  initialFocus,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  return (
    <DialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPortal>
        <DialogBackdrop />
        <DialogPopup
          // Select-on-open rather than just focus-on-open: a rename/copy dialog opens with the
          // current name in the field, and the point is to be able to type straight over it.
          initialFocus={() => {
            const element = initialFocus?.current;
            if (element instanceof HTMLInputElement) element.select();
            return element ?? true;
          }}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <DialogTitle>{title}</DialogTitle>
            <Button render={<DialogClose />} tone="ghost" aria-label="Close" className="shrink-0">
              ✕
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
          {footer && (
            <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>
          )}
        </DialogPopup>
      </DialogPortal>
    </DialogRoot>
  );
}

/* Toasts ------------------------------------------------------------------------------------------
 * A transient corner notification — the console's answer to `window.alert`, so a failed (or
 * succeeded) action reports without a blocking browser dialog. Success auto-dismisses quickly; an
 * error lingers longer and can also be dismissed by hand. Provided app-wide (`main.tsx` wraps the
 * whole tree once) rather than per-view, so any handler anywhere can call `push`. */
export type ToastTone = 'ok' | 'error';
export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastApi {
  toasts: Toast[];
  push: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const timer = window.setTimeout(
      () => onDismiss(toast.id),
      toast.tone === 'error' ? 6000 : 3500,
    );
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.tone, onDismiss]);
  return (
    <div
      className={`rise mono flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] shadow-2xl backdrop-blur-sm ${
        toast.tone === 'error'
          ? 'border-bad/40 bg-bad/15 text-bad'
          : 'border-accent/40 bg-accent/15 text-accent'
      }`}
    >
      <span className="mt-px shrink-0" aria-hidden>
        {toast.tone === 'error' ? '✕' : '✓'}
      </span>
      <span className="flex-1 break-words normal-case">{toast.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
      >
        ✕
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);
  const push = useCallback((message: string, tone: ToastTone = 'ok') => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, message, tone }]);
  }, []);
  const api = useMemo(() => ({ toasts, push }), [toasts, push]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.length > 0 &&
        createPortal(
          <div
            aria-live="polite"
            className="fixed right-4 bottom-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
          >
            {toasts.map((toast) => (
              <ToastRow key={toast.id} toast={toast} onDismiss={dismiss} />
            ))}
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) return { toasts: [], push: () => {} };
  return ctx;
}
