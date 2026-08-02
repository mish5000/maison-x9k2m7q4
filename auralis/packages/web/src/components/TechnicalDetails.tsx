import type { ReactElement } from 'react';

import type { SearchResult } from '../api/types.js';
import {
  NOT_AVAILABLE,
  formatBitrate,
  formatBytes,
  formatChannels,
  formatDateTime,
  formatDuration,
  formatSampleRate,
  formatToken,
} from '../lib/format.js';
import {
  bitrateModeLabel,
  confidenceLabel,
  sourceCategoryLabel,
  verdictLabel,
  verdictTone,
  verificationDetail,
  verificationLabel,
} from '../lib/labels.js';
import { StatusChip } from './StatusChip.js';

interface Row {
  readonly label: string;
  readonly value: string;
}

function row(label: string, value: string | number | null | undefined): Row | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? String(value) : value;
  if (text.trim().length === 0) return null;
  return { label, value: text };
}

function compact(rows: readonly (Row | null)[]): readonly Row[] {
  return rows.filter((entry): entry is Row => entry !== null);
}

export interface TechnicalDetailsProps {
  readonly result: SearchResult;
  readonly headingId: string;
}

export function TechnicalDetails({ result, headingId }: TechnicalDetailsProps): ReactElement {
  const { technical, tags, verification, source, claimed } = result;

  const fileRows = compact([
    row('Format', formatToken(technical.format)),
    row('Codec', formatToken(technical.codec)),
    row('Extension', technical.extension ? `.${technical.extension}` : null),
    row('MIME type', technical.mimeType),
    row(
      'Bitrate',
      technical.bitrate.averageBps !== null
        ? `${formatBitrate(technical.bitrate.averageBps) ?? NOT_AVAILABLE} · ${bitrateModeLabel(
            technical.bitrate.mode,
          )}${technical.bitrate.estimated ? ' · estimated' : ''}`
        : null,
    ),
    row('Nominal bitrate', formatBitrate(technical.bitrate.nominalBps)),
    row('Bitrate confidence', confidenceLabel(technical.bitrate.confidence)),
    row('Sample rate', formatSampleRate(technical.sampleRateHz)),
    row('Bit depth', technical.bitDepth === null ? null : `${technical.bitDepth}-bit`),
    row('Channels', formatChannels(technical.channels, technical.channelLayout)),
    row(
      'Length',
      technical.durationSeconds === null
        ? null
        : `${formatDuration(technical.durationSeconds) ?? NOT_AVAILABLE}${
            technical.durationEstimated ? ' (estimated)' : ''
          }`,
    ),
    row('File size', formatBytes(technical.sizeBytes)),
    row('Lossless', technical.lossless ? 'Yes' : 'No'),
    row('Encoder', technical.encoder),
    row('Metadata confidence', confidenceLabel(technical.confidence)),
    row(
      'Replay gain (track)',
      technical.loudness.replayGainTrackDb === null
        ? null
        : `${technical.loudness.replayGainTrackDb} dB`,
    ),
    row(
      'Replay gain (album)',
      technical.loudness.replayGainAlbumDb === null
        ? null
        : `${technical.loudness.replayGainAlbumDb} dB`,
    ),
    row(
      'Peak amplitude',
      technical.loudness.peakAmplitude === null ? null : String(technical.loudness.peakAmplitude),
    ),
  ]);

  const claimedRows = compact([
    row('Format claimed by source', formatToken(claimed.format)),
    row('MIME claimed by source', claimed.mimeType),
    row('Size claimed by source', formatBytes(claimed.sizeBytes)),
    row('Length claimed by source', formatDuration(claimed.durationSeconds)),
    row('Bitrate claimed by source', formatBitrate(claimed.bitrateBps)),
    row('Sample rate claimed by source', formatSampleRate(claimed.sampleRateHz)),
    row('Channels claimed by source', claimed.channels),
  ]);

  const tagRows = compact([
    row('Tag title', tags.title),
    row('Tag artist', tags.artist),
    row('Album', tags.album),
    row('Album artist', tags.albumArtist),
    row('Track number', tags.trackNumber),
    row('Year', tags.year),
    row('Genre', tags.genre),
    row('Comment', tags.comment),
  ]);

  const sourceRows = compact([
    row('Source', source.providerDisplayName),
    row('Source host', source.sourceHost),
    row('Source category', sourceCategoryLabel(source.category)),
    row('Collection', source.collection),
    row('Attribution', source.attribution),
    row('Rights statement', source.rightsStatement),
    row('Published', formatDateTime(source.publishedAt)),
    row('Discovered', formatDateTime(result.discoveredAt)),
  ]);

  const verificationRows = compact([
    row('Status', verificationLabel(verification.status)),
    row('Checked', formatDateTime(verification.checkedAt)),
    row(
      'Bytes inspected',
      verification.bytesInspected > 0 ? String(verification.bytesInspected) : null,
    ),
    row('Final host', verification.finalHost),
    row('Redirects followed', String(verification.redirectCount)),
    row('Declared type', verification.declaredMimeType),
    row('Detected signature', verification.detectedSignature),
    row('Extension, type and signature agree', verification.signatureAgreement ? 'Yes' : 'No'),
  ]);

  return (
    <div className="au-technical">
      <h4 className="au-visually-hidden" id={headingId}>
        Technical details
      </h4>

      <TechnicalTable caption="File" rows={fileRows} />
      {claimedRows.length > 0 ? (
        <TechnicalTable caption="Reported by the source" rows={claimedRows} />
      ) : null}
      {tagRows.length > 0 ? <TechnicalTable caption="Embedded tags" rows={tagRows} /> : null}
      <TechnicalTable caption="Source" rows={sourceRows} />
      <TechnicalTable caption="Verification" rows={verificationRows} />

      <section className="au-technical__block">
        <h5 className="au-technical__heading">What was checked</h5>
        <p className="au-technical__note">{verificationDetail(verification.status)}</p>
        {verification.evidence.length > 0 ? (
          <ul className="au-evidence">
            {verification.evidence.map((entry, index) => (
              <li key={`${entry}-${index}`} className="au-evidence__item">
                {entry}
              </li>
            ))}
          </ul>
        ) : (
          <p className="au-technical__note">No checks have been recorded for this file yet.</p>
        )}
      </section>

      {result.compatibility.length > 0 ? (
        <section className="au-technical__block">
          <h5 className="au-technical__heading">Device compatibility</h5>
          <ul className="au-compat">
            {result.compatibility.map((assessment) => (
              <li
                key={`${assessment.profileId}-${assessment.profileVersion}`}
                className="au-compat__item"
              >
                <div className="au-compat__head">
                  <span className="au-compat__profile">{assessment.profileLabel}</span>
                  <StatusChip
                    label={verdictLabel(assessment.verdict)}
                    tone={verdictTone(assessment.verdict)}
                  />
                </div>
                {assessment.reasons.length > 0 ? (
                  <ul className="au-compat__reasons">
                    {assessment.reasons.map((reason, index) => (
                      <li key={`${reason}-${index}`}>{reason}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.quality.warnings.length > 0 ? (
        <section className="au-technical__block">
          <h5 className="au-technical__heading">Quality notes</h5>
          <ul className="au-warnings">
            {result.quality.warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {technical.corruptionSignals.length > 0 ? (
        <section className="au-technical__block">
          <h5 className="au-technical__heading">Problems found in the file</h5>
          <ul className="au-warnings">
            {technical.corruptionSignals.map((signal, index) => (
              <li key={`${signal}-${index}`}>{signal}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function TechnicalTable({
  caption,
  rows,
}: {
  readonly caption: string;
  readonly rows: readonly Row[];
}): ReactElement | null {
  if (rows.length === 0) return null;
  return (
    <div className="au-technical__block">
      <div className="au-scroll-x">
        <table className="au-table">
          <caption className="au-table__caption">{caption}</caption>
          <tbody>
            {rows.map((entry) => (
              <tr key={entry.label}>
                <th scope="row">{entry.label}</th>
                <td>{entry.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
