import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import type { SearchResult } from '../api/types.js';
import { formatCount } from '../lib/format.js';
import { ResultCard } from './ResultCard.js';

/**
 * Windowing strategy: fixed-size chunks with an explicit "Show more" control.
 *
 * A streamed search can produce many hundreds of results, and each card is a
 * tall, stateful thing — expandable technical panel, popover, audio element.
 * Pixel-measured virtualisation would have to guess or measure those variable
 * heights, and recycling rows would tear down the open panels and the playing
 * preview inside them. Chunking renders a bounded number of cards (40 at a
 * time, so the DOM stays small no matter how many results arrive), never
 * unmounts a card a person has already interacted with, keeps focus order
 * stable, and needs no scroll maths. New results streaming in simply extend the
 * list beyond the window; the count in the "Show more" label updates live.
 */
const CHUNK_SIZE = 40;

export interface ResultListProps {
  readonly results: readonly SearchResult[];
  readonly searchId: string | null;
  readonly savedResultIds: ReadonlySet<string>;
  readonly savePendingIds: ReadonlySet<string>;
  readonly onToggleSave: (result: SearchResult) => void;
  readonly onOpenConnectors: () => void;
  /** Changing this resets the window — a new search starts at the top. */
  readonly resetKey: string;
}

export function ResultList({
  results,
  searchId,
  savedResultIds,
  savePendingIds,
  onToggleSave,
  onOpenConnectors,
  resetKey,
}: ResultListProps): ReactElement {
  const [visibleCount, setVisibleCount] = useState(CHUNK_SIZE);

  useEffect(() => {
    setVisibleCount(CHUNK_SIZE);
  }, [resetKey]);

  const visible = results.slice(0, visibleCount);
  const remaining = results.length - visible.length;

  return (
    <div className="au-results">
      <ul className="au-results__list">
        {visible.map((result) => (
          <li key={result.id} className="au-results__item">
            <ResultCard
              result={result}
              searchId={searchId}
              saved={savedResultIds.has(result.id)}
              savePending={savePendingIds.has(result.id)}
              onToggleSave={onToggleSave}
              onOpenConnectors={onOpenConnectors}
            />
          </li>
        ))}
      </ul>

      {remaining > 0 ? (
        <div className="au-results__more">
          <button
            type="button"
            className="au-button au-button--large"
            onClick={() => setVisibleCount((count) => count + CHUNK_SIZE)}
          >
            Show {formatCount(Math.min(CHUNK_SIZE, remaining))} more
          </button>
          <p className="au-results__remaining">
            {formatCount(remaining)} more result{remaining === 1 ? '' : 's'} not shown yet.
          </p>
        </div>
      ) : null}
    </div>
  );
}
