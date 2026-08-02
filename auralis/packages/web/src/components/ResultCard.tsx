import { memo, useCallback, useId, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { requestDownloadIntent, toUserMessage } from '../api/client.js';
import type { AccessAction, DownloadIntentResponse, SearchResult } from '../api/types.js';
import { BADGE_ORDER } from '../api/vocabulary.js';
import {
  formatBitrate,
  formatBytes,
  formatChannels,
  formatDate,
  formatDuration,
  formatSampleRate,
  formatScore,
  formatToken,
  isExpired,
  truncateMiddle,
} from '../lib/format.js';
import {
  accessLabel,
  actionLabel,
  badgeDescription,
  badgeLabel,
  badgeTone,
  bitrateModeLabel,
  confidenceLabel,
  sourceCategoryLabel,
  verificationLabel,
  verificationTone,
} from '../lib/labels.js';
import { Icon } from './Icon.js';
import { Popover } from './Popover.js';
import { PreviewPlayer } from './PreviewPlayer.js';
import { StatusChip } from './StatusChip.js';
import { TechnicalDetails } from './TechnicalDetails.js';

type MessageTone = 'neutral' | 'warning' | 'danger' | 'success';

interface InlineMessage {
  readonly text: string;
  readonly tone: MessageTone;
}

export interface ResultCardProps {
  readonly result: SearchResult;
  readonly searchId: string | null;
  readonly saved: boolean;
  readonly savePending: boolean;
  readonly onToggleSave: (result: SearchResult) => void;
  readonly onOpenConnectors: () => void;
}

function fact(label: string, value: string | null): ReactNode {
  if (!value) return null;
  return (
    <div className="au-fact" key={label}>
      <span className="au-fact__label">{label}</span>
      <span className="au-fact__value">{value}</span>
    </div>
  );
}

function bitrateText(result: SearchResult): string | null {
  const { bitrate } = result.technical;
  const value = formatBitrate(bitrate.averageBps ?? bitrate.nominalBps);
  if (!value) return null;
  const parts = [value, bitrateModeLabel(bitrate.mode)];
  if (bitrate.estimated) {
    parts.push('estimated');
  }
  return parts.join(' · ');
}

function startBrowserDownload(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener noreferrer';
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

async function copyText(value: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

function ResultCardInner({
  result,
  searchId,
  saved,
  savePending,
  onToggleSave,
  onOpenConnectors,
}: ResultCardProps): ReactElement {
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const technicalId = `${baseId}-technical`;
  const technicalHeadingId = `${baseId}-technical-heading`;
  const variantsId = `${baseId}-variants`;
  const messageId = `${baseId}-message`;

  const [technicalOpen, setTechnicalOpen] = useState(false);
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [message, setMessage] = useState<InlineMessage | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [artworkFailed, setArtworkFailed] = useState(false);

  const actions = result.access.actions;
  const can = useCallback((action: AccessAction): boolean => actions.includes(action), [actions]);

  const previewSrc = result.previewUrl ?? result.mediaUrl;
  const sourcePage = result.pageUrl ?? result.source.pageUrl;

  const handleDownload = useCallback(async (): Promise<void> => {
    if (!searchId) {
      setMessage({
        text: 'Start a search again before downloading — this result is no longer attached to one.',
        tone: 'warning',
      });
      return;
    }
    setDownloadBusy(true);
    setMessage(null);
    try {
      const intent: DownloadIntentResponse = await requestDownloadIntent(result.id, searchId);
      if (!intent.allowed || !intent.url) {
        setMessage({ text: intent.reason, tone: 'warning' });
        return;
      }
      if (isExpired(intent.expiresAt)) {
        setMessage({
          text: 'That download link has expired. Ask for it again to get a fresh one.',
          tone: 'warning',
        });
        return;
      }
      startBrowserDownload(intent.url, intent.filename);
      setMessage({ text: `Downloading ${intent.filename}.`, tone: 'success' });
    } catch (error) {
      setMessage({ text: toUserMessage(error), tone: 'danger' });
    } finally {
      setDownloadBusy(false);
    }
  }, [result.id, searchId]);

  const handleCopy = useCallback(async (value: string | null, what: string): Promise<void> => {
    if (!value) {
      setMessage({ text: `No ${what} is available for this result.`, tone: 'warning' });
      return;
    }
    const copied = await copyText(value);
    setMessage(
      copied
        ? { text: `The ${what} was copied.`, tone: 'success' }
        : { text: `The ${what} could not be copied by this browser.`, tone: 'warning' },
    );
  }, []);

  const badges = BADGE_ORDER.filter((badge) => result.badges.includes(badge));
  const facts = [
    fact('Format', formatToken(result.technical.format)),
    fact('Codec', formatToken(result.technical.codec)),
    fact('Bitrate', bitrateText(result)),
    fact('Sample rate', formatSampleRate(result.technical.sampleRateHz)),
    fact(
      'Bit depth',
      result.technical.bitDepth === null ? null : `${result.technical.bitDepth}-bit`,
    ),
    fact('Channels', formatChannels(result.technical.channels, result.technical.channelLayout)),
    fact(
      'Length',
      result.technical.durationSeconds === null
        ? null
        : `${formatDuration(result.technical.durationSeconds) ?? ''}${
            result.technical.durationEstimated ? ' (estimated)' : ''
          }`,
    ),
    fact('Size', formatBytes(result.technical.sizeBytes)),
    fact('Extension', result.technical.extension ? `.${result.technical.extension}` : null),
    fact('Type', result.technical.mimeType),
  ].filter(Boolean);

  const rankingContributors = [...result.ranking.breakdown]
    .sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution))
    .slice(0, 4);

  return (
    <article className="au-result" aria-labelledby={titleId}>
      <div className="au-result__main">
        <div className="au-result__artwork" aria-hidden="true">
          {result.source.artworkUrl && !artworkFailed ? (
            <img
              className="au-result__image"
              src={result.source.artworkUrl}
              alt=""
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setArtworkFailed(true)}
            />
          ) : (
            <span className="au-result__artwork-fallback">
              <Icon name="waveform" size={20} />
            </span>
          )}
        </div>

        <div className="au-result__body">
          <header className="au-result__header">
            <h3 className="au-result__title" id={titleId}>
              {result.title}
            </h3>
            <p className="au-result__byline">
              {result.creator ? <span className="au-result__creator">{result.creator}</span> : null}
              {result.filename ? (
                <span className="au-result__filename" title={result.filename}>
                  {truncateMiddle(result.filename, 56)}
                </span>
              ) : null}
            </p>
          </header>

          <p className="au-result__source">
            <span className="au-result__source-name">{result.source.providerDisplayName}</span>
            {result.source.sourceHost ? (
              <span className="au-result__source-host">{result.source.sourceHost}</span>
            ) : (
              <span className="au-result__source-host">Source website not published</span>
            )}
            <span className="au-result__source-category">
              {sourceCategoryLabel(result.source.category)}
            </span>
            {formatDate(result.source.publishedAt) ? (
              <span className="au-result__published">
                Published {formatDate(result.source.publishedAt)}
              </span>
            ) : null}
          </p>

          {badges.length > 0 ? (
            <ul className="au-badges" aria-label="Result labels">
              {badges.map((badge) => (
                <li key={badge}>
                  <StatusChip
                    label={badgeLabel(badge)}
                    tone={badgeTone(badge)}
                    detail={badgeDescription(badge)}
                  />
                </li>
              ))}
            </ul>
          ) : null}

          {facts.length > 0 ? <div className="au-facts">{facts}</div> : null}

          <div className="au-result__signals">
            <StatusChip
              label={verificationLabel(result.verification.status)}
              tone={verificationTone(result.verification.status)}
            />
            <StatusChip label={accessLabel(result.access.classification)} />
            <StatusChip label={confidenceLabel(result.technical.confidence)} />
            <StatusChip
              label={result.mediaUrl ? 'Direct file address' : 'No direct file address'}
            />
            {result.verification.finalHost ? (
              <span className="au-result__scores">Served by {result.verification.finalHost}</span>
            ) : null}
            <span className="au-result__scores">
              Relevance {formatScore(result.ranking.relevance)} · Quality{' '}
              {formatScore(result.quality.total)}
            </span>
          </div>

          {result.verification.status === 'not_audio' ? (
            <p className="au-result__message au-result__message--warning">
              What this address points at is not an audio file. It is kept here only so you can see
              where it came from.
            </p>
          ) : null}
          {result.verification.status === 'verification_failed' ? (
            <p className="au-result__message au-result__message--warning">
              This file could not be reached for checking. Everything shown below comes from the
              source rather than from the file itself.
            </p>
          ) : null}
          {result.verification.status === 'playlist' ? (
            <p className="au-result__message au-result__message--warning">
              This address is a playlist rather than a single recording. Individual tracks may
              appear as separate results.
            </p>
          ) : null}
          {result.technical.format === 'unknown' && result.verification.status !== 'not_audio' ? (
            <p className="au-result__note">
              Auralis could not identify this file&apos;s format. It may not play everywhere.
            </p>
          ) : null}

          {result.source.attribution ? (
            <p className="au-result__attribution">{result.source.attribution}</p>
          ) : null}
          {result.tags.album ? (
            <p className="au-result__collection">Album: {result.tags.album}</p>
          ) : result.source.collection ? (
            <p className="au-result__collection">Collection: {result.source.collection}</p>
          ) : null}

          {!can('download') ? (
            <p className="au-result__access-reason">{result.access.reason}</p>
          ) : null}

          <div className="au-result__actions">
            {can('download') ? (
              <button
                type="button"
                className="au-button au-button--primary"
                onClick={() => void handleDownload()}
                disabled={downloadBusy}
                aria-describedby={message ? messageId : undefined}
              >
                <Icon name="download" size={14} />
                {downloadBusy ? 'Preparing…' : actionLabel('download')}
              </button>
            ) : null}

            {can('preview') && previewSrc ? (
              <button
                type="button"
                className="au-button"
                aria-expanded={previewOpen}
                onClick={() => setPreviewOpen((value) => !value)}
              >
                {previewOpen ? 'Hide preview' : actionLabel('preview')}
              </button>
            ) : null}

            {can('preview') && !previewSrc ? (
              <p className="au-result__note">
                A preview is listed for this result but no playable address was provided.
              </p>
            ) : null}

            {(can('visit_source') || can('open_provider')) && sourcePage ? (
              <a
                className="au-button"
                href={sourcePage}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                <Icon name="external" size={14} />
                {can('visit_source') ? actionLabel('visit_source') : actionLabel('open_provider')}
                <span className="au-visually-hidden"> (opens in a new tab)</span>
              </a>
            ) : null}

            {(can('visit_source') || can('open_provider')) && !sourcePage ? (
              <p className="au-result__note">
                This source did not publish a page for this recording.
              </p>
            ) : null}

            {can('copy_source_url') ? (
              <button
                type="button"
                className="au-button au-button--quiet"
                onClick={() => void handleCopy(sourcePage, 'source link')}
              >
                <Icon name="copy" size={14} />
                {actionLabel('copy_source_url')}
              </button>
            ) : null}

            {can('copy_direct_url') && result.mediaUrl ? (
              <button
                type="button"
                className="au-button au-button--quiet"
                onClick={() => void handleCopy(result.mediaUrl, 'file link')}
              >
                <Icon name="copy" size={14} />
                {actionLabel('copy_direct_url')}
              </button>
            ) : null}

            {can('connect_account') ? (
              <button type="button" className="au-button" onClick={onOpenConnectors}>
                <Icon name="plug" size={14} />
                {actionLabel('connect_account')}
              </button>
            ) : null}

            {can('request_credentials') ? (
              <p className="au-result__note">
                Access to this file is arranged with the source directly.
              </p>
            ) : null}

            <button
              type="button"
              className="au-button au-button--quiet"
              aria-expanded={technicalOpen}
              aria-controls={technicalId}
              onClick={() => setTechnicalOpen((value) => !value)}
            >
              {technicalOpen ? 'Hide details' : actionLabel('inspect_metadata')}
            </button>

            <Popover label="Why this result?" title="Why this result?" align="end">
              {result.ranking.explanation.length > 0 ? (
                <ul className="au-why__list">
                  {result.ranking.explanation.map((line, index) => (
                    <li key={`${line}-${index}`}>{line}</li>
                  ))}
                </ul>
              ) : (
                <p className="au-why__empty">
                  No explanation was recorded for this result&apos;s position.
                </p>
              )}
              {rankingContributors.length > 0 ? (
                <>
                  <p className="au-why__subheading">Largest contributors</p>
                  <ul className="au-why__factors">
                    {rankingContributors.map((entry) => (
                      <li key={entry.factor} className="au-why__factor">
                        <span>{entry.label}</span>
                        <span className="au-why__value">{formatScore(entry.contribution)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <p className="au-why__total">Overall score {formatScore(result.ranking.total)}</p>
              {result.access.evidence.length > 0 ? (
                <>
                  <p className="au-why__subheading">How availability was decided</p>
                  <ul className="au-why__list">
                    {result.access.evidence.map((entry, index) => (
                      <li key={`${entry}-${index}`}>{entry}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </Popover>

            <button
              type="button"
              className={`au-button au-button--quiet${saved ? ' au-button--is-saved' : ''}`}
              onClick={() => onToggleSave(result)}
              disabled={savePending}
              aria-pressed={saved}
            >
              <Icon name={saved ? 'bookmark-filled' : 'bookmark'} size={14} />
              {saved ? 'Saved' : 'Save'}
            </button>
          </div>

          {message ? (
            <p
              className={`au-result__message au-result__message--${message.tone}`}
              id={messageId}
              role="status"
            >
              {message.text}
            </p>
          ) : null}

          {previewOpen && previewSrc ? (
            <PreviewPlayer resultId={result.id} src={previewSrc} title={result.title} />
          ) : null}

          {result.duplicateCount > 0 ? (
            <div className="au-variants">
              <button
                type="button"
                className="au-link-button"
                aria-expanded={variantsOpen}
                aria-controls={variantsId}
                onClick={() => setVariantsOpen((value) => !value)}
              >
                {result.duplicateCount} other cop{result.duplicateCount === 1 ? 'y' : 'ies'}
              </button>
              <div id={variantsId} hidden={!variantsOpen} className="au-variants__panel">
                {result.variants.length > 0 ? (
                  <ul className="au-variants__list">
                    {result.variants.map((variant) => (
                      <li key={variant.id} className="au-variants__item">
                        <div className="au-variants__head">
                          <span className="au-variants__provider">
                            {variant.providerDisplayName}
                          </span>
                          <StatusChip label={accessLabel(variant.accessClassification)} />
                        </div>
                        <p className="au-variants__facts">
                          {[
                            formatToken(variant.format),
                            formatBitrate(variant.bitrateBps),
                            formatSampleRate(variant.sampleRateHz),
                            formatDuration(variant.durationSeconds),
                            formatBytes(variant.sizeBytes),
                          ]
                            .filter((entry): entry is string => Boolean(entry))
                            .join(' · ')}
                        </p>
                        {variant.differsBy.length > 0 ? (
                          <ul className="au-variants__reasons">
                            {variant.differsBy.map((reason, index) => (
                              <li key={`${reason}-${index}`}>{reason}</li>
                            ))}
                          </ul>
                        ) : null}
                        {variant.pageUrl ? (
                          <a
                            className="au-link"
                            href={variant.pageUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            referrerPolicy="no-referrer"
                          >
                            Open this copy
                            <span className="au-visually-hidden"> (opens in a new tab)</span>
                          </a>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="au-result__note">
                    Other copies were counted but their details are not available.
                  </p>
                )}
              </div>
            </div>
          ) : null}

          <div id={technicalId} hidden={!technicalOpen} className="au-result__technical">
            <TechnicalDetails result={result} headingId={technicalHeadingId} />
          </div>
        </div>
      </div>
    </article>
  );
}

export const ResultCard = memo(ResultCardInner);
