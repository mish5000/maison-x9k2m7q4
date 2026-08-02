import { useRef } from 'react';
import type { ReactElement } from 'react';

import type { SavedItemSummary } from '../api/types.js';
import { useFocusTrap } from '../hooks/useFocusTrap.js';
import { formatDate, formatDuration, formatToken } from '../lib/format.js';
import { Icon } from './Icon.js';
import { Notice } from './Notice.js';

export interface SavedDrawerProps {
  readonly open: boolean;
  readonly items: readonly SavedItemSummary[];
  readonly status: 'idle' | 'loading' | 'ready' | 'error';
  readonly error: string | null;
  readonly onClose: () => void;
  readonly onRemove: (savedId: string) => void;
  readonly onReload: () => void;
  readonly removingIds: ReadonlySet<string>;
}

export function SavedDrawer({
  open,
  items,
  status,
  error,
  onClose,
  onRemove,
  onReload,
  removingIds,
}: SavedDrawerProps): ReactElement | null {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(panelRef, open, onClose);

  if (!open) {
    return null;
  }

  return (
    <div className="au-drawer-root">
      <div className="au-drawer__scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="au-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="au-saved-heading"
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="au-drawer__head">
          <h2 className="au-drawer__title" id="au-saved-heading">
            Saved
          </h2>
          <button
            type="button"
            className="au-icon-button"
            onClick={onClose}
            aria-label="Close saved items"
          >
            <Icon name="close" size={16} />
          </button>
        </div>

        <div className="au-drawer__body">
          {status === 'loading' ? <p className="au-hint">Loading your saved items…</p> : null}

          {status === 'error' ? (
            <Notice tone="warning" title="Saved items could not be loaded">
              <p>{error ?? 'Try again in a moment.'}</p>
              <p>
                <button type="button" className="au-link-button" onClick={onReload}>
                  Try again
                </button>
              </p>
            </Notice>
          ) : null}

          {status === 'ready' && items.length === 0 ? (
            <Notice tone="neutral" title="Nothing saved yet">
              <p>Save a result from any search and it will be listed here.</p>
            </Notice>
          ) : null}

          {items.length > 0 ? (
            <ul className="au-saved__list">
              {items.map((item) => {
                const facts = [
                  formatToken(item.format),
                  formatDuration(item.durationSeconds),
                  item.sourceName,
                  formatDate(item.savedAt) ? `Saved ${formatDate(item.savedAt)}` : null,
                ].filter((entry): entry is string => Boolean(entry));

                return (
                  <li key={item.id} className="au-saved__item">
                    <div className="au-saved__text">
                      <p className="au-saved__title">{item.title}</p>
                      {item.creator ? <p className="au-saved__creator">{item.creator}</p> : null}
                      <p className="au-saved__facts">{facts.join(' · ')}</p>
                      {item.note ? <p className="au-saved__note">{item.note}</p> : null}
                      {item.pageUrl ? (
                        <a
                          className="au-link"
                          href={item.pageUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          referrerPolicy="no-referrer"
                        >
                          Open source page
                          <span className="au-visually-hidden"> (opens in a new tab)</span>
                        </a>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="au-button au-button--quiet"
                      onClick={() => onRemove(item.id)}
                      disabled={removingIds.has(item.id)}
                    >
                      Remove
                      <span className="au-visually-hidden"> {item.title}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
