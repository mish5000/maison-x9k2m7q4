import type { SearchMode } from '../domain/query.js';
import type { ProviderHealth, ProviderStatus, SearchProvider } from '../domain/provider.js';

/**
 * The provider registry.
 *
 * Registration is explicit: a provider that is not registered here is never
 * reachable, and the `verify-provider-registration` check in CI fails when an
 * adapter file exists without a registry entry.
 */

export interface ProviderRegistration {
  readonly provider: SearchProvider;
  /** Providers that need configuration are listed but not selected until ready. */
  readonly setupDocPath: string | null;
  /** Secret configuration keys, encrypted at rest and never returned by the API. */
  readonly secretConfigKeys: readonly string[];
  /** Enabled by default when no configuration is required. */
  readonly enabledByDefault: boolean;
}

export interface ProviderSelection {
  readonly selected: readonly SearchProvider[];
  readonly skipped: readonly { readonly providerId: string; readonly reason: SkipReason }[];
}

export type SkipReason =
  'not_in_mode' | 'not_configured' | 'disabled' | 'circuit_open' | 'excluded_by_filter';

export interface SelectionInput {
  readonly mode: SearchMode;
  /** Provider ids the user restricted the search to. Empty means "no restriction". */
  readonly requestedProviderIds: readonly string[];
  /** Configuration available for this workspace, keyed by provider id. */
  readonly configByProvider: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Provider ids explicitly disabled by configuration. */
  readonly disabledProviderIds: ReadonlySet<string>;
  /** Predicate supplied by the orchestrator so open circuits are skipped. */
  readonly canAttempt: (providerId: string) => boolean;
}

export class ProviderRegistry {
  private readonly registrations = new Map<string, ProviderRegistration>();

  register(registration: ProviderRegistration): this {
    const id = registration.provider.id;
    if (this.registrations.has(id)) {
      throw new Error(`Provider ${id} is already registered`);
    }
    this.registrations.set(id, registration);
    return this;
  }

  get(providerId: string): SearchProvider | null {
    return this.registrations.get(providerId)?.provider ?? null;
  }

  registration(providerId: string): ProviderRegistration | null {
    return this.registrations.get(providerId) ?? null;
  }

  all(): readonly ProviderRegistration[] {
    return [...this.registrations.values()];
  }

  ids(): readonly string[] {
    return [...this.registrations.keys()];
  }

  secretKeysFor(providerId: string): readonly string[] {
    return this.registrations.get(providerId)?.secretConfigKeys ?? [];
  }

  /** Whether a provider has everything it needs for this workspace. */
  configurationStatus(
    providerId: string,
    config: Readonly<Record<string, string>>,
  ): ProviderStatus {
    const registration = this.registrations.get(providerId);
    if (!registration) return 'disabled';
    const required = registration.provider.capabilities.requiredConfiguration;
    if (required.length === 0) return 'ready';
    const missing = required.filter((key) => {
      const value = config[key];
      return typeof value !== 'string' || value.trim().length === 0;
    });
    return missing.length === 0 ? 'ready' : 'not_configured';
  }

  select(input: SelectionInput): ProviderSelection {
    const selected: SearchProvider[] = [];
    const skipped: { providerId: string; reason: SkipReason }[] = [];

    for (const registration of this.registrations.values()) {
      const { provider } = registration;
      const id = provider.id;

      if (input.disabledProviderIds.has(id)) {
        skipped.push({ providerId: id, reason: 'disabled' });
        continue;
      }
      if (input.requestedProviderIds.length > 0 && !input.requestedProviderIds.includes(id)) {
        skipped.push({ providerId: id, reason: 'excluded_by_filter' });
        continue;
      }
      if (!provider.capabilities.modes.includes(input.mode)) {
        skipped.push({ providerId: id, reason: 'not_in_mode' });
        continue;
      }
      const config = input.configByProvider[id] ?? {};
      if (this.configurationStatus(id, config) !== 'ready') {
        skipped.push({ providerId: id, reason: 'not_configured' });
        continue;
      }
      if (!input.canAttempt(id)) {
        skipped.push({ providerId: id, reason: 'circuit_open' });
        continue;
      }

      selected.push(provider);
    }

    return { selected, skipped };
  }
}

/** Maps a skip reason to the health status shown on the diagnostics page. */
export function statusForSkipReason(reason: SkipReason): ProviderStatus {
  switch (reason) {
    case 'not_configured':
      return 'not_configured';
    case 'disabled':
    case 'excluded_by_filter':
    case 'not_in_mode':
      return 'disabled';
    case 'circuit_open':
      return 'degraded';
  }
}

export function unavailableHealth(
  providerId: string,
  message: string,
  setupDocPath: string | null,
): ProviderHealth {
  return {
    providerId,
    status: 'unavailable',
    message,
    checkedAt: new Date().toISOString(),
    latencyMs: null,
    setupDocPath,
  };
}
