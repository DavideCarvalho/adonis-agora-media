import { useRender } from '@base-ui/react/use-render';
import { type VariantProps, cva } from 'class-variance-authority';
import { cn } from './cn';

/**
 * The console's button, vendored shadcn-style: a `cva` recipe over Base UI's `useRender`, written
 * against the Aviary tokens (see `tailwind.config.ts`) rather than shadcn's default palette. Ported
 * verbatim from the NestJS sibling console's `src/app/ui/button.tsx`.
 *
 * The `render` prop is why this is worth having over a hand-rolled version — the console has
 * several links that are visually buttons ("Open ↗", "Open original ↗") and would otherwise carry a
 * duplicated copy of the class string. They render `<Button render={<a href=… />}>` and stay in
 * step with every other button automatically. It is also how a Base UI part (`Dialog.Close`)
 * borrows this button's styling without nesting two `<button>` elements.
 *
 * Tone names are semantic, not hue names: `accent` follows `--accent` wherever the brand call
 * lands, and `destructive` follows `--bad`.
 */
export const buttonVariants = cva(
  'mono inline-flex items-center justify-center gap-1.5 rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-40',
  {
    variants: {
      // Hover is plain `hover:`, not `enabled:hover:` — `:enabled` only ever matches form controls,
      // so an `enabled:` variant silently drops every hover state when `render` makes this an <a>.
      // A disabled button cannot be hovered anyway: the base sets `disabled:pointer-events-none`.
      tone: {
        neutral: 'border-border bg-zinc-800/40 text-zinc-300 hover:bg-zinc-800',
        accent: 'border-accent/30 bg-accent/10 text-accent hover:bg-accent/20',
        destructive: 'border-bad/30 bg-bad/10 text-bad hover:bg-bad/20',
        /** Bordered but unfilled: secondary chrome (close, sign out, reset). */
        ghost: 'border-border bg-transparent text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100',
        /** Chromeless: text only until hovered. For tabs and chips that are not the current one. */
        quiet: 'border-transparent text-zinc-500 hover:text-zinc-300',
        /** The `quiet` pair: the tab/chip you are currently on. */
        selected: 'border-zinc-600 bg-zinc-900 text-zinc-100',
      },
      size: {
        xs: 'px-2 py-1 text-[11px]',
        sm: 'px-3 py-1.5 text-xs',
        md: 'px-3 py-2 text-xs uppercase tracking-wider',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'xs' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Render a different element (a link, a Base UI part) with the button's classes and behaviour. */
  render?: useRender.RenderProp;
}

export function Button({
  className,
  tone,
  size,
  render,
  type,
  ...props
}: ButtonProps): React.ReactElement {
  return useRender({
    // A `<button>` inside a form defaults to submit; every console button that isn't explicitly a
    // submit is an action, so default it here rather than at every call site.
    render: render ?? <button type={type ?? 'button'} />,
    props: { ...props, className: cn(buttonVariants({ tone, size }), className) },
  });
}
