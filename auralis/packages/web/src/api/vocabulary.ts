/**
 * Runtime vocabularies.
 *
 * These mirror the `as const` arrays in `@auralis/core`, redeclared here because
 * the core package cannot be executed in a browser. Each array is annotated with
 * the core type it must remain assignable to, so a divergence in the engine
 * surfaces as a compile error in this file rather than as a silent UI bug.
 */

import type {
  AccessClassification,
  AudioFormat,
  ConnectorKind,
  ResultBadge,
  SearchMode,
} from './types.js';

export const SEARCH_MODE_VALUES: readonly SearchMode[] = ['quick', 'deep', 'connected'];

export const AUDIO_FORMAT_VALUES: readonly AudioFormat[] = [
  'mp3',
  'wav',
  'aiff',
  'flac',
  'aac',
  'm4a',
  'alac',
  'ogg',
  'opus',
  'unknown',
];

export const ACCESS_CLASSIFICATION_VALUES: readonly AccessClassification[] = [
  'direct_download',
  'source_download',
  'user_owned',
  'connected_private',
  'preview_only',
  'metadata_only',
  'restricted',
  'unknown',
];

export const BADGE_ORDER: readonly ResultBadge[] = [
  'verified_audio',
  'lossless',
  'direct_file',
  'source_download',
  'open_source',
  'connected_storage',
  'user_owned',
  'cdj_compatible',
  'vbr',
  'estimated_bitrate',
  'preview_only',
  'metadata_only',
  'unverified_metadata',
  'possible_duplicate',
  'compatibility_warning',
];

export const CONNECTOR_KIND_VALUES: readonly ConnectorKind[] = [
  's3-compatible',
  'webdav',
  'custom-json-api',
  'rss-feed',
  'http-directory',
  'ftp-directory',
  'local-directory',
];

/** Longest query the engine accepts (`MAX_QUERY_LENGTH` in core). */
export const MAX_QUERY_LENGTH = 256;

/** Device profiles the interface asks the engine to assess results against. */
export const DEFAULT_COMPATIBILITY_PROFILE_IDS: readonly string[] = ['cdj-3000'];

export const DEFAULT_LOCALE = 'en';
