import { type VariantProps, cva } from 'class-variance-authority';
import { forwardRef } from 'react';
import { cn } from './cn';

/**
 * A vendored shadcn-style Alert on the Aviary tokens. Ported verbatim from the NestJS sibling
 * console's `src/app/ui/alert.tsx`. One recipe covers the three notices this console shows: the
 * quiet empty/loading text every pane uses, and the boxed warn/error banners (a truncated preview
 * sample, a failed read).
 *
 * `muted` is deliberately chrome-free — an empty state is not an alarm, and boxing it would make
 * every empty folder look like a problem.
 */
export const alertVariants = cva('', {
  variants: {
    variant: {
      muted: 'px-1 py-6 text-sm text-zinc-600',
      warn: 'mono rounded-md border border-warn/30 bg-warn/10 px-3 py-1.5 text-[11px] text-warn',
      error: 'mono rounded-md border border-bad/30 bg-bad/10 px-3 py-1.5 text-[11px] text-bad',
    },
  },
  defaultVariants: { variant: 'muted' },
});

export interface AlertProps
  extends React.HTMLAttributes<HTMLParagraphElement>,
    VariantProps<typeof alertVariants> {}

export const Alert = forwardRef<HTMLParagraphElement, AlertProps>(
  ({ className, variant, ...props }, ref) => (
    <p
      ref={ref}
      // Only the loud variants announce; a "this folder is empty" line read out on every navigation
      // is noise, not information.
      {...(variant === 'error' || variant === 'warn' ? { role: 'alert' } : {})}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  ),
);
Alert.displayName = 'Alert';
