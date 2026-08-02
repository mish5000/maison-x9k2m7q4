import { useId } from 'react';
import type { FormEvent, ReactElement, RefObject } from 'react';

import type { ProviderSummary } from '../api/types.js';
import { MAX_QUERY_LENGTH } from '../api/vocabulary.js';
import type { DraftErrors, SearchDraft } from '../lib/searchDraft.js';
import { countActiveFilters } from '../lib/searchDraft.js';
import { AdvancedPanel } from './AdvancedPanel.js';
import { Icon } from './Icon.js';

export interface SearchFormProps {
  readonly variant: 'hero' | 'compact';
  readonly query: string;
  readonly onQueryChange: (value: string) => void;
  readonly draft: SearchDraft;
  readonly onDraftChange: (next: SearchDraft) => void;
  readonly onClearFilters: () => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly busy: boolean;
  readonly errors: DraftErrors;
  readonly advancedOpen: boolean;
  readonly onAdvancedToggle: (open: boolean) => void;
  readonly providers: readonly ProviderSummary[];
  readonly providersStatus: 'idle' | 'loading' | 'ready' | 'error';
  readonly providersError: string | null;
  readonly onRetryProviders: () => void;
  readonly inputRef: RefObject<HTMLInputElement | null>;
}

export const SEARCH_PLACEHOLDER = 'Search a title, recording, episode, filename, artist, speech…';

export function SearchForm({
  variant,
  query,
  onQueryChange,
  draft,
  onDraftChange,
  onClearFilters,
  onSubmit,
  onCancel,
  busy,
  errors,
  advancedOpen,
  onAdvancedToggle,
  providers,
  providersStatus,
  providersError,
  onRetryProviders,
  inputRef,
}: SearchFormProps): ReactElement {
  const baseId = useId();
  const inputId = `${baseId}-query`;
  const errorId = `${baseId}-query-error`;
  const panelId = `${baseId}-advanced`;
  const activeFilters = countActiveFilters(draft);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form
      className={`au-search au-search--${variant}`}
      role="search"
      onSubmit={handleSubmit}
      noValidate
    >
      <div className="au-search__row">
        <div className="au-search__field">
          <label className="au-visually-hidden" htmlFor={inputId}>
            Search for audio
          </label>
          <span className="au-search__icon" aria-hidden="true">
            <Icon name="search" size={variant === 'hero' ? 20 : 16} />
          </span>
          <input
            id={inputId}
            ref={inputRef}
            className="au-search__input"
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={MAX_QUERY_LENGTH}
            placeholder={SEARCH_PLACEHOLDER}
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            aria-describedby={errors.query ? errorId : undefined}
            aria-invalid={errors.query ? true : undefined}
          />
        </div>
        {busy ? (
          <button type="button" className="au-button au-button--large" onClick={onCancel}>
            <Icon name="stop" size={14} />
            Cancel
          </button>
        ) : (
          <button type="submit" className="au-button au-button--primary au-button--large">
            Search
          </button>
        )}
      </div>

      {errors.query ? (
        <p className="au-error-text au-search__error" id={errorId} role="alert">
          {errors.query}
        </p>
      ) : null}

      <div className="au-search__tools">
        <button
          type="button"
          className="au-disclosure"
          aria-expanded={advancedOpen}
          aria-controls={panelId}
          onClick={() => onAdvancedToggle(!advancedOpen)}
        >
          <span className="au-disclosure__marker" data-open={advancedOpen ? 'true' : 'false'}>
            <Icon name="chevron" size={14} />
          </span>
          Advanced
          {activeFilters > 0 ? (
            <span className="au-disclosure__count">
              {activeFilters} active
              <span className="au-visually-hidden"> filter{activeFilters === 1 ? '' : 's'}</span>
            </span>
          ) : null}
        </button>
      </div>

      <AdvancedPanel
        id={panelId}
        open={advancedOpen}
        draft={draft}
        onChange={onDraftChange}
        providers={providers}
        providersStatus={providersStatus}
        providersError={providersError}
        onRetryProviders={onRetryProviders}
        errors={errors}
        onClear={onClearFilters}
      />
    </form>
  );
}
