/**
 * Access classification is the single source of truth for what a user may do
 * with a candidate. The UI derives available actions from it; the API enforces
 * it. Nothing else in the system is permitted to authorise a download.
 *
 * See docs/security/source-access-policy.md
 */

export const ACCESS_CLASSIFICATIONS = [
  'direct_download',
  'source_download',
  'user_owned',
  'connected_private',
  'preview_only',
  'metadata_only',
  'restricted',
  'unknown',
] as const;

export type AccessClassification = (typeof ACCESS_CLASSIFICATIONS)[number];

/**
 * Actions the interface is permitted to surface. `download` is the only
 * security-sensitive one; the rest are navigational or informational.
 */
export const ACCESS_ACTIONS = [
  'preview',
  'download',
  'visit_source',
  'copy_source_url',
  'copy_direct_url',
  'inspect_metadata',
  'open_provider',
  'connect_account',
  'request_credentials',
] as const;

export type AccessAction = (typeof ACCESS_ACTIONS)[number];

export interface AccessDecision {
  readonly classification: AccessClassification;
  /** Actions permitted for this candidate, in display priority order. */
  readonly actions: readonly AccessAction[];
  /** Human-readable, non-technical reason shown in the UI when download is unavailable. */
  readonly reason: string;
  /**
   * Machine-readable evidence for the decision. Used by tests and the
   * `Why this result?` panel. Never contains credentials or signed URLs.
   */
  readonly evidence: readonly string[];
}

/**
 * The conservative default. Anything we have not positively classified is
 * treated as `unknown`, which never permits download.
 */
export const UNKNOWN_ACCESS: AccessDecision = Object.freeze({
  classification: 'unknown',
  actions: Object.freeze(['visit_source', 'inspect_metadata'] as const),
  reason: 'Access to this file has not been verified yet.',
  evidence: Object.freeze([] as const),
});

/** Classifications for which a download may *ever* be offered. */
export const DOWNLOADABLE_CLASSIFICATIONS: ReadonlySet<AccessClassification> = new Set([
  'direct_download',
  'source_download',
  'user_owned',
  'connected_private',
]);

/** Classifications whose results must never enter a shared (cross-tenant) cache. */
export const PRIVATE_CLASSIFICATIONS: ReadonlySet<AccessClassification> = new Set([
  'user_owned',
  'connected_private',
]);

export function isDownloadableClassification(c: AccessClassification): boolean {
  return DOWNLOADABLE_CLASSIFICATIONS.has(c);
}

export function isPrivateClassification(c: AccessClassification): boolean {
  return PRIVATE_CLASSIFICATIONS.has(c);
}
