import type { ResultVariantSummary, SearchResult } from '../domain/candidate.js';
import {
  computeFingerprints,
  LEVEL_STRENGTH,
  type Fingerprint,
  type FingerprintInput,
} from './fingerprint.js';

/**
 * Incremental duplicate grouping.
 *
 * Results stream in, so grouping has to work one candidate at a time and be
 * able to change its mind: when a better copy of an existing group arrives, the
 * leader is replaced and the previous leader becomes a variant.
 *
 * Meaningful differences (format, bitrate, duration, sample rate, channels,
 * size, source, integrity) are never hidden — they are surfaced as the reasons
 * a variant differs.
 */

/** Fingerprint levels strong enough to merge on their own. */
const AUTHORITATIVE_LEVELS = new Set([
  'content_hash',
  'final_url',
  'canonical_url',
  'provider_asset',
]);

/** Weaker levels need agreement from at least this many keys to merge. */
const CORROBORATION_REQUIRED = 2;

export interface DuplicateMember {
  readonly result: SearchResult;
  readonly fingerprints: readonly Fingerprint[];
  readonly headSample: Uint8Array | null;
}

export interface DuplicateGroup {
  readonly id: string;
  leaderId: string;
  readonly members: DuplicateMember[];
  /** The strongest fingerprint level that caused a merge into this group. */
  mergeLevel: string;
}

export interface MergeOutcome {
  readonly group: DuplicateGroup;
  readonly isNewGroup: boolean;
  readonly leaderChanged: boolean;
  readonly previousLeaderId: string | null;
}

export class DuplicateIndex {
  private readonly groups = new Map<string, DuplicateGroup>();
  private readonly keyToGroup = new Map<string, string>();
  private counter = 0;

  /** Adds a result and returns the group it belongs to. */
  add(result: SearchResult, fingerprintInput: FingerprintInput): MergeOutcome {
    const fingerprints = computeFingerprints(fingerprintInput);
    const match = this.findGroup(fingerprints);

    if (!match) {
      this.counter += 1;
      const group: DuplicateGroup = {
        id: `dg_${this.counter}`,
        leaderId: result.id,
        members: [{ result, fingerprints, headSample: fingerprintInput.headSample }],
        mergeLevel: 'none',
      };
      this.groups.set(group.id, group);
      for (const print of fingerprints) this.keyToGroup.set(print.key, group.id);
      return { group, isNewGroup: true, leaderChanged: false, previousLeaderId: null };
    }

    const { group, level } = match;
    group.mergeLevel =
      LEVEL_STRENGTH[level as keyof typeof LEVEL_STRENGTH] >
      (LEVEL_STRENGTH[group.mergeLevel as keyof typeof LEVEL_STRENGTH] ?? 0)
        ? level
        : group.mergeLevel;

    group.members.push({ result, fingerprints, headSample: fingerprintInput.headSample });
    for (const print of fingerprints) {
      if (!this.keyToGroup.has(print.key)) this.keyToGroup.set(print.key, group.id);
    }

    const previousLeaderId = group.leaderId;
    const leader = this.pickLeader(group);
    const leaderChanged = leader !== previousLeaderId;
    group.leaderId = leader;

    return { group, isNewGroup: false, leaderChanged, previousLeaderId };
  }

  groupFor(resultId: string): DuplicateGroup | null {
    for (const group of this.groups.values()) {
      if (group.members.some((member) => member.result.id === resultId)) return group;
    }
    return null;
  }

  all(): readonly DuplicateGroup[] {
    return [...this.groups.values()];
  }

  private findGroup(
    fingerprints: readonly Fingerprint[],
  ): { group: DuplicateGroup; level: string } | null {
    const hits = new Map<string, Fingerprint[]>();

    for (const print of fingerprints) {
      const groupId = this.keyToGroup.get(print.key);
      if (!groupId) continue;
      const existing = hits.get(groupId);
      if (existing) existing.push(print);
      else hits.set(groupId, [print]);
    }

    let best: { group: DuplicateGroup; level: string; strength: number } | null = null;

    for (const [groupId, prints] of hits) {
      const group = this.groups.get(groupId);
      if (!group) continue;

      const authoritative = prints.find((print) => AUTHORITATIVE_LEVELS.has(print.level));
      if (authoritative) {
        if (!best || authoritative.strength > best.strength) {
          best = { group, level: authoritative.level, strength: authoritative.strength };
        }
        continue;
      }

      if (prints.length >= CORROBORATION_REQUIRED) {
        const strongest = prints.reduce((a, b) => (a.strength >= b.strength ? a : b));
        if (!best || strongest.strength > best.strength) {
          best = { group, level: strongest.level, strength: strongest.strength };
        }
      }
    }

    return best ? { group: best.group, level: best.level } : null;
  }

  /** The best member becomes the group leader: quality first, then access. */
  private pickLeader(group: DuplicateGroup): string {
    let leader = group.members[0];
    if (!leader) return group.leaderId;
    for (const member of group.members.slice(1)) {
      if (compareMembers(member.result, leader.result) > 0) leader = member;
    }
    return leader.result.id;
  }
}

function compareMembers(a: SearchResult, b: SearchResult): number {
  const accessDelta = a.ranking.accessCertainty - b.ranking.accessCertainty;
  if (Math.abs(accessDelta) > 0.05) return accessDelta;
  const qualityDelta = a.quality.total - b.quality.total;
  if (Math.abs(qualityDelta) > 0.02) return qualityDelta;
  return a.ranking.total - b.ranking.total;
}

const VARIANT_DIFF_TOLERANCE = 0.02;

/** Describes how a variant differs from the group leader, in plain terms. */
export function describeDifferences(
  leader: SearchResult,
  variant: SearchResult,
): readonly string[] {
  const differences: string[] = [];
  const l = leader.technical;
  const v = variant.technical;

  if (l.format !== v.format)
    differences.push(`${v.format.toUpperCase()} instead of ${l.format.toUpperCase()}`);
  if (l.codec !== v.codec && v.codec !== 'unknown')
    differences.push(`different codec (${v.codec})`);

  const lBitrate = l.bitrate.averageBps ?? l.bitrate.nominalBps;
  const vBitrate = v.bitrate.averageBps ?? v.bitrate.nominalBps;
  if (lBitrate !== null && vBitrate !== null && Math.abs(lBitrate - vBitrate) / lBitrate > 0.05) {
    differences.push(`${Math.round(vBitrate / 1000)} kbps`);
  }

  if (l.sampleRateHz !== null && v.sampleRateHz !== null && l.sampleRateHz !== v.sampleRateHz) {
    differences.push(`${(v.sampleRateHz / 1000).toFixed(1)} kHz`);
  }
  if (l.channels !== null && v.channels !== null && l.channels !== v.channels) {
    differences.push(v.channels === 1 ? 'mono' : `${v.channels} channels`);
  }
  if (
    l.durationSeconds !== null &&
    v.durationSeconds !== null &&
    Math.abs(l.durationSeconds - v.durationSeconds) / Math.max(1, l.durationSeconds) >
      VARIANT_DIFF_TOLERANCE
  ) {
    differences.push('different length');
  }
  if (l.sizeBytes !== null && v.sizeBytes !== null && l.sizeBytes !== v.sizeBytes) {
    differences.push('different file size');
  }
  if (leader.source.providerId !== variant.source.providerId) {
    differences.push(`from ${variant.source.providerDisplayName}`);
  }
  if (v.corruptionSignals.length > l.corruptionSignals.length) {
    differences.push('has integrity warnings');
  }
  if (leader.access.classification !== variant.access.classification) {
    differences.push('different access');
  }

  return differences.length > 0 ? [...new Set(differences)] : ['mirror of the same file'];
}

export function toVariantSummary(
  leader: SearchResult,
  variant: SearchResult,
): ResultVariantSummary {
  return {
    id: variant.id,
    providerId: variant.source.providerId,
    providerDisplayName: variant.source.providerDisplayName,
    format: variant.technical.format,
    bitrateBps: variant.technical.bitrate.averageBps ?? variant.technical.bitrate.nominalBps,
    sizeBytes: variant.technical.sizeBytes,
    durationSeconds: variant.technical.durationSeconds,
    sampleRateHz: variant.technical.sampleRateHz,
    channels: variant.technical.channels,
    accessClassification: variant.access.classification,
    pageUrl: variant.pageUrl,
    differsBy: describeDifferences(leader, variant),
  };
}
