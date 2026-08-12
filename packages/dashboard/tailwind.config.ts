import type { Config } from 'tailwindcss';

/**
 * Tailwind is wired so the semantic class names shadcn generates (`bg-background`, `text-muted-
 * foreground`, `border-border`, `bg-primary`, …) resolve to the Aviary console tokens declared in
 * `src/app/styles.css` — NOT to shadcn's default zinc/slate palette. Vendored primitives under
 * `src/app/ui/` can then be pasted in near-verbatim and come out looking like the NestJS sibling
 * console (`@dudousxd/nestjs-media-dashboard`), which this file's token mapping is copied from
 * verbatim so the two stay pixel-for-pixel identical.
 *
 * Token names follow AVIARY-UI.md, which is the source of truth for the shared set. Note that
 * `accent` here means the Aviary brand accent (one per console), not shadcn's "hover surface" —
 * the vendored components use `bg-muted`-style neutrals for hover instead.
 */

/**
 * Resolve a CSS custom property as a Tailwind colour that still honours the `/50` alpha modifier.
 * A bare `var(--x)` silently ignores `bg-accent/10`, which is most of how this console tints
 * surfaces; `color-mix` keeps that working while the tokens stay readable hex in one place.
 */
function token(name: string) {
  return ({ opacityValue }: { opacityValue?: string } = {}): string =>
    opacityValue === undefined || opacityValue === ''
      ? `var(${name})`
      : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;
}

export default {
  content: ['./index.html', './src/app/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Aviary tokens, under their own names.
        panel: token('--panel'),
        'panel-2': token('--panel-2'),
        line: token('--line'),
        'line-soft': token('--line-soft'),
        good: token('--good'),
        warn: token('--warn'),
        bad: token('--bad'),

        // The shadcn vocabulary, pointed at the same tokens.
        background: token('--bg'),
        foreground: token('--text'),
        border: token('--line'),
        input: token('--line'),
        ring: token('--accent'),
        card: { DEFAULT: token('--panel'), foreground: token('--text') },
        popover: { DEFAULT: token('--panel-2'), foreground: token('--text') },
        muted: { DEFAULT: token('--line-soft'), foreground: token('--muted') },
        primary: { DEFAULT: token('--accent'), foreground: token('--bg') },
        secondary: { DEFAULT: token('--line-soft'), foreground: token('--text') },
        accent: { DEFAULT: token('--accent'), foreground: token('--bg') },
        destructive: { DEFAULT: token('--bad'), foreground: token('--bg') },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
