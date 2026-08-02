import { describe, expect, it } from 'vitest';

import {
  capabilities,
  classifyAccess,
  isDownloadableClassification,
  isPrivateClassification,
  mostRestrictive,
  UNVERIFIED,
  type ProviderCapabilities,
  type VerificationRecord,
} from '../src/index.js';

const publicProvider: ProviderCapabilities = capabilities({
  returnsDirectMediaUrls: true,
  supportsPreview: true,
  sourceCategory: 'open_archive',
});

const connectorProvider: ProviderCapabilities = capabilities({
  requiresAuthentication: true,
  producesPrivateResults: true,
  supportsPreview: true,
  sourceCategory: 'connected_storage',
});

const verified: VerificationRecord = {
  ...UNVERIFIED,
  status: 'verified_audio',
  signatureAgreement: true,
  checkedAt: new Date().toISOString(),
};

const notAudio: VerificationRecord = { ...UNVERIFIED, status: 'not_audio' };
const playlist: VerificationRecord = { ...UNVERIFIED, status: 'playlist' };

function classify(overrides: Partial<Parameters<typeof classifyAccess>[0]> = {}) {
  return classifyAccess({
    declared: 'direct_download',
    capabilities: publicProvider,
    hasRetrievableBytes: true,
    hasPageUrl: true,
    verification: verified,
    isConnectorResult: false,
    isUserOwned: false,
    credentialsValid: true,
    ...overrides,
  });
}

describe('access classification', () => {
  it('permits download for a verified direct file', () => {
    const decision = classify();
    expect(decision.classification).toBe('direct_download');
    expect(decision.actions).toContain('download');
    expect(decision.actions).toContain('preview');
    expect(decision.actions).toContain('copy_direct_url');
  });

  it('never permits download without positive verification evidence', () => {
    const decision = classify({ verification: UNVERIFIED });
    expect(decision.classification).toBe('unknown');
    expect(decision.actions).not.toContain('download');
    expect(decision.evidence).toContain('verification:insufficient-evidence');
  });

  it('downgrades a file that turned out not to be audio', () => {
    const decision = classify({ verification: notAudio });
    expect(decision.classification).toBe('metadata_only');
    expect(decision.actions).not.toContain('download');
    expect(decision.actions).not.toContain('preview');
  });

  it('refuses to present a playlist as a downloadable file', () => {
    const decision = classify({ verification: playlist });
    expect(decision.classification).toBe('metadata_only');
    expect(decision.actions).not.toContain('download');
    expect(decision.evidence).toContain('verification:playlist-not-a-file');
  });

  it('falls back to preview or metadata when there is no media URL', () => {
    expect(classify({ hasRetrievableBytes: false }).classification).toBe('preview_only');
    expect(
      classify({
        hasRetrievableBytes: false,
        capabilities: capabilities({ supportsPreview: false, sourceCategory: 'open_archive' }),
      }).classification,
    ).toBe('metadata_only');
  });

  it('never upgrades past what the provider can actually offer', () => {
    const decision = classify({
      capabilities: capabilities({ returnsDirectMediaUrls: false, supportsPreview: true }),
    });
    expect(decision.classification).toBe('source_download');
    expect(decision.evidence).toContain('capability:provider-does-not-publish-direct-urls');
    expect(decision.actions).not.toContain('copy_direct_url');
  });

  it('honours a provider that declares something more restrictive', () => {
    expect(classify({ declared: 'preview_only' }).classification).toBe('preview_only');
    expect(classify({ declared: 'restricted' }).classification).toBe('restricted');
  });

  it('classifies connector results as private and requires valid credentials', () => {
    const ok = classify({
      declared: 'connected_private',
      capabilities: connectorProvider,
      isConnectorResult: true,
    });
    expect(ok.classification).toBe('connected_private');
    expect(ok.actions).toContain('download');

    const expired = classify({
      declared: 'connected_private',
      capabilities: connectorProvider,
      isConnectorResult: true,
      credentialsValid: false,
    });
    expect(expired.classification).toBe('restricted');
    expect(expired.actions).not.toContain('download');
    expect(expired.evidence).toContain('credentials:expired');
  });

  it('classifies user-selected storage as user owned', () => {
    const decision = classify({ declared: 'user_owned', isUserOwned: true, hasPageUrl: false });
    expect(decision.classification).toBe('user_owned');
    expect(decision.actions).toContain('download');
  });

  it('offers a way forward for restricted results instead of a dead end', () => {
    const decision = classify({
      declared: 'restricted',
      capabilities: capabilities({ requiresAuthentication: true }),
    });
    expect(decision.actions).toContain('request_credentials');
    expect(decision.actions).toContain('visit_source');
    expect(decision.reason.length).toBeGreaterThan(0);
  });

  it('always allows metadata inspection', () => {
    for (const declared of ['restricted', 'unknown', 'metadata_only', 'preview_only'] as const) {
      expect(classify({ declared }).actions).toContain('inspect_metadata');
    }
  });

  it('ranks classifications so the more restrictive one always wins', () => {
    expect(mostRestrictive('direct_download', 'preview_only')).toBe('preview_only');
    expect(mostRestrictive('restricted', 'unknown')).toBe('restricted');
    expect(mostRestrictive('user_owned', 'source_download')).toBe('user_owned');
  });

  it('agrees on which classifications are downloadable and which are private', () => {
    expect(isDownloadableClassification('direct_download')).toBe(true);
    expect(isDownloadableClassification('preview_only')).toBe(false);
    expect(isDownloadableClassification('unknown')).toBe(false);
    expect(isPrivateClassification('connected_private')).toBe(true);
    expect(isPrivateClassification('user_owned')).toBe(true);
    expect(isPrivateClassification('direct_download')).toBe(false);
  });
});
