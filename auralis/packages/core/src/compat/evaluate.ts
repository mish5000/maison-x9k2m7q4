import type {
  CompatibilityAssessment,
  CompatibilityVerdict,
  DeviceProfile,
} from '../domain/compat.js';
import type { MediaTechnicalMetadata } from '../domain/media.js';
import { DEFAULT_PROFILE_IDS, DEVICE_PROFILES, profileById } from './profiles.js';

/**
 * The single compatibility decision point. Profiles supply the limits; this
 * function supplies the reasoning, so device support can be updated without
 * touching decision logic.
 *
 * Auralis never claims universal compatibility. When the facts needed for a
 * decision are missing, the verdict is `unknown`.
 */

interface RuleOutcome {
  readonly rule: string;
  readonly verdict: CompatibilityVerdict;
  readonly reason: string;
}

const VERDICT_SEVERITY: Record<CompatibilityVerdict, number> = {
  compatible: 0,
  probably_compatible: 1,
  unknown: 2,
  transcoding_recommended: 3,
  incompatible: 4,
};

function worst(outcomes: readonly RuleOutcome[]): CompatibilityVerdict {
  let verdict: CompatibilityVerdict = 'compatible';
  for (const outcome of outcomes) {
    if (VERDICT_SEVERITY[outcome.verdict] > VERDICT_SEVERITY[verdict]) verdict = outcome.verdict;
  }
  return verdict;
}

export function evaluateCompatibility(
  technical: MediaTechnicalMetadata,
  profile: DeviceProfile,
): CompatibilityAssessment {
  const outcomes: RuleOutcome[] = [];

  // Container / codec
  if (technical.format === 'unknown') {
    outcomes.push({
      rule: 'format:unknown',
      verdict: 'unknown',
      reason: 'The file format has not been identified yet.',
    });
  } else if (!profile.containers.includes(technical.format)) {
    outcomes.push({
      rule: 'format:not-supported',
      verdict: 'incompatible',
      reason: `${technical.format.toUpperCase()} is not a supported format on this device.`,
    });
  } else if (profile.discouragedContainers.includes(technical.format)) {
    outcomes.push({
      rule: 'format:discouraged',
      verdict: 'transcoding_recommended',
      reason: `${technical.format.toUpperCase()} playback is unreliable on this device.`,
    });
  }

  if (technical.codec === 'unknown') {
    outcomes.push({
      rule: 'codec:unknown',
      verdict: 'unknown',
      reason: 'The audio codec could not be determined.',
    });
  } else if (!profile.codecs.includes(technical.codec)) {
    outcomes.push({
      rule: 'codec:not-supported',
      verdict: 'incompatible',
      reason: 'The audio codec inside this file is not supported on this device.',
    });
  }

  // Sample rate
  if (technical.sampleRateHz === null) {
    outcomes.push({
      rule: 'sample-rate:unknown',
      verdict: 'unknown',
      reason: 'The sample rate is not known.',
    });
  } else if (!profile.sampleRatesHz.includes(technical.sampleRateHz)) {
    outcomes.push({
      rule: 'sample-rate:out-of-range',
      verdict: 'transcoding_recommended',
      reason: `${(technical.sampleRateHz / 1000).toFixed(1)} kHz is outside this device's supported sample rates.`,
    });
  }

  // Bit depth, only meaningful for uncompressed and lossless formats.
  if (technical.lossless && technical.bitDepth !== null) {
    if (!profile.bitDepths.includes(technical.bitDepth)) {
      outcomes.push({
        rule: 'bit-depth:out-of-range',
        verdict: 'transcoding_recommended',
        reason: `${technical.bitDepth}-bit audio is outside this device's supported bit depths.`,
      });
    }
  }

  // Channels
  if (technical.channels === null) {
    outcomes.push({
      rule: 'channels:unknown',
      verdict: 'unknown',
      reason: 'The channel count is not known.',
    });
  } else if (technical.channels > profile.maxChannels) {
    outcomes.push({
      rule: 'channels:too-many',
      verdict: 'incompatible',
      reason: `This device supports up to ${profile.maxChannels} channels; this file has ${technical.channels}.`,
    });
  }

  // Bitrate limits apply only to lossy formats.
  if (!technical.lossless && profile.maxBitrateBps !== null) {
    const bitrate = technical.bitrate.nominalBps ?? technical.bitrate.averageBps;
    if (bitrate === null) {
      outcomes.push({
        rule: 'bitrate:unknown',
        verdict: 'unknown',
        reason: 'The bitrate is not known.',
      });
    } else if (bitrate > profile.maxBitrateBps * 1.02) {
      // A 2% tolerance absorbs VBR overshoot and rounding in derived averages.
      outcomes.push({
        rule: 'bitrate:above-maximum',
        verdict: 'transcoding_recommended',
        reason: `This device supports up to ${Math.round(profile.maxBitrateBps / 1000)} kbps for lossy files.`,
      });
    } else if (profile.minBitrateBps !== null && bitrate < profile.minBitrateBps) {
      outcomes.push({
        rule: 'bitrate:below-minimum',
        verdict: 'transcoding_recommended',
        reason: `This device expects at least ${Math.round(profile.minBitrateBps / 1000)} kbps.`,
      });
    }
  }

  // File integrity
  if (technical.corruptionSignals.length > 0) {
    outcomes.push({
      rule: 'integrity:corruption-signals',
      verdict: 'transcoding_recommended',
      reason: 'This file has structural problems that may prevent reliable playback.',
    });
  }

  if (technical.confidence === 'none' || technical.confidence === 'low') {
    outcomes.push({
      rule: 'confidence:insufficient',
      verdict: 'unknown',
      reason: 'Not enough of the file has been inspected to judge compatibility.',
    });
  }

  let verdict = worst(outcomes);
  // A clean run of checks with high-confidence metadata is the only path to a
  // plain "compatible" verdict; anything less says "probably".
  if (verdict === 'compatible' && technical.confidence !== 'high') {
    verdict = 'probably_compatible';
  }

  const relevant = outcomes.filter((o) => VERDICT_SEVERITY[o.verdict] >= VERDICT_SEVERITY[verdict]);

  return {
    profileId: profile.id,
    profileVersion: profile.version,
    profileLabel: profile.label,
    verdict,
    reasons:
      relevant.length > 0
        ? [...new Set(relevant.map((o) => o.reason))]
        : ['Format, sample rate, bit depth and channel count are all within this device’s limits.'],
    firedRules: outcomes.map((o) => o.rule),
  };
}

export function evaluateDefaultProfiles(
  technical: MediaTechnicalMetadata,
  profileIds: readonly string[] = DEFAULT_PROFILE_IDS,
): readonly CompatibilityAssessment[] {
  const profiles = profileIds
    .map((id) => profileById(id))
    .filter((profile): profile is DeviceProfile => profile !== null);
  const selected = profiles.length > 0 ? profiles : DEVICE_PROFILES;
  return selected.map((profile) => evaluateCompatibility(technical, profile));
}

/** True when the in-browser preview player can be expected to play this file. */
export function isBrowserPlayable(technical: MediaTechnicalMetadata): boolean {
  const profile = profileById('web-browser');
  if (!profile) return false;
  const assessment = evaluateCompatibility(technical, profile);
  return assessment.verdict === 'compatible' || assessment.verdict === 'probably_compatible';
}
