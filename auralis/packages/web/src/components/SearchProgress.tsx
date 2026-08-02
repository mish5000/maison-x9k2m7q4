import type { ReactElement } from 'react';

import { formatCount, formatElapsed } from '../lib/format.js';
import { outcomeDisplay } from '../lib/labels.js';
import type { Tone } from '../lib/labels.js';
import type { ProviderRun, SearchSession } from '../hooks/useSearchStream.js';
import { StatusChip } from './StatusChip.js';

function providerChip(run: ProviderRun): { label: string; tone: Tone; detail: string } {
  if (run.state === 'pending') {
    return { label: 'Waiting', tone: 'neutral', detail: 'This source has not started yet.' };
  }
  if (run.state === 'searching') {
    return { label: 'Searching', tone: 'accent', detail: 'This source is being searched now.' };
  }
  const display = outcomeDisplay(run.state);
  return { label: display.label, tone: display.tone, detail: run.message ?? display.detail };
}

export interface SearchProgressProps {
  readonly session: SearchSession;
  readonly elapsedMs: number;
  readonly running: boolean;
  readonly onCancel: () => void;
}

export function SearchProgress({
  session,
  elapsedMs,
  running,
  onCancel,
}: SearchProgressProps): ReactElement {
  const { progress, providers } = session;
  const total = Math.max(progress.providersTotal, providers.length);
  const completed = Math.min(progress.providersCompleted, total);
  const ratio = total > 0 ? completed / total : 0;
  const shown = session.results.length;
  const verified = progress.candidatesVerified;
  const found = Math.max(progress.candidatesDiscovered, shown);

  return (
    <section className="au-progress" aria-labelledby="au-progress-heading">
      <h2 className="au-visually-hidden" id="au-progress-heading">
        Search progress
      </h2>

      <div className="au-progress__bar" aria-hidden="true">
        <span
          className={`au-progress__fill${running ? ' au-progress__fill--running' : ''}`}
          style={{ transform: `scaleX(${Math.max(0.02, ratio)})` }}
        />
      </div>

      <div className="au-progress__row">
        <dl className="au-stats">
          <div className="au-stat">
            <dt className="au-stat__label">Sources</dt>
            <dd className="au-stat__value">
              {formatCount(completed)}
              <span className="au-stat__of"> of {formatCount(total)}</span>
            </dd>
          </div>
          <div className="au-stat">
            <dt className="au-stat__label">Found</dt>
            <dd className="au-stat__value">{formatCount(found)}</dd>
          </div>
          <div className="au-stat">
            <dt className="au-stat__label">Verified</dt>
            <dd className="au-stat__value">{formatCount(verified)}</dd>
          </div>
          <div className="au-stat">
            <dt className="au-stat__label">Elapsed</dt>
            <dd className="au-stat__value">{formatElapsed(elapsedMs)}</dd>
          </div>
        </dl>

        {running ? (
          <button type="button" className="au-button au-button--danger" onClick={onCancel}>
            Cancel search
          </button>
        ) : null}
      </div>

      {providers.length > 0 ? (
        <ul className="au-provider-strip">
          {providers.map((run) => {
            const chip = providerChip(run);
            return (
              <li key={run.id} className="au-provider-strip__item">
                <span className="au-provider-strip__name">{run.displayName}</span>
                <StatusChip label={chip.label} tone={chip.tone} detail={chip.detail} showDot />
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
