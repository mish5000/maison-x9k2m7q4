import type { DeviceProfile } from '../domain/compat.js';

/**
 * Versioned device profiles.
 *
 * These describe what a device is documented to accept. They are configuration,
 * not logic: the evaluator in `evaluate.ts` contains the only decision code, so
 * updating a device's limits never means editing conditionals.
 *
 * Values are taken from published vendor specifications. Where a vendor does
 * not publish a limit, the field is left permissive and the evaluator returns
 * `unknown` rather than guessing.
 */

export const CDJ_3000_PROFILE: DeviceProfile = Object.freeze({
  id: 'cdj-3000',
  version: '2024.1',
  label: 'Pioneer / AlphaTheta CDJ-3000',
  vendor: 'AlphaTheta',
  reference: 'https://www.pioneerdj.com/en/product/player/cdj-3000/black/specifications/',
  containers: Object.freeze(['mp3', 'aiff', 'wav', 'aac', 'm4a', 'flac', 'alac']),
  codecs: Object.freeze([
    'mp3',
    'pcm_s16le',
    'pcm_s24le',
    'pcm_s16be',
    'pcm_s24be',
    'aac_lc',
    'flac',
    'alac',
  ]),
  sampleRatesHz: Object.freeze([32000, 44100, 48000, 88200, 96000]),
  bitDepths: Object.freeze([16, 24]),
  maxChannels: 2,
  maxBitrateBps: 320_000,
  minBitrateBps: 32_000,
  discouragedContainers: Object.freeze([]),
  notes: Object.freeze([
    'Lossy bitrate limits apply to MP3 and AAC only; lossless formats are limited by sample rate and bit depth.',
    'Ogg Vorbis and Opus are not listed as supported formats.',
  ]),
});

export const CDJ_2000NXS2_PROFILE: DeviceProfile = Object.freeze({
  id: 'cdj-2000nxs2',
  version: '2024.1',
  label: 'Pioneer CDJ-2000NXS2',
  vendor: 'AlphaTheta',
  reference: 'https://www.pioneerdj.com/en/product/player/cdj-2000nxs2/black/specifications/',
  containers: Object.freeze(['mp3', 'aiff', 'wav', 'aac', 'm4a', 'flac', 'alac']),
  codecs: Object.freeze([
    'mp3',
    'pcm_s16le',
    'pcm_s24le',
    'pcm_s16be',
    'pcm_s24be',
    'aac_lc',
    'flac',
    'alac',
  ]),
  sampleRatesHz: Object.freeze([32000, 44100, 48000, 88200, 96000]),
  bitDepths: Object.freeze([16, 24]),
  maxChannels: 2,
  maxBitrateBps: 320_000,
  minBitrateBps: 32_000,
  discouragedContainers: Object.freeze([]),
  notes: Object.freeze(['Ogg Vorbis and Opus are not listed as supported formats.']),
});

/**
 * A conservative profile describing what mainstream browsers play natively.
 * Used to decide whether the in-app preview player can be offered at all.
 */
export const WEB_BROWSER_PROFILE: DeviceProfile = Object.freeze({
  id: 'web-browser',
  version: '2024.1',
  label: 'Web browser playback',
  vendor: 'Generic',
  reference: null,
  containers: Object.freeze(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac']),
  codecs: Object.freeze([
    'mp3',
    'pcm_s16le',
    'pcm_s24le',
    'aac_lc',
    'he_aac',
    'vorbis',
    'opus',
    'flac',
  ]),
  sampleRatesHz: Object.freeze([8000, 11025, 16000, 22050, 32000, 44100, 48000, 88200, 96000]),
  bitDepths: Object.freeze([8, 16, 24, 32]),
  maxChannels: 8,
  maxBitrateBps: null,
  minBitrateBps: null,
  discouragedContainers: Object.freeze(['aiff']),
  notes: Object.freeze([
    'AIFF and ALAC are not reliably supported outside Safari.',
    'FLAC support is widespread but not universal on older browsers.',
  ]),
});

export const DEVICE_PROFILES: readonly DeviceProfile[] = Object.freeze([
  CDJ_3000_PROFILE,
  CDJ_2000NXS2_PROFILE,
  WEB_BROWSER_PROFILE,
]);

/** Profiles surfaced on result cards by default. */
export const DEFAULT_PROFILE_IDS: readonly string[] = Object.freeze(['cdj-3000']);

export function profileById(id: string): DeviceProfile | null {
  return DEVICE_PROFILES.find((profile) => profile.id === id) ?? null;
}
