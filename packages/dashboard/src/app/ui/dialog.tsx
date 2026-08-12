import { Dialog as BaseDialog } from '@base-ui-components/react/dialog';
import { forwardRef } from 'react';
import { cn } from './cn';

/**
 * The console's modal primitive: vendored shadcn Dialog on Base UI. Ported verbatim from the
 * NestJS sibling console's `src/app/ui/dialog.tsx` — one primitive layer across every Aviary
 * console, Dialog included.
 *
 * Base UI supplies what a hand-rolled `createPortal` + fixed-backdrop div never did: a real focus
 * trap, focus restored to whatever opened the dialog, `aria-modal` with the title/description wired
 * by id, scroll lock, an inert background, and Esc / outside-press dismissal — with `initialFocus`
 * as a first-class prop rather than a `useEffect` race against the browser.
 *
 * Everything here is styling over Base UI parts; the tokens come from `tailwind.config.ts`.
 */

export const DialogRoot = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogPortal = BaseDialog.Portal;
export const DialogClose = BaseDialog.Close;

export const DialogBackdrop = forwardRef<HTMLDivElement, BaseDialog.Backdrop.Props>(
  ({ className, ...props }, ref) => (
    <BaseDialog.Backdrop
      ref={ref}
      className={cn('fixed inset-0 z-50 bg-black/80 backdrop-blur-sm', className)}
      {...props}
    />
  ),
);
DialogBackdrop.displayName = 'DialogBackdrop';

export const DialogPopup = forwardRef<HTMLDivElement, BaseDialog.Popup.Props>(
  ({ className, ...props }, ref) => (
    <BaseDialog.Popup
      ref={ref}
      className={cn(
        // `--panel-2` is the shared elevated surface: a dialog sits above the page, so it must not
        // be the same colour as the panels behind it.
        'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-3rem)] w-full max-w-md -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg border border-border bg-panel-2 text-foreground shadow-2xl outline-none',
        className,
      )}
      {...props}
    />
  ),
);
DialogPopup.displayName = 'DialogPopup';

export const DialogTitle = forwardRef<HTMLHeadingElement, BaseDialog.Title.Props>(
  ({ className, ...props }, ref) => (
    <BaseDialog.Title
      ref={ref}
      className={cn('mono text-xs font-normal uppercase tracking-wider text-zinc-300', className)}
      {...props}
    />
  ),
);
DialogTitle.displayName = 'DialogTitle';

export const DialogDescription = forwardRef<HTMLParagraphElement, BaseDialog.Description.Props>(
  ({ className, ...props }, ref) => (
    <BaseDialog.Description
      ref={ref}
      className={cn('text-sm text-zinc-400', className)}
      {...props}
    />
  ),
);
DialogDescription.displayName = 'DialogDescription';
