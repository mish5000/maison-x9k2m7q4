/**
 * Every machine token the engine emits gets a plain-language label here.
 * Nothing in the interface renders a raw enum value.
 */

import type {
  AccessAction,
  AccessClassification,
  CompatibilityVerdict,
  Confidence,
  ConnectorKind,
  ProviderOutcome,
  RejectionReason,
  ResultBadge,
  SearchMode,
  SourceCategory,
  VerificationStatus,
} from '../api/types.js';

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

function fallback(token: string): string {
  const cleaned = token.replace(/[_-]+/g, ' ').trim();
  if (cleaned.length === 0) return 'Unknown';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/* ------------------------------------------------------------------ badges */

const BADGE_LABELS: Record<ResultBadge, string> = {
  verified_audio: 'Verified audio',
  direct_file: 'Direct file',
  open_source: 'Open source',
  source_download: 'Source download',
  connected_storage: 'Connected storage',
  user_owned: 'User owned',
  preview_only: 'Preview only',
  metadata_only: 'Metadata only',
  unverified_metadata: 'Unverified metadata',
  possible_duplicate: 'Possible duplicate',
  vbr: 'VBR',
  lossless: 'Lossless',
  cdj_compatible: 'CDJ compatible',
  compatibility_warning: 'Compatibility warning',
  estimated_bitrate: 'Estimated bitrate',
};

/**
 * Badge tone never carries meaning on its own — the label is always rendered
 * alongside it. Only `verified_audio` uses the accent, keeping it scarce.
 */
const BADGE_TONES: Record<ResultBadge, Tone> = {
  verified_audio: 'accent',
  direct_file: 'neutral',
  open_source: 'neutral',
  source_download: 'neutral',
  connected_storage: 'neutral',
  user_owned: 'neutral',
  preview_only: 'neutral',
  metadata_only: 'neutral',
  unverified_metadata: 'warning',
  possible_duplicate: 'neutral',
  vbr: 'neutral',
  lossless: 'success',
  cdj_compatible: 'success',
  compatibility_warning: 'warning',
  estimated_bitrate: 'warning',
};

const BADGE_DESCRIPTIONS: Record<ResultBadge, string> = {
  verified_audio: 'Auralis fetched part of this file and confirmed it is real audio.',
  direct_file: 'The source exposes the audio file itself, not only a web page.',
  open_source: 'Published by an open archive or open-data source.',
  source_download: 'Downloading happens on the source website.',
  connected_storage: 'Found in storage you connected to Auralis.',
  user_owned: 'This file is in a location you own.',
  preview_only: 'Only a short preview is available from this source.',
  metadata_only: 'The source publishes details about this recording but not the file.',
  unverified_metadata: 'These details come from the source and have not been confirmed.',
  possible_duplicate: 'Another copy of this recording was found elsewhere.',
  vbr: 'Encoded with a variable bitrate.',
  lossless: 'No audio data was discarded when this file was encoded.',
  cdj_compatible: 'Matches the requirements of the selected CDJ profile.',
  compatibility_warning: 'This file may not play correctly on a selected device.',
  estimated_bitrate: 'The bitrate was calculated from size and length, not read from the file.',
};

export function badgeLabel(badge: ResultBadge): string {
  return BADGE_LABELS[badge] ?? fallback(badge);
}

export function badgeTone(badge: ResultBadge): Tone {
  return BADGE_TONES[badge] ?? 'neutral';
}

export function badgeDescription(badge: ResultBadge): string {
  return BADGE_DESCRIPTIONS[badge] ?? '';
}

/* ------------------------------------------------------------------ access */

const ACCESS_LABELS: Record<AccessClassification, string> = {
  direct_download: 'Direct download',
  source_download: 'Download from source',
  user_owned: 'Your own file',
  connected_private: 'Private connected source',
  preview_only: 'Preview only',
  metadata_only: 'Details only',
  restricted: 'Restricted',
  unknown: 'Access unknown',
};

export function accessLabel(value: AccessClassification | string): string {
  return ACCESS_LABELS[value as AccessClassification] ?? fallback(value);
}

const ACTION_LABELS: Record<AccessAction, string> = {
  preview: 'Preview',
  download: 'Download',
  visit_source: 'Open source page',
  copy_source_url: 'Copy source link',
  copy_direct_url: 'Copy file link',
  inspect_metadata: 'Technical details',
  open_provider: 'Open provider',
  connect_account: 'Connect account',
  request_credentials: 'Request access',
};

export function actionLabel(action: AccessAction): string {
  return ACTION_LABELS[action] ?? fallback(action);
}

/* ------------------------------------------------------------ verification */

const VERIFICATION_LABELS: Record<VerificationStatus, string> = {
  verified_audio: 'Verified audio',
  probable_audio: 'Probably audio',
  unverified: 'Not yet checked',
  not_audio: 'Not an audio file',
  verification_failed: 'Could not be checked',
  playlist: 'Playlist, not a single file',
};

const VERIFICATION_TONES: Record<VerificationStatus, Tone> = {
  verified_audio: 'success',
  probable_audio: 'neutral',
  unverified: 'neutral',
  not_audio: 'danger',
  verification_failed: 'warning',
  playlist: 'warning',
};

const VERIFICATION_DETAIL: Record<VerificationStatus, string> = {
  verified_audio: 'Auralis read the beginning of the file and confirmed the audio format.',
  probable_audio: 'The headers look like audio, but the file itself was not read in full.',
  unverified: 'This file has not been checked yet. Details come from the source.',
  not_audio: 'What the source published at this address is not an audio file.',
  verification_failed: 'The file could not be reached for checking. Details are from the source.',
  playlist: 'This address points at a playlist. Individual tracks may be listed separately.',
};

export function verificationLabel(status: VerificationStatus): string {
  return VERIFICATION_LABELS[status] ?? fallback(status);
}

export function verificationTone(status: VerificationStatus): Tone {
  return VERIFICATION_TONES[status] ?? 'neutral';
}

export function verificationDetail(status: VerificationStatus): string {
  return VERIFICATION_DETAIL[status] ?? '';
}

/* ---------------------------------------------------------- compatibility */

const VERDICT_LABELS: Record<CompatibilityVerdict, string> = {
  compatible: 'Plays',
  probably_compatible: 'Probably plays',
  transcoding_recommended: 'Convert first',
  incompatible: 'Will not play',
  unknown: 'Unknown',
};

const VERDICT_TONES: Record<CompatibilityVerdict, Tone> = {
  compatible: 'success',
  probably_compatible: 'neutral',
  transcoding_recommended: 'warning',
  incompatible: 'danger',
  unknown: 'neutral',
};

export function verdictLabel(verdict: CompatibilityVerdict | string): string {
  return VERDICT_LABELS[verdict as CompatibilityVerdict] ?? fallback(verdict);
}

export function verdictTone(verdict: CompatibilityVerdict | string): Tone {
  return VERDICT_TONES[verdict as CompatibilityVerdict] ?? 'neutral';
}

/* --------------------------------------------------------------- providers */

export interface OutcomeDisplay {
  readonly label: string;
  readonly tone: Tone;
  readonly detail: string;
}

const OUTCOME_DISPLAY: Record<ProviderOutcome, OutcomeDisplay> = {
  ok: { label: 'Done', tone: 'success', detail: 'This source finished searching.' },
  empty: {
    label: 'No matches',
    tone: 'neutral',
    detail: 'This source had nothing for this query.',
  },
  timeout: {
    label: 'Timed out',
    tone: 'warning',
    detail: 'This source did not answer in time. Results from it may be missing.',
  },
  rate_limited: {
    label: 'Rate limited',
    tone: 'warning',
    detail: 'This source is limiting requests at the moment. Try again shortly.',
  },
  error: {
    label: 'Unavailable',
    tone: 'danger',
    detail: 'This source could not be searched this time.',
  },
  cancelled: { label: 'Stopped', tone: 'neutral', detail: 'Searching this source was stopped.' },
  circuit_open: {
    label: 'Paused',
    tone: 'warning',
    detail: 'Auralis paused this source after repeated failures. It will be retried later.',
  },
  not_configured: {
    label: 'Needs setup',
    tone: 'warning',
    detail: 'This source needs to be set up before it can be searched.',
  },
  auth_required: {
    label: 'Sign-in needed',
    tone: 'warning',
    detail: 'This source needs an account connection before it can be searched.',
  },
};

export function outcomeDisplay(outcome: ProviderOutcome | string): OutcomeDisplay {
  return (
    OUTCOME_DISPLAY[outcome as ProviderOutcome] ?? {
      label: fallback(outcome),
      tone: 'neutral' as Tone,
      detail: '',
    }
  );
}

const PROVIDER_STATUS_LABELS: Record<string, string> = {
  ready: 'Ready',
  not_configured: 'Needs setup',
  auth_required: 'Sign-in needed',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  disabled: 'Turned off',
};

const PROVIDER_STATUS_TONES: Record<string, Tone> = {
  ready: 'success',
  not_configured: 'warning',
  auth_required: 'warning',
  degraded: 'warning',
  unavailable: 'danger',
  disabled: 'neutral',
};

export function providerStatusLabel(status: string): string {
  return PROVIDER_STATUS_LABELS[status] ?? fallback(status);
}

export function providerStatusTone(status: string): Tone {
  return PROVIDER_STATUS_TONES[status] ?? 'neutral';
}

/* -------------------------------------------------------------- connectors */

const CONNECTOR_STATUS_LABELS: Record<string, string> = {
  ready: 'Connected',
  not_configured: 'Configuration needed',
  auth_required: 'Sign-in expired',
  error: 'Not working',
  untested: 'Not tested yet',
};

const CONNECTOR_STATUS_TONES: Record<string, Tone> = {
  ready: 'success',
  not_configured: 'warning',
  auth_required: 'warning',
  error: 'danger',
  untested: 'neutral',
};

export function connectorStatusLabel(status: string): string {
  return CONNECTOR_STATUS_LABELS[status] ?? fallback(status);
}

export function connectorStatusTone(status: string): Tone {
  return CONNECTOR_STATUS_TONES[status] ?? 'neutral';
}

const CONNECTOR_KIND_LABELS: Record<ConnectorKind, string> = {
  's3-compatible': 'S3-compatible storage',
  webdav: 'WebDAV',
  'custom-json-api': 'Custom JSON API',
  'rss-feed': 'RSS or podcast feed',
  'http-directory': 'HTTP directory',
  'ftp-directory': 'FTP directory',
  'local-directory': 'Local folder',
};

export function connectorKindLabel(kind: ConnectorKind | string): string {
  return CONNECTOR_KIND_LABELS[kind as ConnectorKind] ?? fallback(kind);
}

/* ------------------------------------------------------------------ source */

const SOURCE_CATEGORY_LABELS: Record<SourceCategory, string> = {
  open_archive: 'Open archive',
  open_data: 'Open data',
  podcast_feed: 'Podcast feed',
  audio_api: 'Audio API',
  http_directory: 'Web directory',
  ftp_directory: 'FTP directory',
  local_files: 'Local files',
  connected_storage: 'Connected storage',
  organisation_repository: 'Organisation repository',
  unknown: 'Unclassified source',
};

export function sourceCategoryLabel(category: SourceCategory | string): string {
  return SOURCE_CATEGORY_LABELS[category as SourceCategory] ?? fallback(category);
}

/* ------------------------------------------------------------------- misc */

const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
  none: 'Not measured',
};

export function confidenceLabel(confidence: Confidence | string): string {
  return CONFIDENCE_LABELS[confidence as Confidence] ?? fallback(confidence);
}

const BITRATE_MODE_LABELS: Record<string, string> = {
  cbr: 'CBR',
  abr: 'ABR',
  vbr: 'VBR',
  lossless: 'Lossless',
  unknown: 'Unknown mode',
};

export function bitrateModeLabel(mode: string): string {
  return BITRATE_MODE_LABELS[mode] ?? fallback(mode);
}

const MODE_LABELS: Record<SearchMode, string> = {
  quick: 'Quick',
  deep: 'Deep',
  connected: 'Connected sources',
};

const MODE_DESCRIPTIONS: Record<SearchMode, string> = {
  quick: 'Fast pass over the fastest open sources.',
  deep: 'Searches more sources and verifies more files. Takes longer.',
  connected: 'Searches only the storage and feeds you have connected.',
};

export function modeLabel(mode: SearchMode): string {
  return MODE_LABELS[mode] ?? fallback(mode);
}

export function modeDescription(mode: SearchMode): string {
  return MODE_DESCRIPTIONS[mode] ?? '';
}

const REJECTION_LABELS: Record<RejectionReason, string> = {
  unsafe_url: 'Address was not safe to open',
  not_audio: 'Not an audio file',
  duplicate: 'Duplicate of another result',
  excluded_term: 'Contained an excluded word',
  filter_mismatch: 'Did not match your filters',
  probe_failed: 'File could not be checked',
  oversized: 'File was too large to check',
  playlist_unresolved: 'Playlist could not be opened',
};

export function rejectionLabel(reason: RejectionReason | string): string {
  return REJECTION_LABELS[reason as RejectionReason] ?? fallback(reason);
}
