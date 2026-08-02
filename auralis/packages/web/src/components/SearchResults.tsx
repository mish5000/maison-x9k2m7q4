import { useMemo } from 'react';
import type { ReactElement } from 'react';

import type { SearchResult } from '../api/types.js';
import { useAnnouncer } from '../hooks/useAnnouncer.js';
import { useElapsed } from '../hooks/useElapsed.js';
import type { ProviderRun, SearchSession } from '../hooks/useSearchStream.js';
import { formatCount, formatElapsed } from '../lib/format.js';
import { outcomeDisplay } from '../lib/labels.js';
import { Notice } from './Notice.js';
import { ResultList } from './ResultList.js';
import { SearchProgress } from './SearchProgress.js';

const FAILED_OUTCOMES = new Set(['timeout', 'rate_limited', 'error', 'circuit_open']);
const SETUP_OUTCOMES = new Set(['not_configured', 'auth_required']);
const FINISHED_STATES = new Set([
  'ok',
  'empty',
  'timeout',
  'rate_limited',
  'error',
  'cancelled',
  'circuit_open',
  'not_configured',
  'auth_required',
]);

function summarise(session: SearchSession, elapsedMs: number): string {
  const count = session.results.length;
  const { progress } = session;
  switch (session.status) {
    case 'starting':
      return 'Starting the search.';
    case 'streaming':
      return `${formatCount(progress.providersCompleted)} of ${formatCount(
        Math.max(progress.providersTotal, session.providers.length),
      )} sources finished. ${formatCount(count)} result${count === 1 ? '' : 's'} so far, ${formatCount(
        progress.candidatesVerified,
      )} verified. ${formatElapsed(elapsedMs)} elapsed.`;
    case 'completed':
      return count === 0
        ? 'Search finished with no matches.'
        : `Search finished with ${formatCount(count)} result${count === 1 ? '' : 's'}.`;
    case 'cancelled':
      return `Search cancelled with ${formatCount(count)} result${count === 1 ? '' : 's'} kept.`;
    case 'failed':
      return session.errorMessage ?? 'The search could not be completed.';
    default:
      return '';
  }
}

export interface SearchResultsProps {
  readonly session: SearchSession;
  readonly savedResultIds: ReadonlySet<string>;
  readonly savePendingIds: ReadonlySet<string>;
  readonly onToggleSave: (result: SearchResult) => void;
  readonly onOpenConnectors: () => void;
  readonly onRetry: () => void;
  readonly onCancel: () => void;
  readonly online: boolean;
}

export function SearchResults({
  session,
  savedResultIds,
  savePendingIds,
  onToggleSave,
  onOpenConnectors,
  onRetry,
  onCancel,
  online,
}: SearchResultsProps): ReactElement {
  const running = session.status === 'starting' || session.status === 'streaming';
  const elapsedMs = useElapsed(session.startedAtMs, running);
  const shownElapsed = running
    ? Math.max(elapsedMs, session.progress.elapsedMs)
    : session.progress.elapsedMs || elapsedMs;

  const announcement = useAnnouncer(summarise(session, shownElapsed), {
    immediate: !running,
    intervalMs: 2000,
  });

  const finished = useMemo(
    () => session.providers.filter((run: ProviderRun) => FINISHED_STATES.has(run.state)),
    [session.providers],
  );
  const failed = useMemo(
    () => session.providers.filter((run) => FAILED_OUTCOMES.has(run.state)),
    [session.providers],
  );
  const needSetup = useMemo(
    () => session.providers.filter((run) => SETUP_OUTCOMES.has(run.state)),
    [session.providers],
  );
  const rateLimited = useMemo(
    () => session.providers.filter((run) => run.state === 'rate_limited'),
    [session.providers],
  );

  const allFinished = session.providers.length > 0 && finished.length === session.providers.length;
  const totalOutage = allFinished && failed.length + needSetup.length === session.providers.length;
  const partialOutage = !totalOutage && (failed.length > 0 || needSetup.length > 0);
  const hasResults = session.results.length > 0;

  return (
    <div className="au-search-view">
      <div className="au-search-view__head">
        <h1 className="au-search-view__title">
          Results for <span className="au-search-view__query">{session.query}</span>
        </h1>
        {session.normalizedQuery && session.normalizedQuery !== session.query ? (
          <p className="au-search-view__normalized">Searched as “{session.normalizedQuery}”</p>
        ) : null}
      </div>

      <p className="au-visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      <SearchProgress
        session={session}
        elapsedMs={shownElapsed}
        running={running}
        onCancel={onCancel}
      />

      <div className="au-states">
        {!online ? (
          <Notice tone="warning" title="You are offline">
            <p>Auralis will start searching again as soon as the connection is back.</p>
          </Notice>
        ) : null}

        {session.connectionLost && running ? (
          <Notice tone="warning" title="Reconnecting to the search">
            <p>The live connection dropped. Results already found are still listed below.</p>
          </Notice>
        ) : null}

        {session.status === 'failed' ? (
          <Notice
            tone="danger"
            title={
              session.connectionLost
                ? 'The search stopped early'
                : 'The search could not be completed'
            }
            assertive
            actions={
              <button type="button" className="au-button" onClick={onRetry}>
                Try the search again
              </button>
            }
          >
            <p>{session.errorMessage ?? 'Something went wrong inside Auralis.'}</p>
            {session.correlationId ? (
              <details className="au-details">
                <summary className="au-details__summary">Technical reference</summary>
                <p className="au-details__body">{session.correlationId}</p>
              </details>
            ) : null}
          </Notice>
        ) : null}

        {session.status === 'cancelled' ? (
          <Notice
            tone="neutral"
            title="Search cancelled"
            actions={
              <button type="button" className="au-button" onClick={onRetry}>
                Search again
              </button>
            }
          >
            <p>
              {hasResults
                ? 'The results found before you cancelled are still listed.'
                : 'Nothing was kept from this search.'}
            </p>
          </Notice>
        ) : null}

        {totalOutage ? (
          <Notice tone="danger" title="No sources could be searched">
            <p>
              Every source either failed or needs setting up. Check your connections and try again.
            </p>
            <ul className="au-notice__list">
              {[...failed, ...needSetup].map((run) => (
                <li key={run.id}>
                  {run.displayName}: {run.message ?? outcomeDisplay(run.state).detail}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}

        {partialOutage ? (
          <Notice tone="warning" title="Some sources did not answer">
            <p>These results are incomplete. Everything below is still real and verified.</p>
            <ul className="au-notice__list">
              {[...failed, ...needSetup].map((run) => (
                <li key={run.id}>
                  {run.displayName}: {run.message ?? outcomeDisplay(run.state).detail}
                </li>
              ))}
            </ul>
          </Notice>
        ) : null}

        {rateLimited.length > 0 ? (
          <Notice tone="warning" title="A source is limiting requests" compact>
            <p>
              {rateLimited.map((run) => run.displayName).join(', ')} asked Auralis to slow down.
              Searching again in a minute usually works.
            </p>
          </Notice>
        ) : null}

        {needSetup.length > 0 ? (
          <Notice
            tone="warning"
            title="Some sources need setting up"
            compact
            actions={
              <button type="button" className="au-button" onClick={onOpenConnectors}>
                Open connected sources
              </button>
            }
          >
            <p>
              {needSetup.map((run) => run.displayName).join(', ')} cannot be searched until they are
              configured.
            </p>
          </Notice>
        ) : null}

        {session.partial && session.status === 'completed' && !partialOutage && !totalOutage ? (
          <Notice tone="neutral" title="Partial results" compact>
            <p>The search reached its time limit before every source finished.</p>
          </Notice>
        ) : null}

        {session.status === 'completed' && !hasResults && !totalOutage ? (
          <Notice tone="neutral" title="No matches">
            <p>
              Nothing matched this search. Try fewer words, a different spelling, or turn off some
              filters in Advanced.
            </p>
          </Notice>
        ) : null}

        {running && !hasResults ? (
          <Notice tone="neutral" title="Searching" compact>
            <p>Sources are being searched now. Results appear here as they are verified.</p>
          </Notice>
        ) : null}
      </div>

      {hasResults ? (
        <section className="au-results-region" aria-labelledby="au-results-heading">
          <div className="au-results-region__head">
            <h2 className="au-results-region__heading" id="au-results-heading">
              {formatCount(session.results.length)} result
              {session.results.length === 1 ? '' : 's'}
            </h2>
            <p className="au-results-region__note">Ordered by how well each one matches.</p>
          </div>
          <ResultList
            results={session.results}
            searchId={session.searchId}
            savedResultIds={savedResultIds}
            savePendingIds={savePendingIds}
            onToggleSave={onToggleSave}
            onOpenConnectors={onOpenConnectors}
            resetKey={session.searchId ?? session.query}
          />
        </section>
      ) : null}
    </div>
  );
}
