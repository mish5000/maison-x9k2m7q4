/**
 * Privacy-safe metrics. Counters and histograms only — no identifiers, no query
 * text, no URLs. Labels are constrained to a small fixed vocabulary so a
 * high-cardinality value cannot leak through a label.
 */

export type MetricLabels = Readonly<Record<string, string>>;

interface HistogramState {
  count: number;
  sum: number;
  min: number;
  max: number;
  readonly buckets: Map<number, number>;
}

const DEFAULT_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000];

const SAFE_LABEL_PATTERN = /^[a-z0-9_:-]{1,48}$/;

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly histograms = new Map<string, HistogramState>();
  private readonly gauges = new Map<string, number>();

  increment(name: string, labels: MetricLabels = {}, value = 1): void {
    const key = seriesKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.gauges.set(seriesKey(name, labels), value);
  }

  observe(name: string, valueMs: number, labels: MetricLabels = {}): void {
    const key = seriesKey(name, labels);
    let state = this.histograms.get(key);
    if (!state) {
      state = { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0, buckets: new Map() };
      this.histograms.set(key, state);
    }
    state.count += 1;
    state.sum += valueMs;
    state.min = Math.min(state.min, valueMs);
    state.max = Math.max(state.max, valueMs);
    for (const bucket of DEFAULT_BUCKETS_MS) {
      if (valueMs <= bucket) state.buckets.set(bucket, (state.buckets.get(bucket) ?? 0) + 1);
    }
  }

  /** Times a promise and records success/failure separately. */
  async time<T>(name: string, labels: MetricLabels, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await fn();
      this.observe(name, Date.now() - startedAt, { ...labels, outcome: 'ok' });
      return result;
    } catch (error) {
      this.observe(name, Date.now() - startedAt, { ...labels, outcome: 'error' });
      throw error;
    }
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: Object.fromEntries(
        [...this.histograms].map(([key, state]) => [
          key,
          {
            count: state.count,
            sum: Math.round(state.sum),
            min: state.count > 0 ? Math.round(state.min) : 0,
            max: Math.round(state.max),
            meanMs: state.count > 0 ? Math.round(state.sum / state.count) : 0,
            buckets: Object.fromEntries(state.buckets),
          },
        ]),
      ),
    };
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }
}

export interface HistogramSnapshot {
  readonly count: number;
  readonly sum: number;
  readonly min: number;
  readonly max: number;
  readonly meanMs: number;
  readonly buckets: Readonly<Record<string, number>>;
}

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>;
  readonly gauges: Readonly<Record<string, number>>;
  readonly histograms: Readonly<Record<string, HistogramSnapshot>>;
}

function seriesKey(name: string, labels: MetricLabels): string {
  const entries = Object.entries(labels)
    .filter(([key, value]) => SAFE_LABEL_PATTERN.test(key) && SAFE_LABEL_PATTERN.test(value))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`);
  return entries.length > 0 ? `${name}{${entries.join(',')}}` : name;
}

export const METRIC = Object.freeze({
  searchStarted: 'auralis_search_started_total',
  searchCompleted: 'auralis_search_completed_total',
  searchCancelled: 'auralis_search_cancelled_total',
  searchDuration: 'auralis_search_duration_ms',
  providerDuration: 'auralis_provider_duration_ms',
  providerOutcome: 'auralis_provider_outcome_total',
  candidatesDiscovered: 'auralis_candidates_discovered_total',
  candidatesRejected: 'auralis_candidates_rejected_total',
  verificationOutcome: 'auralis_verification_outcome_total',
  verificationDuration: 'auralis_verification_duration_ms',
  timeouts: 'auralis_timeouts_total',
  circuitState: 'auralis_circuit_state',
  downloadIntent: 'auralis_download_intent_total',
  cacheHits: 'auralis_cache_hits_total',
  cacheMisses: 'auralis_cache_misses_total',
  connectorHealth: 'auralis_connector_health',
  errors: 'auralis_errors_total',
});
