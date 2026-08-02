import type { QualityScore, ScoreBreakdownEntry, SourceCategory } from '../domain/candidate.js';
import type { MediaTechnicalMetadata, VerificationRecord } from '../domain/media.js';

/**
 * Transparent audio-quality scoring.
 *
 * Every factor is published in the breakdown so the UI can explain the number.
 * Two rules are non-negotiable:
 *  1. Quality is never inferred from filename or file size alone.
 *  2. A high-bitrate lossy file is never scored as equal to a lossless original.
 */

export interface QualityInput {
  readonly technical: MediaTechnicalMetadata;
  readonly verification: VerificationRecord;
  readonly sourceCategory: SourceCategory;
  readonly claimedSizeBytes: number | null;
}

interface Factor {
  readonly factor: string;
  readonly label: string;
  readonly weight: number;
  /** 0..1 */
  readonly value: number;
  readonly warning?: string;
}

const SOURCE_TRUST: Record<SourceCategory, number> = {
  open_archive: 0.95,
  open_data: 0.9,
  podcast_feed: 0.8,
  audio_api: 0.85,
  http_directory: 0.6,
  ftp_directory: 0.55,
  local_files: 1,
  connected_storage: 1,
  organisation_repository: 0.9,
  unknown: 0.4,
};

function verificationValue(record: VerificationRecord): number {
  switch (record.status) {
    case 'verified_audio':
      return record.signatureAgreement ? 1 : 0.85;
    case 'probable_audio':
      return 0.65;
    case 'playlist':
      return 0.3;
    case 'unverified':
      return 0.25;
    case 'verification_failed':
      return 0.1;
    case 'not_audio':
      return 0;
  }
}

/**
 * Bitrate suitability, judged against what the format can reasonably deliver.
 * Lossless formats score full marks without reference to bitrate at all.
 */
function bitrateValue(technical: MediaTechnicalMetadata): { value: number; warning?: string } {
  if (technical.lossless) return { value: 1 };
  const bitrate = technical.bitrate.averageBps ?? technical.bitrate.nominalBps;
  if (bitrate === null) return { value: 0.3, warning: 'Bitrate is unknown.' };

  const warning = technical.bitrate.estimated
    ? 'Bitrate is estimated from file size and duration.'
    : undefined;

  // Thresholds reflect transparency for typical lossy encoders.
  let value: number;
  if (bitrate >= 256_000) value = 1;
  else if (bitrate >= 192_000) value = 0.85;
  else if (bitrate >= 160_000) value = 0.7;
  else if (bitrate >= 128_000) value = 0.55;
  else if (bitrate >= 96_000) value = 0.35;
  else value = 0.2;

  // A lossy file, however well encoded, is capped below a lossless original.
  return { value: Math.min(value, 0.92), ...(warning ? { warning } : {}) };
}

function sampleRateValue(technical: MediaTechnicalMetadata): number {
  const rate = technical.sampleRateHz;
  if (rate === null) return 0.4;
  if (rate >= 44100) return 1;
  if (rate >= 32000) return 0.7;
  if (rate >= 22050) return 0.45;
  return 0.25;
}

function completenessValue(technical: MediaTechnicalMetadata): number {
  const fields = [
    technical.durationSeconds,
    technical.sampleRateHz,
    technical.channels,
    technical.sizeBytes,
    technical.bitrate.averageBps,
    technical.codec === 'unknown' ? null : technical.codec,
  ];
  const present = fields.filter((f) => f !== null).length;
  return present / fields.length;
}

function durationPlausibility(technical: MediaTechnicalMetadata): {
  value: number;
  warning?: string;
} {
  const duration = technical.durationSeconds;
  if (duration === null) return { value: 0.4 };
  if (duration <= 0) return { value: 0, warning: 'Reported duration is not valid.' };
  if (duration < 1) return { value: 0.2, warning: 'This file is under a second long.' };
  if (duration > 12 * 3600) return { value: 0.4, warning: 'Reported duration is unusually long.' };
  return { value: 1 };
}

function headerConsistency(
  technical: MediaTechnicalMetadata,
  claimedSizeBytes: number | null,
): { value: number; warning?: string } {
  if (claimedSizeBytes === null || technical.sizeBytes === null) return { value: 0.7 };
  if (claimedSizeBytes === technical.sizeBytes) return { value: 1 };
  const ratio = Math.abs(claimedSizeBytes - technical.sizeBytes) / Math.max(1, claimedSizeBytes);
  if (ratio < 0.01) return { value: 0.95 };
  return { value: 0.4, warning: 'The size reported by the source does not match the file.' };
}

export function scoreQuality(input: QualityInput): QualityScore {
  const { technical, verification } = input;
  const warnings: string[] = [];

  const bitrate = bitrateValue(technical);
  const duration = durationPlausibility(technical);
  const consistency = headerConsistency(technical, input.claimedSizeBytes);

  const corruptionPenalty = Math.min(1, technical.corruptionSignals.length * 0.34);

  const factors: Factor[] = [
    {
      factor: 'verification',
      label: 'File verified as audio',
      weight: 0.24,
      value: verificationValue(verification),
    },
    {
      factor: 'source_trust',
      label: 'Source reliability',
      weight: 0.12,
      value: SOURCE_TRUST[input.sourceCategory],
    },
    {
      factor: 'format',
      label: technical.lossless ? 'Lossless format' : 'Encoding quality',
      weight: 0.2,
      value: bitrate.value,
      ...(bitrate.warning ? { warning: bitrate.warning } : {}),
    },
    {
      factor: 'sample_rate',
      label: 'Sample rate',
      weight: 0.1,
      value: sampleRateValue(technical),
    },
    {
      factor: 'channels',
      label: 'Channel configuration',
      weight: 0.06,
      value:
        technical.channelLayout === 'unknown' ? 0.4 : technical.channelLayout === 'mono' ? 0.75 : 1,
    },
    {
      factor: 'integrity',
      label: 'Audio stream integrity',
      weight: 0.12,
      value: 1 - corruptionPenalty,
      ...(technical.corruptionSignals.length > 0
        ? { warning: 'Structural problems were detected in this file.' }
        : {}),
    },
    {
      factor: 'completeness',
      label: 'Technical metadata completeness',
      weight: 0.08,
      value: completenessValue(technical),
    },
    {
      factor: 'duration_plausibility',
      label: 'Duration plausibility',
      weight: 0.04,
      value: duration.value,
      ...(duration.warning ? { warning: duration.warning } : {}),
    },
    {
      factor: 'header_consistency',
      label: 'Header consistency',
      weight: 0.04,
      value: consistency.value,
      ...(consistency.warning ? { warning: consistency.warning } : {}),
    },
  ];

  const breakdown: ScoreBreakdownEntry[] = factors.map((factor) => ({
    factor: factor.factor,
    label: factor.label,
    weight: factor.weight,
    value: round(factor.value),
    contribution: round(factor.weight * factor.value),
  }));

  for (const factor of factors) {
    if (factor.warning) warnings.push(factor.warning);
  }
  if (technical.durationEstimated) warnings.push('Duration is estimated, not read from the file.');
  if (technical.bitrate.confidence === 'low' || technical.bitrate.confidence === 'none') {
    warnings.push('Bitrate confidence is low.');
  }

  const total = breakdown.reduce((sum, entry) => sum + entry.contribution, 0);

  return { total: round(total), breakdown, warnings: [...new Set(warnings)] };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
