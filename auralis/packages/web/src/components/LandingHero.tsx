import type { ReactElement, ReactNode } from 'react';

import { Wordmark } from './Wordmark.js';

export interface LandingHeroProps {
  readonly children: ReactNode;
  readonly recent: ReactNode;
}

export function LandingHero({ children, recent }: LandingHeroProps): ReactElement {
  return (
    <div className="au-landing">
      <div className="au-landing__inner">
        <h1 className="au-landing__wordmark">
          <Wordmark size="lg" />
        </h1>
        <p className="au-landing__descriptor">
          Find the sound. Verify the file. One query, searched across every source you allow.
        </p>

        {children}

        <p className="au-landing__privacy">
          Searches stay on this device unless you connect a source.
        </p>

        <p className="au-landing__shortcuts">
          <kbd className="au-kbd">/</kbd> focuses search
          <span className="au-landing__shortcut-sep" aria-hidden="true">
            ·
          </span>
          <kbd className="au-kbd">Esc</kbd> cancels a running search
        </p>

        {recent}
      </div>
    </div>
  );
}
