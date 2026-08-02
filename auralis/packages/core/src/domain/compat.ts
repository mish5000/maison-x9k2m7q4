/** Device compatibility assessment vocabulary. */

export const COMPATIBILITY_VERDICTS = [
  'compatible',
  'probably_compatible',
  'transcoding_recommended',
  'incompatible',
  'unknown',
] as const;

export type CompatibilityVerdict = (typeof COMPATIBILITY_VERDICTS)[number];

export interface CompatibilityAssessment {
  readonly profileId: string;
  readonly profileVersion: string;
  readonly profileLabel: string;
  readonly verdict: CompatibilityVerdict;
  /** Short, user-facing reasons. Never a raw rule dump. */
  readonly reasons: readonly string[];
  /** Rule identifiers that fired, for debugging and tests. */
  readonly firedRules: readonly string[];
}

/**
 * A versioned device profile. Profiles live in JSON configuration
 * (src/compat/profiles) so that device limits are never scattered through
 * conditionals in application code.
 */
export interface DeviceProfile {
  readonly id: string;
  readonly version: string;
  readonly label: string;
  readonly vendor: string;
  /** Documentation link the UI can show. Optional. */
  readonly reference: string | null;
  readonly containers: readonly string[];
  readonly codecs: readonly string[];
  readonly sampleRatesHz: readonly number[];
  readonly bitDepths: readonly number[];
  readonly maxChannels: number;
  readonly maxBitrateBps: number | null;
  readonly minBitrateBps: number | null;
  /** Formats that play but are explicitly discouraged by the vendor. */
  readonly discouragedContainers: readonly string[];
  readonly notes: readonly string[];
}
