import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * The shadcn class helper: `clsx` for conditionals, `tailwind-merge` to resolve conflicts so a
 * caller's `className` actually wins over a component's defaults (`px-2` passed into something that
 * ships `px-3` should override it, not append and lose to source order).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
