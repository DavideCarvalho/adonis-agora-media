import type { ReactNode, SVGProps } from 'react';

/** Media's own 16px stroke glyphs (same grid and weight as the kit's `icons.tsx`). */

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function glyph(paths: ReactNode) {
  // biome-ignore lint/correctness/noComponentHookFactories: a static icon table built once at module load, no hooks inside
  return function Icon({ size = 16, ...props }: IconProps) {
    return (
      <svg
        viewBox="0 0 16 16"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

/** Library: a folder. */
export const FolderIcon = glyph(
  <path d="M1.75 4.25c0-.55.45-1 1-1h3.1l1.4 1.5h5.9c.55 0 1 .45 1 1v6.5c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z" />,
);
/** Collections: stacked layers. */
export const LayersIcon = glyph(
  <>
    <path d="M8 1.75 14.25 5 8 8.25 1.75 5z" />
    <path d="m1.75 8 6.25 3.25L14.25 8" />
    <path d="m1.75 11 6.25 3.25L14.25 11" />
  </>,
);
/** Uploads (in progress): arrows moving through a track. */
export const TransferIcon = glyph(
  <>
    <path d="M2 5.5h10.5M10 3l2.5 2.5L10 8" />
    <path d="M14 10.5H3.5M6 8l-2.5 2.5L6 13" />
  </>,
);
/** Upload: an arrow into a tray. */
export const UploadIcon = glyph(
  <>
    <path d="M8 10.5V2.25M5 5.25l3-3 3 3" />
    <path d="M2.25 10v2.75c0 .55.45 1 1 1h9.5c.55 0 1-.45 1-1V10" />
  </>,
);
export const FileIcon = glyph(
  <>
    <path d="M4 1.75h5l3 3v9.5H4z" />
    <path d="M9 1.75v3h3" />
  </>,
);
export const PlusIcon = glyph(<path d="M8 3v10M3 8h10" />);
export const ArrowLeftIcon = glyph(<path d="M13 8H3M7 4 3 8l4 4" />);
export const ExternalIcon = glyph(
  <>
    <path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
    <path d="M12 9.5v3.25c0 .41-.34.75-.75.75h-7.5a.75.75 0 0 1-.75-.75v-7.5c0-.41.34-.75.75-.75H7" />
  </>,
);
export const EyeIcon = glyph(
  <>
    <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="2" />
  </>,
);
export const HardDriveIcon = glyph(
  <>
    <rect x="1.75" y="9" width="12.5" height="4.5" rx="1" />
    <path d="M3.5 9 5 3h6l1.5 6M11.5 11.25h.01" />
  </>,
);

/** The media brand mark: three stacked media layers, in currentColor so it takes the accent. */
export function LogoMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="media"
    >
      <title>media</title>
      <path d="M12 3 21 7.5 12 12 3 7.5z" opacity={0.9} />
      <path d="M3 12l9 4.5L21 12" opacity={0.55} />
      <path d="M3 16.5 12 21l9-4.5" opacity={0.3} />
    </svg>
  );
}
