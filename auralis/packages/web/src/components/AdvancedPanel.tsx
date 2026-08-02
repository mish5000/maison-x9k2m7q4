import type { ReactElement } from 'react';

import type {
  AccessClassification,
  AudioFormat,
  ProviderSummary,
  SearchMode,
} from '../api/types.js';
import {
  ACCESS_CLASSIFICATION_VALUES,
  AUDIO_FORMAT_VALUES,
  SEARCH_MODE_VALUES,
} from '../api/vocabulary.js';
import {
  accessLabel,
  modeDescription,
  modeLabel,
  providerStatusLabel,
  providerStatusTone,
} from '../lib/labels.js';
import type { DraftErrors, SearchDraft } from '../lib/searchDraft.js';
import { toggleValue } from '../lib/searchDraft.js';
import { StatusChip } from './StatusChip.js';

export interface AdvancedPanelProps {
  readonly id: string;
  readonly open: boolean;
  readonly draft: SearchDraft;
  readonly onChange: (next: SearchDraft) => void;
  readonly providers: readonly ProviderSummary[];
  readonly providersStatus: 'idle' | 'loading' | 'ready' | 'error';
  readonly providersError: string | null;
  readonly onRetryProviders: () => void;
  readonly errors: DraftErrors;
  readonly onClear: () => void;
}

const FORMAT_LABELS: Partial<Record<AudioFormat, string>> = {
  mp3: 'MP3',
  wav: 'WAV',
  aiff: 'AIFF',
  flac: 'FLAC',
  aac: 'AAC',
  m4a: 'M4A',
  alac: 'ALAC',
  ogg: 'OGG',
  opus: 'Opus',
  unknown: 'Unrecognised',
};

export function AdvancedPanel({
  id,
  open,
  draft,
  onChange,
  providers,
  providersStatus,
  providersError,
  onRetryProviders,
  errors,
  onClear,
}: AdvancedPanelProps): ReactElement {
  const patch = (partial: Partial<SearchDraft>): void => onChange({ ...draft, ...partial });

  return (
    <div className="au-advanced" id={id} hidden={!open}>
      <div className="au-advanced__grid">
        <fieldset className="au-fieldset">
          <legend className="au-label">Search mode</legend>
          <div className="au-modes" role="radiogroup" aria-label="Search mode">
            {SEARCH_MODE_VALUES.map((mode: SearchMode) => {
              const checked = draft.mode === mode;
              return (
                <label key={mode} className="au-mode" data-checked={checked ? 'true' : 'false'}>
                  <input
                    type="radio"
                    name="au-search-mode"
                    value={mode}
                    checked={checked}
                    onChange={() => patch({ mode })}
                  />
                  <span className="au-mode__text">
                    <span className="au-mode__title">{modeLabel(mode)}</span>
                    <span className="au-mode__detail">{modeDescription(mode)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="au-fieldset">
          <legend className="au-label">Formats</legend>
          <p className="au-hint" id={`${id}-formats-hint`}>
            Leave empty to accept every format.
          </p>
          <div className="au-chip-row" role="group" aria-describedby={`${id}-formats-hint`}>
            {AUDIO_FORMAT_VALUES.map((format) => {
              const pressed = draft.formats.includes(format);
              return (
                <button
                  key={format}
                  type="button"
                  className="au-chip au-chip--toggle"
                  aria-pressed={pressed}
                  onClick={() => patch({ formats: toggleValue(draft.formats, format) })}
                >
                  {FORMAT_LABELS[format] ?? format}
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="au-field">
          <label className="au-label" htmlFor={`${id}-extensions`}>
            File extensions
          </label>
          <input
            id={`${id}-extensions`}
            className="au-input"
            type="text"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="mp3, flac"
            value={draft.extensions}
            onChange={(event) => patch({ extensions: event.target.value })}
            aria-describedby={
              errors.extensions ? `${id}-extensions-error` : `${id}-extensions-hint`
            }
            aria-invalid={errors.extensions ? true : undefined}
          />
          {errors.extensions ? (
            <p className="au-error-text" id={`${id}-extensions-error`}>
              {errors.extensions}
            </p>
          ) : (
            <p className="au-hint" id={`${id}-extensions-hint`}>
              Separate several with commas.
            </p>
          )}
        </div>

        <div className="au-field">
          <label className="au-label" htmlFor={`${id}-bitrate`}>
            Minimum bitrate
          </label>
          <input
            id={`${id}-bitrate`}
            className="au-input"
            type="number"
            min={8}
            max={10000}
            step={1}
            inputMode="numeric"
            placeholder="320"
            value={draft.minBitrateKbps}
            onChange={(event) => patch({ minBitrateKbps: event.target.value })}
            aria-describedby={errors.minBitrateKbps ? `${id}-bitrate-error` : `${id}-bitrate-hint`}
            aria-invalid={errors.minBitrateKbps ? true : undefined}
          />
          {errors.minBitrateKbps ? (
            <p className="au-error-text" id={`${id}-bitrate-error`}>
              {errors.minBitrateKbps}
            </p>
          ) : (
            <p className="au-hint" id={`${id}-bitrate-hint`}>
              In kilobits per second.
            </p>
          )}
        </div>

        <div className="au-field">
          <label className="au-label" htmlFor={`${id}-duration-min`}>
            Shortest length
          </label>
          <input
            id={`${id}-duration-min`}
            className="au-input"
            type="number"
            min={0}
            max={86400}
            step={1}
            inputMode="numeric"
            placeholder="60"
            value={draft.durationMinSeconds}
            onChange={(event) => patch({ durationMinSeconds: event.target.value })}
            aria-describedby={
              errors.durationMinSeconds ? `${id}-duration-min-error` : `${id}-duration-hint`
            }
            aria-invalid={errors.durationMinSeconds ? true : undefined}
          />
          {errors.durationMinSeconds ? (
            <p className="au-error-text" id={`${id}-duration-min-error`}>
              {errors.durationMinSeconds}
            </p>
          ) : null}
        </div>

        <div className="au-field">
          <label className="au-label" htmlFor={`${id}-duration-max`}>
            Longest length
          </label>
          <input
            id={`${id}-duration-max`}
            className="au-input"
            type="number"
            min={1}
            max={86400}
            step={1}
            inputMode="numeric"
            placeholder="600"
            value={draft.durationMaxSeconds}
            onChange={(event) => patch({ durationMaxSeconds: event.target.value })}
            aria-describedby={
              errors.durationMaxSeconds ? `${id}-duration-max-error` : `${id}-duration-hint`
            }
            aria-invalid={errors.durationMaxSeconds ? true : undefined}
          />
          {errors.durationMaxSeconds ? (
            <p className="au-error-text" id={`${id}-duration-max-error`}>
              {errors.durationMaxSeconds}
            </p>
          ) : (
            <p className="au-hint" id={`${id}-duration-hint`}>
              Both lengths are in seconds.
            </p>
          )}
        </div>

        <fieldset className="au-fieldset">
          <legend className="au-label">Availability</legend>
          <div className="au-chip-row" role="group">
            {ACCESS_CLASSIFICATION_VALUES.map((access: AccessClassification) => {
              const pressed = draft.accessTypes.includes(access);
              return (
                <button
                  key={access}
                  type="button"
                  className="au-chip au-chip--toggle"
                  aria-pressed={pressed}
                  onClick={() => patch({ accessTypes: toggleValue(draft.accessTypes, access) })}
                >
                  {accessLabel(access)}
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="au-fieldset au-fieldset--wide">
          <legend className="au-label">Sources</legend>
          {providersStatus === 'loading' ? (
            <p className="au-hint">Loading the list of sources…</p>
          ) : null}
          {providersStatus === 'error' ? (
            <p className="au-hint">
              {providersError ?? 'The list of sources could not be loaded.'}{' '}
              <button type="button" className="au-link-button" onClick={onRetryProviders}>
                Try again
              </button>
            </p>
          ) : null}
          {providersStatus === 'ready' && providers.length === 0 ? (
            <p className="au-hint">No sources are available yet.</p>
          ) : null}
          {providers.length > 0 ? (
            <div className="au-chip-row" role="group" aria-label="Sources to search">
              {providers.map((provider) => {
                const pressed = draft.providerIds.includes(provider.id);
                return (
                  <button
                    key={provider.id}
                    type="button"
                    className="au-chip au-chip--toggle au-chip--source"
                    aria-pressed={pressed}
                    onClick={() =>
                      patch({ providerIds: toggleValue(draft.providerIds, provider.id) })
                    }
                  >
                    <span>{provider.displayName}</span>
                    {provider.status !== 'ready' ? (
                      <StatusChip
                        label={providerStatusLabel(provider.status)}
                        tone={providerStatusTone(provider.status)}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : null}
          <p className="au-hint">Leave every source unselected to search all of them.</p>
        </fieldset>

        <div className="au-field au-field--inline">
          <label className="au-checkbox" htmlFor={`${id}-lossless`}>
            <input
              id={`${id}-lossless`}
              type="checkbox"
              checked={draft.losslessOnly}
              onChange={(event) => patch({ losslessOnly: event.target.checked })}
            />
            <span>Lossless files only</span>
          </label>
        </div>
      </div>

      <div className="au-advanced__footer">
        <button type="button" className="au-button au-button--quiet" onClick={onClear}>
          Clear all filters
        </button>
      </div>
    </div>
  );
}
