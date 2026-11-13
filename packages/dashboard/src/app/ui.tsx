import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon, XIcon } from '../agora-kit/icons';
import { cn } from '../agora-kit/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../agora-kit/ui/dialog';

/** Media's own small pieces on top of the Agora kit: formatters, a status dot, a progress bar, a
 *  notice line, a modal (on the kit's Dialog) and an app-wide toast stack. Everything is written on
 *  the kit's token classes, so both themes work. */

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

export type Tone = 'ok' | 'live' | 'warn' | 'error' | 'info' | 'idle';

/** A 7px status pip in the tone's hue (see `.s-*` in styles.css), optionally pulsing for live state. */
export function Dot({ tone, pulse }: { tone?: Tone; pulse?: boolean }) {
  return <span className={cn('dot', `s-${tone ?? 'idle'}`, pulse && 'pulse')} aria-hidden />;
}

/** A slim progress track — percent-filled, or empty (0%) when the total size is unknown; the caller
 *  renders the "unknown size" text alongside it. */
export function Bar({ percent, className }: { percent: number | null; className?: string }) {
  const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div
      className={cn('h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-hover', className)}
      aria-hidden="true"
    >
      <span
        className="block h-full rounded-full bg-primary transition-[width]"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/** A quiet one-line message (a loading line, "no variants"). Lists use the kit's EmptyState. */
export function Empty({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn('px-1 py-4 text-xs text-faint', className)}>{children}</p>;
}

/** A boxed warn/error notice (a truncated preview sample, a failed action). */
export function Alert({
  variant,
  children,
  className,
}: {
  variant: 'warn' | 'error';
  children: ReactNode;
  className?: string;
}) {
  return (
    <p
      role="alert"
      className={cn(
        'mono rounded-md border px-3 py-1.5 text-[11px]',
        variant === 'warn'
          ? 'border-warn/30 bg-warn/10 text-warn'
          : 'border-bad/30 bg-bad/10 text-bad',
        className,
      )}
    >
      {children}
    </p>
  );
}

/** A label + control pair stacked: caps label above, field below. */
export function Field({
  id,
  label,
  children,
  className,
}: {
  id: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={id}
        className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint"
      >
        {label}
      </label>
      {children}
    </div>
  );
}

/**
 * A modal dialog on the kit's Dialog (Base UI): focus trap, focus restore, scroll lock and Esc /
 * outside-press come from the primitive. Optional `footer` pins actions to the bottom;
 * `initialFocus` picks the field focused (and, for a text input, selected) on open.
 *
 * Mounted-means-open: every caller renders this conditionally, so closing is reported through
 * `onClose`, which unmounts it.
 */
export function Modal({
  title,
  onClose,
  children,
  footer,
  initialFocus,
  className,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className={cn('gap-4 sm:max-w-lg', className)}
        // Select-on-open rather than just focus-on-open: a rename/copy dialog opens with the current
        // name in the field, and the point is to be able to type straight over it.
        initialFocus={() => {
          const element = initialFocus?.current;
          if (element instanceof HTMLInputElement) element.select();
          return element ?? true;
        }}
      >
        <DialogHeader>
          <DialogTitle className="pr-8 text-[15px] font-semibold tracking-tight">
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0">{children}</div>
        {footer && <DialogFooter>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

/* Toasts ------------------------------------------------------------------------------------------
 * A transient corner notification, so a failed (or succeeded) action reports without a blocking
 * browser dialog. Success auto-dismisses quickly; an error lingers longer and can also be dismissed
 * by hand. Provided app-wide (`main.tsx` wraps the whole tree once). */
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
      className={cn(
        'agora-rise flex items-start gap-2 rounded-lg border bg-popover px-3 py-2.5 text-xs text-fg shadow-xl',
        toast.tone === 'error' ? 'border-bad/40' : 'border-brand-border',
      )}
    >
      <span
        className={cn(
          'mt-px shrink-0 [&_svg]:size-3.5',
          toast.tone === 'error' ? 'text-bad' : 'text-brand',
        )}
        aria-hidden
      >
        {toast.tone === 'error' ? <XIcon /> : <CheckIcon />}
      </span>
      <span className="flex-1 wrap-break-word">{toast.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-faint transition-colors hover:text-fg [&_svg]:size-3.5"
      >
        <XIcon />
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
            className="fixed right-4 bottom-4 z-60 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
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
