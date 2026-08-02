import {
  assertUrlAllowed,
  AuralisError,
  classifyAccess,
  contentDispositionAttachment,
  filenameFromUrl,
  isDownloadableClassification,
  sanitiseFilename,
  UnsafeUrlError,
  type AccessClassification,
  type DownloadIntentResponse,
  type ProviderRegistry,
  type SearchResult,
  type UrlSafetyPolicy,
} from '@auralis/core';

import type { ConnectorRepository } from '../db/connectors.js';
import type { AuditRepository, SearchRepository } from '../db/repositories.js';
import { presignS3Url } from '@auralis/core';

/**
 * The single approved download-control service.
 *
 * SECURITY INVARIANT: no route may enable a download by any other path. The
 * client's opinion is irrelevant — the access decision is recomputed here from
 * the stored verification record, and the URL is re-validated before it is
 * handed back.
 */

export interface DownloadControlDeps {
  readonly registry: ProviderRegistry;
  readonly searches: SearchRepository;
  readonly connectors: ConnectorRepository;
  readonly audit: AuditRepository;
  readonly policy: UrlSafetyPolicy;
  /** Builds the workspace-scoped streaming URL for assets with no public URL. */
  readonly mediatedUrlFor: (searchId: string, resultId: string) => string;
  readonly now?: () => number;
}

const PRESIGN_TTL_SECONDS = 300;

export class DownloadControlService {
  constructor(private readonly deps: DownloadControlDeps) {}

  async createIntent(input: {
    readonly workspaceId: string;
    readonly searchId: string;
    readonly resultId: string;
  }): Promise<DownloadIntentResponse> {
    const stored = this.deps.searches.getResult(input.searchId, input.resultId, input.workspaceId);
    if (!stored) throw new AuralisError('not_found', 'That result could not be found.');

    const result = stored.result;
    const provider = this.deps.registry.get(result.source.providerId);
    if (!provider) {
      return this.deny(input, result, 'That source is no longer available.');
    }

    const connectorConfig = stored.connectorId
      ? this.deps.connectors.resolveConfig(input.workspaceId, stored.connectorId)
      : null;
    const credentialsValid =
      !provider.capabilities.requiresAuthentication || connectorConfig !== null;

    // Recompute rather than trusting the stored decision: the connector may
    // have been disconnected, or its credentials may have expired, since.
    const decision = classifyAccess({
      declared: result.access.classification,
      capabilities: provider.capabilities,
      hasRetrievableBytes:
        stored.mediaUrl !== null || stored.finalUrl !== null || stored.localPath !== null,
      hasPageUrl: result.pageUrl !== null,
      verification: result.verification,
      isConnectorResult: provider.capabilities.producesPrivateResults,
      isUserOwned: provider.capabilities.sourceCategory === 'local_files',
      credentialsValid,
    });

    if (
      !decision.actions.includes('download') ||
      !isDownloadableClassification(decision.classification)
    ) {
      return this.deny(input, result, decision.reason, decision.classification);
    }

    const verified =
      result.verification.status === 'verified_audio' ||
      result.verification.status === 'probable_audio';
    if (!verified) {
      return this.deny(
        input,
        result,
        'This file has not been verified as audio, so it cannot be downloaded from here.',
        decision.classification,
      );
    }

    const plan = await this.resolveTransfer(input.workspaceId, stored, decision.classification);
    if (!plan) {
      return this.deny(
        input,
        result,
        'The link for this file is no longer valid. Run the search again.',
        decision.classification,
      );
    }

    const filename = sanitiseFilename(
      result.filename ?? filenameFromUrl(plan.url ?? stored.mediaUrl) ?? result.title,
      result.technical.extension ?? result.technical.format,
    );

    this.deps.audit.recordDownloadIntent({
      workspaceId: input.workspaceId,
      searchId: input.searchId,
      resultId: input.resultId,
      providerId: result.source.providerId,
      accessClass: decision.classification,
      allowed: true,
      reason: 'permitted',
      method: plan.method,
      finalHost: plan.host,
    });

    return {
      assetId: result.id,
      allowed: true,
      method: plan.method,
      url: plan.url,
      filename: filename.filename,
      expiresAt: plan.expiresAt,
      reason: decision.reason,
      classification: decision.classification,
      summary: this.summarise(result),
    };
  }

  private async resolveTransfer(
    workspaceId: string,
    stored: {
      readonly result: SearchResult;
      readonly mediaUrl: string | null;
      readonly finalUrl: string | null;
      readonly localPath: string | null;
      readonly connectorId: string | null;
    },
    classification: AccessClassification,
  ): Promise<{
    readonly method: 'direct' | 'provider_endpoint' | 'server_mediated';
    readonly url: string | null;
    readonly host: string | null;
    readonly expiresAt: string | null;
  } | null> {
    const now = this.deps.now?.() ?? Date.now();

    // Objects in connected storage get a short-lived presigned URL so the
    // bytes go straight from the source to the browser, never through Auralis.
    if (classification === 'connected_private' && stored.connectorId) {
      const config = this.deps.connectors.resolveConfig(workspaceId, stored.connectorId);
      const objectKey = extraString(stored.result, 'objectKey');
      if (config && objectKey && config['endpoint'] && config['bucket']) {
        try {
          const url = presignS3Url({
            method: 'GET',
            url: buildObjectUrl(config, objectKey),
            region: config['region'] ?? 'us-east-1',
            accessKeyId: config['accessKeyId'] ?? '',
            secretAccessKey: config['secretAccessKey'] ?? '',
            now: new Date(now),
            expiresInSeconds: PRESIGN_TTL_SECONDS,
          });
          return {
            method: 'provider_endpoint',
            url,
            host: new URL(url).host,
            expiresAt: new Date(now + PRESIGN_TTL_SECONDS * 1000).toISOString(),
          };
        } catch {
          return null;
        }
      }
      // Any other connected source streams through the workspace-scoped route.
      return {
        method: 'server_mediated',
        url: this.deps.mediatedUrlFor(stored.result.searchId, stored.result.id),
        host: null,
        expiresAt: null,
      };
    }

    if (classification === 'user_owned') {
      if (!stored.localPath) return null;
      return {
        method: 'server_mediated',
        url: this.deps.mediatedUrlFor(stored.result.searchId, stored.result.id),
        host: null,
        expiresAt: null,
      };
    }

    const candidateUrl = stored.finalUrl ?? stored.mediaUrl;
    if (!candidateUrl) return null;

    // Re-validate: a host that was safe during the search may not be now.
    try {
      const target = await assertUrlAllowed(candidateUrl, this.deps.policy);
      return {
        method: classification === 'source_download' ? 'provider_endpoint' : 'direct',
        url: target.url.toString(),
        host: target.hostname,
        expiresAt: null,
      };
    } catch (error) {
      if (error instanceof UnsafeUrlError) return null;
      return null;
    }
  }

  private deny(
    input: { readonly workspaceId: string; readonly searchId: string; readonly resultId: string },
    result: SearchResult,
    reason: string,
    classification: AccessClassification = result.access.classification,
  ): DownloadIntentResponse {
    this.deps.audit.recordDownloadIntent({
      workspaceId: input.workspaceId,
      searchId: input.searchId,
      resultId: input.resultId,
      providerId: result.source.providerId,
      accessClass: classification,
      allowed: false,
      reason,
      method: null,
      finalHost: null,
    });

    return {
      assetId: result.id,
      allowed: false,
      method: null,
      url: null,
      filename: sanitiseFilename(result.filename ?? result.title, result.technical.format).filename,
      expiresAt: null,
      reason,
      classification,
      summary: this.summarise(result),
    };
  }

  private summarise(result: SearchResult): DownloadIntentResponse['summary'] {
    return {
      format: result.technical.format,
      sizeBytes: result.technical.sizeBytes,
      durationSeconds: result.technical.durationSeconds,
      bitrateBps: result.technical.bitrate.averageBps ?? result.technical.bitrate.nominalBps,
      bitrateEstimated: result.technical.bitrate.estimated,
      sourceName: result.source.providerDisplayName,
      sourceHost: result.source.sourceHost,
      attribution: result.source.attribution,
      rightsStatement: result.source.rightsStatement,
      verificationStatus: result.verification.status,
      compatibility: result.compatibility.map((assessment) => ({
        profileLabel: assessment.profileLabel,
        verdict: assessment.verdict,
      })),
    };
  }
}

function extraString(result: SearchResult, key: string): string | null {
  const value = result.providerExtras[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function buildObjectUrl(config: Readonly<Record<string, string>>, objectKey: string): URL {
  const endpoint = config['endpoint'] ?? '';
  const bucket = config['bucket'] ?? '';
  const pathStyle = (config['pathStyle'] ?? '').toLowerCase() === 'true';
  const url = new URL(endpoint);
  const encodedKey = objectKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  if (pathStyle) {
    url.pathname = `/${bucket}/${encodedKey}`;
  } else {
    url.hostname = `${bucket}.${url.hostname}`;
    url.pathname = `/${encodedKey}`;
  }
  return url;
}

export { contentDispositionAttachment };
