import { useCallback } from 'react';
import type { ReactElement } from 'react';

import { providerHealth } from '../api/client.js';
import type { ProviderHealthResponse } from '../api/types.js';
import { useResource } from '../hooks/useResource.js';
import { formatDateTime } from '../lib/format.js';
import { providerStatusLabel, providerStatusTone } from '../lib/labels.js';
import { Notice } from './Notice.js';
import { StatusChip } from './StatusChip.js';

const EMPTY_HEALTH: ProviderHealthResponse = { checkedAt: '', providers: [] };

const CIRCUIT_LABELS: Record<string, string> = {
  closed: 'Normal',
  open: 'Paused after failures',
  half_open: 'Trying again',
};

/** Development-only view. Mounted behind `import.meta.env.DEV` in App. */
export function DiagnosticsView(): ReactElement {
  const health = useResource<ProviderHealthResponse>(
    useCallback((signal: AbortSignal) => providerHealth(signal), []),
    EMPTY_HEALTH,
  );

  return (
    <div className="au-view">
      <header className="au-view__head">
        <h1 className="au-view__title">Diagnostics</h1>
        <p className="au-view__lede">
          Live health of every source the engine can reach. This view is available in development
          builds only.
        </p>
      </header>

      <section className="au-view__section" aria-labelledby="au-diagnostics-heading">
        <div className="au-view__section-head">
          <h2 className="au-view__heading" id="au-diagnostics-heading">
            Source health
          </h2>
          <button type="button" className="au-button" onClick={health.reload}>
            Refresh
          </button>
        </div>

        {health.status === 'loading' ? <p className="au-hint">Checking sources…</p> : null}

        {health.status === 'error' ? (
          <Notice tone="warning" title="Health could not be read">
            <p>{health.error ?? 'Try again in a moment.'}</p>
          </Notice>
        ) : null}

        {health.data.checkedAt ? (
          <p className="au-hint">Checked {formatDateTime(health.data.checkedAt) ?? 'just now'}</p>
        ) : null}

        {health.data.providers.length > 0 ? (
          <div className="au-scroll-x">
            <table className="au-table au-table--grid">
              <caption className="au-table__caption">Providers</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Status</th>
                  <th scope="col">Message</th>
                  <th scope="col">Latency</th>
                  <th scope="col">Circuit</th>
                  <th scope="col">Setup notes</th>
                </tr>
              </thead>
              <tbody>
                {health.data.providers.map((provider) => (
                  <tr key={provider.providerId}>
                    <th scope="row">{provider.providerId}</th>
                    <td>
                      <StatusChip
                        label={providerStatusLabel(provider.status)}
                        tone={providerStatusTone(provider.status)}
                        showDot
                      />
                    </td>
                    <td>{provider.message}</td>
                    <td>{provider.latencyMs === null ? '—' : `${provider.latencyMs} ms`}</td>
                    <td>{CIRCUIT_LABELS[provider.circuitState] ?? provider.circuitState}</td>
                    <td>{provider.setupDocPath ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : health.status === 'ready' ? (
          <Notice tone="neutral" title="No sources reported">
            <p>The engine did not return any sources to check.</p>
          </Notice>
        ) : null}
      </section>
    </div>
  );
}
