import type { ReactElement } from 'react';

export interface WordmarkProps {
  readonly size?: 'sm' | 'lg';
}

/**
 * The Auralis mark: four bars of a level meter, set in the accent, followed by
 * the name. Rendered inside whatever element gives it meaning — a heading on
 * the landing screen, a button in the header.
 */
export function Wordmark({ size = 'sm' }: WordmarkProps): ReactElement {
  const glyph = size === 'lg' ? 34 : 18;
  return (
    <span className={`au-wordmark au-wordmark--${size}`}>
      <svg
        className="au-wordmark__glyph"
        width={glyph}
        height={glyph}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M3 9.5v5" />
          <path d="M9 4.5v15" />
          <path d="M15 7v10" />
          <path d="M21 10.5v3" />
        </g>
      </svg>
      <span className="au-wordmark__text">Auralis</span>
    </span>
  );
}
