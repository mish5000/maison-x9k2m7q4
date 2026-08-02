/**
 * Inline SVG icons. Always decorative: every icon sits next to a text label or
 * inside a control that carries its own accessible name.
 */

import type { ReactElement } from 'react';

export type IconName =
  | 'search'
  | 'close'
  | 'chevron'
  | 'download'
  | 'external'
  | 'copy'
  | 'bookmark'
  | 'bookmark-filled'
  | 'info'
  | 'check'
  | 'alert'
  | 'stop'
  | 'refresh'
  | 'plug'
  | 'waveform';

const PATHS: Record<IconName, ReactElement> = {
  search: (
    <>
      <circle cx="7.5" cy="7.5" r="5" />
      <path d="M11.2 11.2 14.5 14.5" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  chevron: <path d="M4 6.5 8 10.5 12 6.5" />,
  download: (
    <>
      <path d="M8 2.5v8" />
      <path d="M4.75 7.75 8 11l3.25-3.25" />
      <path d="M3 13.5h10" />
    </>
  ),
  external: (
    <>
      <path d="M9.5 3H13v3.5" />
      <path d="M13 3 7.5 8.5" />
      <path d="M11 9.5v3.5H3V5h3.5" />
    </>
  ),
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5h-7a1 1 0 0 0-1 1v7" />
    </>
  ),
  bookmark: <path d="M4 2.5h8v11l-4-3-4 3z" />,
  'bookmark-filled': <path d="M4 2.5h8v11l-4-3-4 3z" fill="currentColor" />,
  info: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.25v4" />
      <path d="M8 4.9v.6" />
    </>
  ),
  check: <path d="M3.5 8.5 6.5 11.5 12.5 4.75" />,
  alert: (
    <>
      <path d="M8 2.5 14.5 13.5h-13z" />
      <path d="M8 6.5v3.2" />
      <path d="M8 11.4v.6" />
    </>
  ),
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13 2.8V5.4h-2.6" />
    </>
  ),
  plug: (
    <>
      <path d="M6 2.5v3.2M10 2.5v3.2" />
      <path d="M4 5.7h8v2.1a4 4 0 0 1-8 0z" />
      <path d="M8 11.8v1.7" />
    </>
  ),
  waveform: (
    <>
      <path d="M2.5 6.5v3" />
      <path d="M5.75 4v8" />
      <path d="M9 2.5v11" />
      <path d="M12.25 5v6" />
    </>
  ),
};

export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
}

export function Icon({ name, size = 16, className }: IconProps): ReactElement {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
