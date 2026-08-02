import {
  UNKNOWN_ACCESS,
  type AccessAction,
  type AccessClassification,
  type AccessDecision,
} from '../domain/access.js';
import type { RawSearchCandidate } from '../domain/candidate.js';
import type { ProviderCapabilities } from '../domain/provider.js';
import type { VerificationRecord } from '../domain/media.js';

/**
 * The single approved access-classification service.
 *
 * SECURITY INVARIANT: this is the only place that may decide a result is
 * downloadable. The API's download-intent endpoint re-runs this function
 * server-side; a client-supplied classification is never trusted.
 *
 * The function is deliberately monotonic in one direction: a provider may
 * declare a *more* restrictive classification than the evidence supports and it
 * is honoured, but a provider claim can never upgrade a candidate past what the
 * verification evidence justifies.
 */

export interface ClassificationInput {
  readonly declared: AccessClassification;
  readonly capabilities: ProviderCapabilities;
  /**
   * True when Auralis has some way to obtain the bytes — a public URL, a local
   * path inside a selected folder, or a connector handle. It is deliberately
   * not "has a public URL": user-owned and connected assets never have one.
   */
  readonly hasRetrievableBytes: boolean;
  readonly hasPageUrl: boolean;
  readonly verification: VerificationRecord;
  /** True when the provider is an authenticated connector for this workspace. */
  readonly isConnectorResult: boolean;
  /** True when the asset came from a path the user themselves selected. */
  readonly isUserOwned: boolean;
  /** True when the connector's credentials are currently valid. */
  readonly credentialsValid: boolean;
}

const ORDER: readonly AccessClassification[] = [
  'restricted',
  'unknown',
  'metadata_only',
  'preview_only',
  'connected_private',
  'user_owned',
  'source_download',
  'direct_download',
];

function rank(classification: AccessClassification): number {
  const index = ORDER.indexOf(classification);
  return index === -1 ? 0 : index;
}

/** Returns the more restrictive of two classifications. */
export function mostRestrictive(
  a: AccessClassification,
  b: AccessClassification,
): AccessClassification {
  return rank(a) <= rank(b) ? a : b;
}

function actionsFor(
  classification: AccessClassification,
  input: ClassificationInput,
  previewable: boolean,
): readonly AccessAction[] {
  const actions: AccessAction[] = [];

  switch (classification) {
    case 'direct_download':
      if (previewable) actions.push('preview');
      actions.push('download', 'copy_direct_url');
      if (input.hasPageUrl) actions.push('visit_source', 'copy_source_url');
      break;
    case 'source_download':
      if (previewable) actions.push('preview');
      actions.push('download');
      if (input.hasPageUrl) actions.push('visit_source', 'copy_source_url');
      break;
    case 'user_owned':
      if (previewable) actions.push('preview');
      actions.push('download');
      break;
    case 'connected_private':
      if (!input.credentialsValid) {
        actions.push('connect_account', 'inspect_metadata');
        break;
      }
      if (previewable) actions.push('preview');
      actions.push('download');
      break;
    case 'preview_only':
      if (previewable) actions.push('preview');
      if (input.hasPageUrl) actions.push('visit_source', 'copy_source_url');
      else actions.push('open_provider');
      break;
    case 'metadata_only':
      if (input.hasPageUrl) actions.push('visit_source', 'copy_source_url');
      else actions.push('open_provider');
      break;
    case 'restricted':
      if (input.capabilities.requiresAuthentication) actions.push('request_credentials');
      if (input.hasPageUrl) actions.push('visit_source');
      break;
    case 'unknown':
      if (input.hasPageUrl) actions.push('visit_source');
      break;
  }

  actions.push('inspect_metadata');
  return [...new Set(actions)];
}

const REASONS: Record<AccessClassification, string> = {
  direct_download: 'This source publishes the file directly.',
  source_download: 'Download runs through this source’s own download page.',
  user_owned: 'This file is in storage you selected.',
  connected_private: 'This file is in an account you connected.',
  preview_only: 'This source offers a preview but not a download.',
  metadata_only: 'This source lists the recording but does not publish the file.',
  restricted: 'This source requires access that Auralis does not have.',
  unknown: 'Access to this file has not been verified yet.',
};

export function classifyAccess(input: ClassificationInput): AccessDecision {
  const evidence: string[] = [`provider:declared=${input.declared}`];

  // Start from what the provider declared and narrow from there.
  let classification: AccessClassification = input.declared;

  if (input.isUserOwned) {
    classification = mostRestrictive(classification, 'user_owned');
    evidence.push('scope:user-selected-storage');
  } else if (input.isConnectorResult) {
    classification = mostRestrictive(classification, 'connected_private');
    evidence.push('scope:connected-account');
    if (!input.credentialsValid) {
      classification = 'restricted';
      evidence.push('credentials:expired');
    }
  }

  if (!input.hasRetrievableBytes) {
    // Without a media URL there is nothing to download, whatever was declared.
    classification = mostRestrictive(
      classification,
      input.capabilities.supportsPreview ? 'preview_only' : 'metadata_only',
    );
    evidence.push('bytes:not-retrievable');
  }

  const verified =
    input.verification.status === 'verified_audio' ||
    input.verification.status === 'probable_audio';

  if (input.verification.status === 'not_audio') {
    classification = 'metadata_only';
    evidence.push('verification:not-audio');
  } else if (input.verification.status === 'playlist') {
    classification = mostRestrictive(classification, 'metadata_only');
    evidence.push('verification:playlist-not-a-file');
  } else if (!verified && rank(classification) >= rank('connected_private')) {
    // A downloadable classification requires positive verification evidence.
    classification = 'unknown';
    evidence.push('verification:insufficient-evidence');
  }

  if (classification === 'direct_download' && !input.capabilities.returnsDirectMediaUrls) {
    classification = 'source_download';
    evidence.push('capability:provider-does-not-publish-direct-urls');
  }

  if (verified) evidence.push(`verification:${input.verification.status}`);
  if (input.verification.signatureAgreement) evidence.push('verification:signature-agreement');

  const previewable = input.capabilities.supportsPreview && input.hasRetrievableBytes && verified;

  return {
    classification,
    actions: actionsFor(classification, input, previewable),
    reason: REASONS[classification],
    evidence,
  };
}

/** Convenience wrapper for candidates that have not been probed yet. */
export function provisionalAccess(
  candidate: RawSearchCandidate,
  capabilities: ProviderCapabilities,
): AccessDecision {
  if (!candidate.pageUrl && !candidate.mediaUrl) return UNKNOWN_ACCESS;
  return {
    ...UNKNOWN_ACCESS,
    actions: candidate.pageUrl ? ['visit_source', 'inspect_metadata'] : ['inspect_metadata'],
    evidence: [`provider:declared=${candidate.declaredAccess}`, 'verification:pending'],
    reason: capabilities.requiresAuthentication
      ? 'Checking your connected account for this file.'
      : UNKNOWN_ACCESS.reason,
  };
}
