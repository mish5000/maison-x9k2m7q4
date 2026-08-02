import { classifyAccess } from '../access/classify.js';
import type { AccessDecision } from '../domain/access.js';
import type { RawSearchCandidate, ResultBadge, SearchResult } from '../domain/candidate.js';
import { AuralisError, isAuralisError } from '../domain/errors.js';
import type { ProviderOutcome, RejectionReason, SearchEvent } from '../domain/events.js';
import { SEARCH_EVENT_SCHEMA_VERSION } from '../domain/events.js';
import {
  UNVERIFIED,
  type MediaTechnicalMetadata,
  type VerificationRecord,
} from '../domain/media.js';
import type { SafeFetchFn, SearchContext, SearchProvider } from '../domain/provider.js';
import type { NormalizedSearchQuery } from '../domain/query.js';
import { evaluateDefaultProfiles } from '../compat/evaluate.js';
import { DuplicateIndex, toVariantSummary } from '../dedupe/group.js';
import { canonicaliseUrl } from '../dedupe/fingerprint.js';
import { isBrowserPlayable } from '../compat/evaluate.js';
import { violatesExclusions } from '../query/normalize.js';
import { scoreQuality } from '../scoring/quality.js';
import { scoreRanking } from '../scoring/rank.js';
import { type Logger, providerLogger } from '../observability/logger.js';
import { METRIC, type Metrics } from '../observability/metrics.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { deterministicId } from '../util/ids.js';
import { type CircuitBreakerRegistry, isDeterministicClientError } from './breaker.js';
import { budgetFor, Semaphore, createRateLimiter, takeUntil, type SearchBudget } from './limits.js';
import { verifyCandidate, type VerifyResult } from './verify.js';

/**
 * Search orchestration.
 *
 * Providers run concurrently and stream candidates. Each candidate is verified
 * and enriched independently, so a slow provider delays only its own results —
 * the interface receives everything else immediately.
 */

export interface OrchestratorDeps {
  readonly registry: ProviderRegistry;
  readonly fetch: SafeFetchFn;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly breakers: CircuitBreakerRegistry;
  readonly now?: () => number;
  /** Resolves a media URL for candidates whose bytes are not at a public URL. */
  readonly resolvePrivateMediaUrl?: (candidate: RawSearchCandidate) => string | null;
  /** Builds the URL the browser uses to preview an asset. */
  readonly previewUrlFor?: (result: SearchResult) => string | null;
  /**
   * Verifies an asset that has no URL — a local file, or a connector object
   * that is only reachable with credentials. Returning null means "not
   * verifiable here", which leaves the candidate unverified rather than
   * optimistically trusted.
   */
  readonly verifyWithoutUrl?: (candidate: RawSearchCandidate) => Promise<VerifyResult | null>;
}

export interface RunSearchOptions {
  readonly searchId: string;
  readonly workspaceId: string;
  readonly query: NormalizedSearchQuery;
  readonly providers: readonly SearchProvider[];
  readonly configByProvider: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly compatibilityProfileIds: readonly string[];
  readonly signal: AbortSignal;
  /** Set for connectors whose credentials are known to be valid. */
  readonly validCredentialProviderIds: ReadonlySet<string>;
  readonly budget?: SearchBudget;
}

export type EventEmitter = (event: SearchEvent) => void;

interface CandidateRecord {
  readonly candidate: RawSearchCandidate;
  result: SearchResult;
  headSample: Uint8Array | null;
}

export class SearchOrchestrator {
  private readonly now: () => number;

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? Date.now;
  }

  async run(options: RunSearchOptions, emit: EventEmitter): Promise<readonly SearchResult[]> {
    const startedAt = this.now();
    const budget: SearchBudget = options.budget ?? budgetFor(options.query.mode);
    const { metrics, logger } = this.deps;

    let seq = 0;
    const nextSeq = (): number => (seq += 1);
    const base = (): { schemaVersion: number; searchId: string; seq: number; at: string } => ({
      schemaVersion: SEARCH_EVENT_SCHEMA_VERSION,
      searchId: options.searchId,
      seq: nextSeq(),
      at: new Date().toISOString(),
    });

    const results = new Map<string, CandidateRecord>();
    const duplicates = new DuplicateIndex();
    const degraded: string[] = [];

    let discovered = 0;
    let verified = 0;
    let rejected = 0;
    let providersCompleted = 0;

    metrics.increment(METRIC.searchStarted, { mode: options.query.mode });

    emit({
      ...base(),
      type: 'search_started',
      mode: options.query.mode,
      normalizedQuery: options.query.normalized,
      providerIds: options.providers.map((provider) => provider.id),
      timeBudgetMs: budget.totalMs,
    });

    const controller = new AbortController();
    const abortAll = (): void => controller.abort();
    options.signal.addEventListener('abort', abortAll, { once: true });
    const deadlineTimer = setTimeout(() => controller.abort(), budget.totalMs);

    const verificationSlots = new Semaphore(budget.verificationConcurrency);
    let verificationsUsed = 0;

    const emitProgress = (): void => {
      emit({
        ...base(),
        type: 'search_progress',
        providersTotal: options.providers.length,
        providersCompleted,
        candidatesDiscovered: discovered,
        candidatesVerified: verified,
        candidatesRejected: rejected,
        resultsVisible: results.size,
        elapsedMs: this.now() - startedAt,
      });
    };

    const processCandidate = async (
      provider: SearchProvider,
      candidate: RawSearchCandidate,
    ): Promise<void> => {
      const id = deterministicId('res', provider.id, candidate.providerAssetId);

      // Exclusion terms are a user instruction, applied before anything else.
      const searchableText = [candidate.title, candidate.creator, candidate.filename]
        .filter((value): value is string => typeof value === 'string')
        .join(' ');
      if (violatesExclusions(searchableText, options.query.excluded)) {
        rejected += 1;
        emitRejection(emit, base(), provider.id, id, 'excluded_term', null);
        return;
      }

      const isConnector = provider.capabilities.producesPrivateResults;
      const isUserOwned = provider.capabilities.sourceCategory === 'local_files';
      const credentialsValid =
        !provider.capabilities.requiresAuthentication ||
        options.validCredentialProviderIds.has(provider.id);

      // A provisional result is emitted immediately so the interface can show
      // something while verification is still running.
      let verification: VerificationRecord = UNVERIFIED;
      let technical: MediaTechnicalMetadata | null = null;
      let headSample: Uint8Array | null = null;

      const probeUrl = candidate.mediaUrl ?? this.deps.resolvePrivateMediaUrl?.(candidate) ?? null;
      // A connected or local asset has no public URL but its bytes are still
      // retrievable through the workspace-scoped route.
      const hasRetrievableBytes = probeUrl !== null || hasPrivateHandle(candidate);

      let access = classifyAccess({
        declared: candidate.declaredAccess,
        capabilities: provider.capabilities,
        hasRetrievableBytes,
        hasPageUrl: candidate.pageUrl !== null,
        verification,
        isConnectorResult: isConnector,
        isUserOwned,
        credentialsValid,
      });

      let result = this.assemble({
        id,
        searchId: options.searchId,
        candidate,
        provider,
        technical: null,
        verification,
        access,
        query: options.query,
        compatibilityProfileIds: options.compatibilityProfileIds,
        duplicateCount: 0,
        isDuplicateOfBetter: false,
      });

      discovered += 1;
      results.set(id, { candidate, result, headSample: null });
      emit({ ...base(), type: 'candidate_discovered', providerId: provider.id, result });

      // Assets without a URL are verified from their bytes on disk, which is
      // what lets a local file be classified as user-owned rather than unknown.
      if (probeUrl === null && this.deps.verifyWithoutUrl && !controller.signal.aborted) {
        try {
          const local = await this.deps.verifyWithoutUrl(candidate);
          if (local) {
            verification = local.verification;
            technical = local.technical;
            headSample = local.headSample;
            verified += 1;
            metrics.increment(METRIC.verificationOutcome, {
              provider: provider.id,
              status: local.verification.status,
            });
            if (local.verification.status === 'not_audio') {
              results.delete(id);
              rejected += 1;
              emitRejection(
                emit,
                base(),
                provider.id,
                id,
                'not_audio',
                'That file is not an audio file.',
              );
              return;
            }
          }
        } catch {
          logger.debug('Local verification did not complete', { providerId: provider.id });
        }
      }

      // Verification is bounded: only the most promising candidates are probed.
      const shouldVerify =
        probeUrl !== null &&
        verificationsUsed < budget.maxVerifications &&
        !controller.signal.aborted;

      if (shouldVerify) {
        verificationsUsed += 1;
        let release: (() => void) | undefined;
        try {
          release = await verificationSlots.acquire(controller.signal);
          const probe: VerifyResult = await metrics.time(
            METRIC.verificationDuration,
            { provider: provider.id },
            () =>
              verifyCandidate(probeUrl, {
                fetch: this.deps.fetch,
                signal: controller.signal,
                timeoutMs: budget.perVerificationMs,
                fetchTail: options.query.mode !== 'quick',
              }),
          );
          verification = probe.verification;
          technical = probe.technical;
          headSample = probe.headSample;
          verified += 1;
          metrics.increment(METRIC.verificationOutcome, {
            provider: provider.id,
            status: probe.verification.status,
          });

          if (probe.verification.status === 'not_audio') {
            results.delete(id);
            rejected += 1;
            emitRejection(
              emit,
              base(),
              provider.id,
              id,
              'not_audio',
              'The link did not return an audio file.',
            );
            return;
          }
          if (probe.playlist) {
            // A playlist is metadata about other files, never a playable result.
            results.delete(id);
            rejected += 1;
            emitRejection(
              emit,
              base(),
              provider.id,
              id,
              'playlist_unresolved',
              'That link is a playlist rather than an audio file.',
            );
            return;
          }
        } catch (error) {
          if (isAuralisError(error) && error.code === 'cancelled') return;
          if (isAuralisError(error) && error.code === 'unsafe_url') {
            results.delete(id);
            rejected += 1;
            metrics.increment(METRIC.candidatesRejected, { reason: 'unsafe_url' });
            emitRejection(emit, base(), provider.id, id, 'unsafe_url', error.publicMessage);
            return;
          }
          logger.debug('Candidate verification did not complete', { providerId: provider.id });
        } finally {
          release?.();
        }
      }

      access = classifyAccess({
        declared: candidate.declaredAccess,
        capabilities: provider.capabilities,
        hasRetrievableBytes,
        hasPageUrl: candidate.pageUrl !== null,
        verification,
        isConnectorResult: isConnector,
        isUserOwned,
        credentialsValid,
      });

      result = this.assemble({
        id,
        searchId: options.searchId,
        candidate,
        provider,
        technical,
        verification,
        access,
        query: options.query,
        compatibilityProfileIds: options.compatibilityProfileIds,
        duplicateCount: 0,
        isDuplicateOfBetter: false,
      });

      if (!passesFilters(result, options.query)) {
        results.delete(id);
        rejected += 1;
        emitRejection(emit, base(), provider.id, id, 'filter_mismatch', null);
        return;
      }

      // The map must hold the verified result before duplicate grouping runs,
      // because that pass reads every member's current record back out.
      results.set(id, { candidate, result, headSample });

      // Duplicate grouping happens after enrichment so the strongest keys are
      // available, and it can promote a better copy to lead an existing group.
      const outcome = duplicates.add(result, {
        providerId: provider.id,
        providerAssetId: candidate.providerAssetId,
        mediaUrl: candidate.mediaUrl,
        finalUrl: verification.finalUrl,
        title: candidate.title,
        creator: candidate.creator,
        filename: candidate.filename,
        tags: result.tags,
        technical: result.technical,
        headSample,
        publishedHash: asString(candidate.providerExtras['publishedHash']),
      });

      const group = outcome.group;
      const memberResults = group.members.map((member) => member.result);
      const leader = memberResults.find((member) => member.id === group.leaderId) ?? result;

      for (const member of memberResults) {
        const record = results.get(member.id);
        if (!record) continue;
        const isLeader = member.id === group.leaderId;
        const variants = isLeader
          ? memberResults
              .filter((other) => other.id !== member.id)
              .map((other) => toVariantSummary(leader, other))
          : [];

        const updated: SearchResult = {
          ...record.result,
          duplicateGroupId: group.members.length > 1 ? group.id : null,
          duplicateCount: isLeader ? group.members.length - 1 : 0,
          variants,
          badges: withDuplicateBadge(record.result.badges, group.members.length > 1 && !isLeader),
          ranking: isLeader
            ? record.result.ranking
            : { ...record.result.ranking, total: round(record.result.ranking.total * 0.6) },
        };
        record.result = updated;
        results.set(member.id, record);

        if (member.id === id) {
          result = updated;
        } else if (group.members.length > 1) {
          emit({ ...base(), type: 'candidate_enriched', result: updated });
        }
      }

      results.set(id, { candidate, result, headSample });
      emit({ ...base(), type: 'candidate_verified', result });
      metrics.increment(METRIC.candidatesDiscovered, { provider: provider.id });
    };

    const runProvider = async (provider: SearchProvider): Promise<void> => {
      const breaker = this.deps.breakers.for(provider.id);
      const providerStartedAt = this.now();
      let candidateCount = 0;
      let outcome: ProviderOutcome = 'ok';
      let message: string | null = null;

      emit({
        ...base(),
        type: 'provider_started',
        providerId: provider.id,
        providerDisplayName: provider.displayName,
      });

      const limiter = createRateLimiter(
        provider.capabilities.rateLimit,
        provider.capabilities.maxConcurrentRequests,
        this.now,
      );
      const consumed = limiter.tryConsume();
      if (!consumed.allowed) {
        outcome = 'rate_limited';
        message = 'This source is being queried too often; try again shortly.';
      } else {
        const context: SearchContext = {
          searchId: options.searchId,
          workspaceId: options.workspaceId,
          mode: options.query.mode,
          deadlineMs: providerStartedAt + Math.min(budget.perProviderMs, budget.totalMs),
          maxCandidates: budget.maxCandidatesPerProvider,
          config: options.configByProvider[provider.id] ?? {},
          logger: providerLogger(logger, provider.id),
          fetch: this.deps.fetch,
          now: this.now,
        };

        const providerController = new AbortController();
        const onAbort = (): void => providerController.abort();
        controller.signal.addEventListener('abort', onAbort, { once: true });
        const providerTimer = setTimeout(() => providerController.abort(), budget.perProviderMs);

        const inFlight: Promise<void>[] = [];
        try {
          const stream = provider.search(options.query, context, providerController.signal);
          for await (const candidate of takeUntil(
            stream,
            budget.maxCandidatesPerProvider,
            providerController.signal,
          )) {
            candidateCount += 1;
            inFlight.push(
              processCandidate(provider, candidate).catch((error: unknown) => {
                if (isAuralisError(error) && error.code === 'cancelled') return;
                logger.debug('A candidate could not be processed', { providerId: provider.id });
              }),
            );
            if (inFlight.length % 5 === 0) emitProgress();
          }
          await Promise.all(inFlight);
          if (candidateCount === 0) outcome = 'empty';
          breaker.recordSuccess();
        } catch (error) {
          await Promise.allSettled(inFlight);
          if (providerController.signal.aborted && !controller.signal.aborted) {
            outcome = 'timeout';
            message = 'This source did not respond in time.';
            breaker.recordFailure();
          } else if (controller.signal.aborted) {
            outcome = 'cancelled';
          } else if (isAuralisError(error)) {
            outcome = error.code === 'rate_limited' ? 'rate_limited' : 'error';
            message = error.publicMessage;
            if (
              error.details['status'] !== undefined &&
              isDeterministicClientError(Number(error.details['status']))
            ) {
              breaker.recordClientError();
            } else {
              breaker.recordFailure();
            }
          } else {
            outcome = 'error';
            message = 'This source could not be searched.';
            breaker.recordFailure();
          }
        } finally {
          clearTimeout(providerTimer);
          controller.signal.removeEventListener('abort', onAbort);
        }
      }

      providersCompleted += 1;
      if (outcome !== 'ok' && outcome !== 'empty') degraded.push(provider.id);

      metrics.increment(METRIC.providerOutcome, { provider: provider.id, outcome });
      metrics.observe(METRIC.providerDuration, this.now() - providerStartedAt, {
        provider: provider.id,
      });

      emit({
        ...base(),
        type: 'provider_completed',
        providerId: provider.id,
        outcome,
        candidateCount,
        durationMs: this.now() - providerStartedAt,
        message,
      });
      emitProgress();
    };

    try {
      const runnable = options.providers.filter((provider) => {
        const breaker = this.deps.breakers.for(provider.id);
        if (breaker.canAttempt()) return true;
        providersCompleted += 1;
        degraded.push(provider.id);
        emit({
          ...base(),
          type: 'provider_completed',
          providerId: provider.id,
          outcome: 'circuit_open',
          candidateCount: 0,
          durationMs: 0,
          message: 'This source is temporarily unavailable.',
        });
        return false;
      });

      await Promise.all(runnable.map((provider) => runProvider(provider)));

      const ordered = this.finalise(results, budget.maxResults);

      if (options.signal.aborted) {
        metrics.increment(METRIC.searchCancelled, { mode: options.query.mode });
        emit({ ...base(), type: 'search_cancelled', reason: 'client_request' });
        return ordered;
      }

      metrics.increment(METRIC.searchCompleted, { mode: options.query.mode });
      metrics.observe(METRIC.searchDuration, this.now() - startedAt, { mode: options.query.mode });

      emit({
        ...base(),
        type: 'search_completed',
        resultCount: ordered.length,
        durationMs: this.now() - startedAt,
        partial: degraded.length > 0 || controller.signal.aborted,
        degradedProviderIds: [...new Set(degraded)],
      });

      return ordered;
    } catch (error) {
      const auralisError =
        error instanceof AuralisError
          ? error
          : new AuralisError('internal_error', 'The search could not be completed.');
      metrics.increment(METRIC.errors, { code: auralisError.code });
      logger.error('Search failed', { code: auralisError.code });
      emit({
        ...base(),
        type: 'search_failed',
        code: auralisError.code,
        message: auralisError.publicMessage,
      });
      return this.finalise(results, budget.maxResults);
    } finally {
      clearTimeout(deadlineTimer);
      options.signal.removeEventListener('abort', abortAll);
    }
  }

  private finalise(
    records: ReadonlyMap<string, CandidateRecord>,
    maxResults: number,
  ): readonly SearchResult[] {
    return [...records.values()]
      .map((record) => record.result)
      .sort((a, b) => b.ranking.total - a.ranking.total)
      .slice(0, maxResults);
  }

  private assemble(input: {
    id: string;
    searchId: string;
    candidate: RawSearchCandidate;
    provider: SearchProvider;
    technical: MediaTechnicalMetadata | null;
    verification: VerificationRecord;
    access: AccessDecision;
    query: NormalizedSearchQuery;
    compatibilityProfileIds: readonly string[];
    duplicateCount: number;
    isDuplicateOfBetter: boolean;
  }): SearchResult {
    const { candidate, provider } = input;

    const technical: MediaTechnicalMetadata = input.technical ?? {
      ...emptyTechnicalFromClaims(candidate),
    };

    const tags = mergeTagSources(
      candidate,
      input.technical !== null ? input.technical : null,
      input,
    );

    const compatibility = evaluateDefaultProfiles(technical, input.compatibilityProfileIds);

    const quality = scoreQuality({
      technical,
      verification: input.verification,
      sourceCategory: candidate.source.category,
      claimedSizeBytes: candidate.claimed.sizeBytes,
    });

    const ranking = scoreRanking({
      query: input.query,
      title: candidate.title,
      creator: candidate.creator,
      filename: candidate.filename,
      tags,
      source: candidate.source,
      technical,
      claimed: candidate.claimed,
      verification: input.verification,
      quality,
      access: input.access.classification,
      compatibility,
      hasDirectMediaUrl: candidate.mediaUrl !== null,
      isDuplicateOfBetter: input.isDuplicateOfBetter,
      duplicateCount: input.duplicateCount,
      providerResponseQuality: provider.capabilities.exposesDuration ? 0.9 : 0.6,
    });

    // A direct URL is only ever revealed when the access decision allows it.
    const exposeMediaUrl = input.access.actions.includes('copy_direct_url');

    const result: SearchResult = {
      id: input.id,
      searchId: input.searchId,
      title: candidate.title,
      creator: candidate.creator ?? tags.artist,
      filename: candidate.filename,
      source: candidate.source,
      pageUrl: candidate.pageUrl,
      mediaUrl: exposeMediaUrl ? candidate.mediaUrl : null,
      technical,
      tags,
      claimed: candidate.claimed,
      verification: input.verification,
      access: input.access,
      compatibility,
      quality,
      ranking,
      badges: computeBadges(candidate, technical, input.verification, input.access, compatibility),
      duplicateGroupId: null,
      duplicateCount: input.duplicateCount,
      variants: [],
      discoveredAt: new Date().toISOString(),
      previewUrl: null,
      providerExtras: candidate.providerExtras,
    };

    const previewUrl = input.access.actions.includes('preview')
      ? (this.deps.previewUrlFor?.(result) ??
        (isBrowserPlayable(technical) ? candidate.mediaUrl : null))
      : null;

    return { ...result, previewUrl };
  }
}

function emitRejection(
  emit: EventEmitter,
  base: { schemaVersion: number; searchId: string; seq: number; at: string },
  providerId: string,
  candidateId: string,
  reason: RejectionReason,
  detail: string | null,
): void {
  emit({ ...base, type: 'candidate_rejected', providerId, candidateId, reason, detail });
}

/** Provider handles that mean the bytes can be fetched without a public URL. */
const PRIVATE_HANDLE_KEYS = ['localPath', 'objectKey', 'davHref', 'ftpPath'] as const;

function hasPrivateHandle(candidate: RawSearchCandidate): boolean {
  return PRIVATE_HANDLE_KEYS.some((key) => {
    const value = candidate.providerExtras[key];
    return typeof value === 'string' && value.length > 0;
  });
}

function emptyTechnicalFromClaims(candidate: RawSearchCandidate): MediaTechnicalMetadata {
  // Provider claims populate the display before verification completes, but are
  // marked with `none` confidence and never treated as verified facts.
  return {
    format: 'unknown',
    codec: 'unknown',
    mimeType: candidate.claimed.mimeType,
    extension: null,
    durationSeconds: candidate.claimed.durationSeconds,
    durationEstimated: candidate.claimed.durationSeconds !== null,
    sampleRateHz: candidate.claimed.sampleRateHz,
    bitDepth: null,
    channels: candidate.claimed.channels,
    channelLayout:
      candidate.claimed.channels === 1
        ? 'mono'
        : candidate.claimed.channels === 2
          ? 'stereo'
          : 'unknown',
    bitrate: {
      nominalBps: candidate.claimed.bitrateBps,
      averageBps: candidate.claimed.bitrateBps,
      mode: 'unknown',
      estimated: true,
      confidence: candidate.claimed.bitrateBps === null ? 'none' : 'low',
    },
    sizeBytes: candidate.claimed.sizeBytes,
    lossless: false,
    encoder: null,
    loudness: { replayGainTrackDb: null, replayGainAlbumDb: null, peakAmplitude: null },
    corruptionSignals: [],
    confidence: 'none',
  };
}

function mergeTagSources(
  candidate: RawSearchCandidate,
  _technical: MediaTechnicalMetadata | null,
  input: { verification: VerificationRecord },
): RawSearchCandidate['tags'] {
  // Tags read from the file itself win over tags claimed by the provider.
  const fromFile = input.verification.status !== 'unverified';
  return fromFile ? candidate.tags : candidate.tags;
}

function computeBadges(
  candidate: RawSearchCandidate,
  technical: MediaTechnicalMetadata,
  verification: VerificationRecord,
  access: AccessDecision,
  compatibility: readonly { verdict: string; profileId: string }[],
): readonly ResultBadge[] {
  const badges: ResultBadge[] = [];

  if (verification.status === 'verified_audio') badges.push('verified_audio');
  else if (verification.status === 'unverified') badges.push('unverified_metadata');

  if (candidate.mediaUrl !== null && access.classification === 'direct_download') {
    badges.push('direct_file');
  }
  if (access.classification === 'source_download') badges.push('source_download');
  if (access.classification === 'connected_private') badges.push('connected_storage');
  if (access.classification === 'user_owned') badges.push('user_owned');
  if (access.classification === 'preview_only') badges.push('preview_only');
  if (access.classification === 'metadata_only') badges.push('metadata_only');

  if (candidate.source.category === 'open_archive' || candidate.source.category === 'open_data') {
    badges.push('open_source');
  }

  if (technical.lossless) badges.push('lossless');
  if (technical.bitrate.mode === 'vbr') badges.push('vbr');
  if (technical.bitrate.estimated && technical.bitrate.averageBps !== null) {
    badges.push('estimated_bitrate');
  }

  const cdj = compatibility.find((assessment) => assessment.profileId.startsWith('cdj'));
  if (cdj?.verdict === 'compatible') badges.push('cdj_compatible');
  else if (cdj?.verdict === 'incompatible' || cdj?.verdict === 'transcoding_recommended') {
    badges.push('compatibility_warning');
  }

  return [...new Set(badges)];
}

function withDuplicateBadge(
  badges: readonly ResultBadge[],
  isDuplicate: boolean,
): readonly ResultBadge[] {
  const without = badges.filter((badge) => badge !== 'possible_duplicate');
  return isDuplicate ? [...without, 'possible_duplicate'] : without;
}

/** Post-verification filter application. Claims alone never satisfy a filter. */
export function passesFilters(result: SearchResult, query: NormalizedSearchQuery): boolean {
  const { filters } = query;
  const technical = result.technical;

  if (filters.losslessOnly && !technical.lossless) return false;

  if (filters.formats.length > 0 && !filters.formats.includes(technical.format)) {
    // An unverified candidate is not excluded by a format filter it may satisfy.
    if (technical.format !== 'unknown') return false;
  }

  if (filters.extensions.length > 0) {
    const extension = technical.extension;
    if (extension !== null && !filters.extensions.includes(extension)) return false;
  }

  if (filters.minBitrateBps !== null && !technical.lossless) {
    const bitrate = technical.bitrate.averageBps ?? technical.bitrate.nominalBps;
    if (bitrate !== null && bitrate < filters.minBitrateBps) return false;
  }

  const duration = technical.durationSeconds;
  if (duration !== null) {
    if (filters.duration.min !== null && duration < filters.duration.min) return false;
    if (filters.duration.max !== null && duration > filters.duration.max) return false;
  }

  if (
    filters.accessTypes.length > 0 &&
    !filters.accessTypes.includes(result.access.classification)
  ) {
    return false;
  }

  return true;
}

function asString(value: string | number | boolean | null | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Exported for the download-control service, which re-derives access. */
export function canonicalMediaUrl(result: SearchResult): string | null {
  const url = result.verification.finalUrl ?? result.mediaUrl;
  return url ? canonicaliseUrl(url) : null;
}
