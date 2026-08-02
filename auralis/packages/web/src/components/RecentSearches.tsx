import type { ReactElement } from 'react';

import { Icon } from './Icon.js';

export interface RecentSearchesProps {
  readonly entries: readonly string[];
  readonly onSelect: (query: string) => void;
  readonly onForget: (query: string) => void;
  readonly onClear: () => void;
}

export function RecentSearches({
  entries,
  onSelect,
  onForget,
  onClear,
}: RecentSearchesProps): ReactElement | null {
  if (entries.length === 0) {
    return null;
  }

  return (
    <section className="au-recent" aria-labelledby="au-recent-heading">
      <div className="au-recent__head">
        <h2 className="au-recent__heading" id="au-recent-heading">
          Recent searches
        </h2>
        <button type="button" className="au-button au-button--quiet" onClick={onClear}>
          Clear
        </button>
      </div>
      <ul className="au-recent__list">
        {entries.map((entry) => (
          <li key={entry} className="au-recent__item">
            <button type="button" className="au-recent__query" onClick={() => onSelect(entry)}>
              {entry}
            </button>
            <button
              type="button"
              className="au-recent__forget"
              onClick={() => onForget(entry)}
              aria-label={`Remove ${entry} from recent searches`}
            >
              <Icon name="close" size={13} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
