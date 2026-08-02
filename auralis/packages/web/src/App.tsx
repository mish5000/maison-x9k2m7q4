import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';

import { deleteSaved, listProviders, listSaved, saveItem, toUserMessage } from './api/client.js';
import type { ProviderSummary, SavedItemSummary, SearchResult } from './api/types.js';
import { DEFAULT_COMPATIBILITY_PROFILE_IDS, DEFAULT_LOCALE } from './api/vocabulary.js';
import { ConnectorsView } from './components/ConnectorsView.js';
import { DiagnosticsView } from './components/DiagnosticsView.js';
import { Icon } from './components/Icon.js';
import { LandingHero } from './components/LandingHero.js';
import { Notice } from './components/Notice.js';
import { RecentSearches } from './components/RecentSearches.js';
import { SavedDrawer } from './components/SavedDrawer.js';
import { SearchForm } from './components/SearchForm.js';
import { SearchResults } from './components/SearchResults.js';
import { Wordmark } from './components/Wordmark.js';
import { useOnlineStatus } from './hooks/useOnlineStatus.js';
import { PreviewProvider } from './hooks/usePreviewController.js';
import { useRecentSearches } from './hooks/useRecentSearches.js';
import { useResource } from './hooks/useResource.js';
import { useSearchStream } from './hooks/useSearchStream.js';
import type { DraftErrors, SearchDraft } from './lib/searchDraft.js';
import { EMPTY_DRAFT, validateDraft } from './lib/searchDraft.js';

type View = 'search' | 'connectors' | 'diagnostics';

const DEV_BUILD = import.meta.env.DEV;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    target.isContentEditable ||
    tag === 'audio'
  );
}

export function App(): ReactElement {
  const [view, setView] = useState<View>('search');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<SearchDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [savedByResultId, setSavedByResultId] = useState<ReadonlyMap<string, string>>(new Map());
  const [savePendingIds, setSavePendingIds] = useState<ReadonlySet<string>>(new Set());
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const online = useOnlineStatus();
  const recent = useRecentSearches();
  const { session, start, cancel, reset, isActive } = useSearchStream();

  const providers = useResource<readonly ProviderSummary[]>(
    useCallback((signal: AbortSignal) => listProviders(signal), []),
    [],
  );

  const saved = useResource<readonly SavedItemSummary[]>(
    useCallback((signal: AbortSignal) => listSaved(signal), []),
    [],
    { enabled: drawerOpen },
  );

  const runSearch = useCallback(
    (text: string, nextDraft: SearchDraft) => {
      const validation = validateDraft(text, nextDraft);
      setErrors(validation.errors);
      if (Object.keys(validation.errors).length > 0) {
        if (validation.errors.query) {
          inputRef.current?.focus();
        } else {
          setAdvancedOpen(true);
        }
        return;
      }

      const trimmed = text.trim();
      recent.remember(trimmed);
      setView('search');
      void start({
        query: trimmed,
        mode: nextDraft.mode,
        ...(validation.filters ? { filters: validation.filters } : {}),
        compatibilityProfileIds: DEFAULT_COMPATIBILITY_PROFILE_IDS,
        locale: DEFAULT_LOCALE,
      });
    },
    [recent, start],
  );

  const handleSubmit = useCallback(() => runSearch(query, draft), [runSearch, query, draft]);

  const handleRecentSelect = useCallback(
    (value: string) => {
      setQuery(value);
      runSearch(value, draft);
    },
    [runSearch, draft],
  );

  const handleNewSearch = useCallback(() => {
    reset();
    setQuery('');
    setErrors({});
    setView('search');
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [reset]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key === '/' && !isTypingTarget(event.target)) {
        event.preventDefault();
        setView('search');
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (event.key === 'Escape' && isActive) {
        event.preventDefault();
        cancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [cancel, isActive]);

  const toggleSave = useCallback(
    async (result: SearchResult): Promise<void> => {
      setSaveError(null);
      const existing = savedByResultId.get(result.id);
      setSavePendingIds((current) => new Set(current).add(result.id));
      try {
        if (existing) {
          await deleteSaved(existing);
          setSavedByResultId((current) => {
            const next = new Map(current);
            next.delete(result.id);
            return next;
          });
          saved.setData((items) => items.filter((item) => item.id !== existing));
        } else {
          if (!session.searchId) {
            setSaveError('This result can no longer be saved. Run the search again.');
            return;
          }
          const item = await saveItem({ searchId: session.searchId, resultId: result.id });
          setSavedByResultId((current) => new Map(current).set(result.id, item.id));
          saved.setData((items) => [item, ...items.filter((entry) => entry.id !== item.id)]);
        }
      } catch (error) {
        setSaveError(toUserMessage(error));
      } finally {
        setSavePendingIds((current) => {
          const next = new Set(current);
          next.delete(result.id);
          return next;
        });
      }
    },
    [savedByResultId, session.searchId, saved],
  );

  const removeSaved = useCallback(
    async (savedId: string): Promise<void> => {
      setRemovingIds((current) => new Set(current).add(savedId));
      try {
        await deleteSaved(savedId);
        saved.setData((items) => items.filter((item) => item.id !== savedId));
        setSavedByResultId((current) => {
          const next = new Map(current);
          for (const [resultId, id] of next) {
            if (id === savedId) next.delete(resultId);
          }
          return next;
        });
      } catch (error) {
        setSaveError(toUserMessage(error));
      } finally {
        setRemovingIds((current) => {
          const next = new Set(current);
          next.delete(savedId);
          return next;
        });
      }
    },
    [saved],
  );

  const savedResultIds = useMemo(() => new Set(savedByResultId.keys()), [savedByResultId]);

  const searchActive = session.status !== 'idle';

  const searchForm = (
    <SearchForm
      variant={searchActive ? 'compact' : 'hero'}
      query={query}
      onQueryChange={setQuery}
      draft={draft}
      onDraftChange={setDraft}
      onClearFilters={() => setDraft({ ...EMPTY_DRAFT, mode: draft.mode })}
      onSubmit={handleSubmit}
      onCancel={cancel}
      busy={isActive}
      errors={errors}
      advancedOpen={advancedOpen}
      onAdvancedToggle={setAdvancedOpen}
      providers={providers.data}
      providersStatus={providers.status}
      providersError={providers.error}
      onRetryProviders={providers.reload}
      inputRef={inputRef}
    />
  );

  return (
    <PreviewProvider>
      <div className="au-shell">
        <a className="au-skip-link" href="#au-main">
          Skip to main content
        </a>

        <header className={`au-header${searchActive ? ' au-header--sticky' : ''}`}>
          <div className="au-page au-header__inner">
            <div className="au-header__brand">
              <button
                type="button"
                className="au-header__home"
                onClick={handleNewSearch}
                aria-label="Auralis — start a new search"
              >
                <Wordmark />
              </button>
              <span className="au-header__tagline">Find the sound. Verify the file.</span>
            </div>

            <nav className="au-nav" aria-label="Main">
              <button
                type="button"
                className="au-nav__item"
                onClick={() => setView('search')}
                aria-current={view === 'search' ? 'page' : undefined}
              >
                Search
              </button>
              <button
                type="button"
                className="au-nav__item"
                onClick={() => setView('connectors')}
                aria-current={view === 'connectors' ? 'page' : undefined}
              >
                Sources
              </button>
              {DEV_BUILD ? (
                <button
                  type="button"
                  className="au-nav__item"
                  onClick={() => setView('diagnostics')}
                  aria-current={view === 'diagnostics' ? 'page' : undefined}
                >
                  Diagnostics
                </button>
              ) : null}
              <button
                type="button"
                className="au-nav__item au-nav__item--saved"
                onClick={() => setDrawerOpen(true)}
                aria-haspopup="dialog"
              >
                <Icon name="bookmark" size={14} />
                Saved
              </button>
            </nav>
          </div>

          {searchActive && view === 'search' ? (
            <div className="au-page au-header__search">{searchForm}</div>
          ) : null}
        </header>

        <main className="au-main" id="au-main" tabIndex={-1}>
          <div className="au-page">
            {!online ? (
              <div className="au-banner">
                <Notice tone="warning" title="You are offline" compact>
                  <p>Auralis needs a connection to search. Everything already found stays here.</p>
                </Notice>
              </div>
            ) : null}

            {saveError ? (
              <div className="au-banner">
                <Notice tone="warning" title="That could not be saved" compact assertive>
                  <p>{saveError}</p>
                </Notice>
              </div>
            ) : null}

            {view === 'search' && !searchActive ? (
              <LandingHero
                recent={
                  <RecentSearches
                    entries={recent.entries}
                    onSelect={handleRecentSelect}
                    onForget={recent.forget}
                    onClear={recent.clear}
                  />
                }
              >
                {searchForm}
              </LandingHero>
            ) : null}

            {view === 'search' && searchActive ? (
              <SearchResults
                session={session}
                savedResultIds={savedResultIds}
                savePendingIds={savePendingIds}
                onToggleSave={(result) => void toggleSave(result)}
                onOpenConnectors={() => setView('connectors')}
                onRetry={handleSubmit}
                onCancel={cancel}
                online={online}
              />
            ) : null}

            {view === 'connectors' ? (
              <ConnectorsView onConnectorsChanged={providers.reload} />
            ) : null}

            {view === 'diagnostics' && DEV_BUILD ? <DiagnosticsView /> : null}
          </div>
        </main>

        <footer className="au-footer">
          <div className="au-page au-footer__inner">
            <p className="au-footer__line">
              Auralis verifies every file it lists. Nothing here is uploaded, hosted or mirrored.
            </p>
            <p className="au-footer__line au-footer__line--muted">
              Searches stay on this device unless you connect a source.
            </p>
          </div>
        </footer>

        <SavedDrawer
          open={drawerOpen}
          items={saved.data}
          status={saved.status}
          error={saved.error}
          onClose={() => setDrawerOpen(false)}
          onRemove={(savedId) => void removeSaved(savedId)}
          onReload={saved.reload}
          removingIds={removingIds}
        />
      </div>
    </PreviewProvider>
  );
}
