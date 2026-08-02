import type { AccessClassification } from '../domain/access.js';
import type {
  ClaimedMetadata,
  QualityScore,
  RankingScore,
  ScoreBreakdownEntry,
  SourceMetadata,
} from '../domain/candidate.js';
import type { CompatibilityAssessment } from '../domain/compat.js';
import type { MediaTags, MediaTechnicalMetadata, VerificationRecord } from '../domain/media.js';
import type { NormalizedSearchQuery } from '../domain/query.js';
import {
  containsPhrase,
  coverage,
  editSimilarity,
  isExactTitleMatch,
  tokenOverlap,
} from './relevance.js';

/**
 * Explainable ranking. The score is a weighted sum with a published breakdown,
 * and the UI renders the top contributors as "Why this result?".
 */

export interface RankingInput {
  readonly query: NormalizedSearchQuery;
  readonly title: string;
  readonly creator: string | null;
  readonly filename: string | null;
  readonly tags: MediaTags;
  readonly source: SourceMetadata;
  readonly technical: MediaTechnicalMetadata;
  readonly claimed: ClaimedMetadata;
  readonly verification: VerificationRecord;
  readonly quality: QualityScore;
  readonly access: AccessClassification;
  readonly compatibility: readonly CompatibilityAssessment[];
  readonly hasDirectMediaUrl: boolean;
  readonly isDuplicateOfBetter: boolean;
  readonly duplicateCount: number;
  readonly providerResponseQuality: number;
}

const ACCESS_CERTAINTY: Record<AccessClassification, number> = {
  direct_download: 1,
  user_owned: 1,
  source_download: 0.85,
  connected_private: 0.85,
  preview_only: 0.5,
  metadata_only: 0.3,
  unknown: 0.2,
  restricted: 0.1,
};

function textRelevance(input: RankingInput): { value: number; matchedExact: boolean } {
  const { query } = input;
  const haystackParts = [
    input.title,
    input.creator,
    input.filename,
    input.tags.title,
    input.tags.artist,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0);
  const haystack = haystackParts.join(' ');

  let best = 0;
  for (const variant of query.variants) {
    const score =
      0.55 * coverage(variant.text, haystack) +
      0.25 * tokenOverlap(variant.text, haystack) +
      0.2 * editSimilarity(variant.text, input.title);
    best = Math.max(best, score * variant.weight);
  }

  // Required phrases are a gate, not a bonus: missing one is heavily penalised.
  if (query.phrases.length > 0) {
    const satisfied = query.phrases.every((phrase) => containsPhrase(haystack, phrase));
    if (!satisfied) best *= 0.35;
  }

  const matchedExact =
    isExactTitleMatch(query.normalized, input.title) ||
    (input.tags.title !== null && isExactTitleMatch(query.normalized, input.tags.title));

  return { value: Math.min(1, best), matchedExact };
}

function creatorMatch(input: RankingInput): number {
  const wanted = input.query.creator;
  if (!wanted) return 0.5; // neutral when the query has no creator component
  const candidates = [input.creator, input.tags.artist, input.tags.albumArtist].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (candidates.length === 0) return 0.3;
  return Math.max(...candidates.map((value) => editSimilarity(wanted, value)));
}

function requestedFormatMatch(input: RankingInput): number {
  const { filters } = input.query;
  const wantsFormat = filters.formats.length > 0 || filters.extensions.length > 0;
  if (!wantsFormat) return 0.5;
  const format = input.technical.format;
  const extension = input.technical.extension;
  const formatOk = filters.formats.length > 0 && filters.formats.includes(format);
  const extensionOk =
    filters.extensions.length > 0 && extension !== null && filters.extensions.includes(extension);
  return formatOk || extensionOk ? 1 : 0;
}

function bitrateMatch(input: RankingInput): number {
  const minimum = input.query.filters.minBitrateBps;
  if (minimum === null) return 0.5;
  if (input.technical.lossless) return 1;
  const bitrate = input.technical.bitrate.averageBps ?? input.technical.bitrate.nominalBps;
  if (bitrate === null) return 0.25;
  return bitrate >= minimum ? 1 : 0;
}

function durationMatch(input: RankingInput): number {
  const { min, max } = input.query.filters.duration;
  const duration = input.technical.durationSeconds ?? input.claimed.durationSeconds;
  if (min === null && max === null) return duration === null ? 0.4 : 0.6;
  if (duration === null) return 0.25;
  if (min !== null && duration < min) return 0;
  if (max !== null && duration > max) return 0;
  return 1;
}

function compatibilityValue(input: RankingInput): number {
  if (input.compatibility.length === 0) return 0.5;
  const values = input.compatibility.map((assessment) => {
    switch (assessment.verdict) {
      case 'compatible':
        return 1;
      case 'probably_compatible':
        return 0.8;
      case 'transcoding_recommended':
        return 0.4;
      case 'incompatible':
        return 0.1;
      case 'unknown':
        return 0.45;
    }
  });
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function metadataRichness(input: RankingInput): number {
  const fields = [
    input.tags.title,
    input.tags.artist,
    input.tags.album,
    input.source.publishedAt,
    input.source.collection,
    input.source.artworkUrl,
    input.source.attribution,
  ];
  return fields.filter((field) => field !== null && field !== '').length / fields.length;
}

function freshness(input: RankingInput): number {
  // Freshness only matters for feed-shaped sources; archives are timeless.
  if (input.source.category !== 'podcast_feed') return 0.5;
  const published = input.source.publishedAt;
  if (!published) return 0.4;
  const ageMs = Date.now() - Date.parse(published);
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0.4;
  const ageDays = ageMs / 86_400_000;
  if (ageDays <= 7) return 1;
  if (ageDays <= 30) return 0.85;
  if (ageDays <= 365) return 0.6;
  return 0.4;
}

interface WeightedFactor {
  readonly factor: string;
  readonly label: string;
  readonly weight: number;
  readonly value: number;
  readonly explanation?: string;
}

export function scoreRanking(input: RankingInput): RankingScore {
  const relevance = textRelevance(input);
  const access = ACCESS_CERTAINTY[input.access];
  const compatibility = compatibilityValue(input);

  const factors: WeightedFactor[] = [
    {
      factor: 'text_relevance',
      label: 'Matches your search',
      weight: 0.26,
      value: relevance.value,
      ...(relevance.value > 0.7 ? { explanation: 'Closely matches your search terms.' } : {}),
    },
    {
      factor: 'exact_title',
      label: 'Exact title match',
      weight: 0.08,
      value: relevance.matchedExact ? 1 : 0,
      ...(relevance.matchedExact ? { explanation: 'The title matches your search exactly.' } : {}),
    },
    {
      factor: 'creator_match',
      label: 'Creator match',
      weight: 0.06,
      value: creatorMatch(input),
    },
    {
      factor: 'quality',
      label: 'Audio quality',
      weight: 0.16,
      value: input.quality.total,
      ...(input.quality.total > 0.8 ? { explanation: 'High technical quality.' } : {}),
    },
    {
      factor: 'access_certainty',
      label: 'Access certainty',
      weight: 0.14,
      value: access,
      ...(input.access === 'direct_download'
        ? { explanation: 'The file is published directly by the source.' }
        : {}),
    },
    {
      factor: 'verification',
      label: 'Verification confidence',
      weight: 0.08,
      value:
        input.verification.status === 'verified_audio'
          ? 1
          : input.verification.status === 'probable_audio'
            ? 0.6
            : 0.2,
      ...(input.verification.status === 'verified_audio'
        ? { explanation: 'Verified as audio by inspecting the file itself.' }
        : {}),
    },
    {
      factor: 'direct_file',
      label: 'Direct file available',
      weight: 0.05,
      value: input.hasDirectMediaUrl ? 1 : 0,
    },
    {
      factor: 'requested_format',
      label: 'Requested format',
      weight: 0.04,
      value: requestedFormatMatch(input),
    },
    {
      factor: 'requested_bitrate',
      label: 'Requested minimum bitrate',
      weight: 0.03,
      value: bitrateMatch(input),
    },
    {
      factor: 'duration_fit',
      label: 'Duration fits your filter',
      weight: 0.03,
      value: durationMatch(input),
    },
    {
      factor: 'compatibility',
      label: 'Device compatibility',
      weight: 0.03,
      value: compatibility,
      ...(compatibility >= 0.95 ? { explanation: 'Plays on the selected device profile.' } : {}),
    },
    {
      factor: 'metadata_richness',
      label: 'Metadata richness',
      weight: 0.02,
      value: metadataRichness(input),
    },
    {
      factor: 'freshness',
      label: 'Freshness',
      weight: 0.01,
      value: freshness(input),
    },
    {
      factor: 'provider_response',
      label: 'Provider response quality',
      weight: 0.01,
      value: clamp(input.providerResponseQuality),
    },
  ];

  const breakdown: ScoreBreakdownEntry[] = factors.map((factor) => ({
    factor: factor.factor,
    label: factor.label,
    weight: factor.weight,
    value: round(factor.value),
    contribution: round(factor.weight * factor.value),
  }));

  let total = breakdown.reduce((sum, entry) => sum + entry.contribution, 0);

  // A mirror of a better copy stays visible but never outranks its leader.
  if (input.isDuplicateOfBetter) total *= 0.6;

  const explanation = factors
    .filter((factor) => typeof factor.explanation === 'string')
    .sort((a, b) => b.weight * b.value - a.weight * a.value)
    .slice(0, 3)
    .map((factor) => factor.explanation as string);

  if (input.duplicateCount > 0 && !input.isDuplicateOfBetter) {
    explanation.push(`Best of ${input.duplicateCount + 1} copies found across sources.`);
  }
  if (explanation.length === 0) {
    explanation.push(
      'Ranked on a combination of match quality, verification and access certainty.',
    );
  }

  return {
    total: round(clamp(total)),
    relevance: round(relevance.value),
    quality: round(input.quality.total),
    accessCertainty: round(access),
    breakdown,
    explanation,
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
