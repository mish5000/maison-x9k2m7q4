/** Audio container / codec vocabulary understood by Auralis. */

export const AUDIO_FORMATS = [
  'mp3',
  'wav',
  'aiff',
  'flac',
  'aac',
  'm4a',
  'alac',
  'ogg',
  'opus',
  'unknown',
] as const;
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export const PLAYLIST_FORMATS = ['m3u', 'm3u8', 'pls', 'cue', 'rss_enclosure'] as const;
export type PlaylistFormat = (typeof PLAYLIST_FORMATS)[number];

export const AUDIO_CODECS = [
  'mp3',
  'pcm_s16le',
  'pcm_s24le',
  'pcm_s32le',
  'pcm_f32le',
  'pcm_s16be',
  'pcm_s24be',
  'flac',
  'aac_lc',
  'he_aac',
  'alac',
  'vorbis',
  'opus',
  'unknown',
] as const;
export type AudioCodec = (typeof AUDIO_CODECS)[number];

export type BitrateMode = 'cbr' | 'abr' | 'vbr' | 'lossless' | 'unknown';

export type ChannelLayout = 'mono' | 'stereo' | 'multichannel' | 'unknown';

/** How confident we are that a measured value reflects the real file. */
export type Confidence = 'high' | 'medium' | 'low' | 'none';

export interface BitrateInfo {
  /** Nominal bitrate in bits per second, when the container declares one. */
  readonly nominalBps: number | null;
  /** Average bitrate in bits per second (measured, declared, or derived). */
  readonly averageBps: number | null;
  readonly mode: BitrateMode;
  /** True when averageBps was derived from size/duration rather than read from the stream. */
  readonly estimated: boolean;
  readonly confidence: Confidence;
}

export interface LoudnessInfo {
  readonly replayGainTrackDb: number | null;
  readonly replayGainAlbumDb: number | null;
  readonly peakAmplitude: number | null;
}

/** Technical facts about a specific encoded file. All fields may be null. */
export interface MediaTechnicalMetadata {
  readonly format: AudioFormat;
  readonly codec: AudioCodec;
  readonly mimeType: string | null;
  readonly extension: string | null;
  readonly durationSeconds: number | null;
  readonly durationEstimated: boolean;
  readonly sampleRateHz: number | null;
  readonly bitDepth: number | null;
  readonly channels: number | null;
  readonly channelLayout: ChannelLayout;
  readonly bitrate: BitrateInfo;
  readonly sizeBytes: number | null;
  readonly lossless: boolean;
  readonly encoder: string | null;
  readonly loudness: LoudnessInfo;
  /** Structural problems detected while parsing. */
  readonly corruptionSignals: readonly string[];
  /** Overall confidence in this metadata block. */
  readonly confidence: Confidence;
}

export interface MediaTags {
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly albumArtist: string | null;
  readonly trackNumber: number | null;
  readonly year: number | null;
  readonly genre: string | null;
  readonly comment: string | null;
}

export const EMPTY_TAGS: MediaTags = Object.freeze({
  title: null,
  artist: null,
  album: null,
  albumArtist: null,
  trackNumber: null,
  year: null,
  genre: null,
  comment: null,
});

export type VerificationStatus =
  | 'verified_audio'
  | 'probable_audio'
  | 'unverified'
  | 'not_audio'
  | 'verification_failed'
  | 'playlist';

export interface VerificationRecord {
  readonly status: VerificationStatus;
  /** Ordered list of checks performed, e.g. `header:content-type=audio/mpeg`. */
  readonly evidence: readonly string[];
  /** Bytes actually fetched to reach this verdict. Kept small by design. */
  readonly bytesInspected: number;
  readonly checkedAt: string;
  /** Host that ultimately served the bytes, after redirects. */
  readonly finalHost: string | null;
  readonly finalUrl: string | null;
  readonly redirectCount: number;
  readonly declaredMimeType: string | null;
  readonly detectedSignature: string | null;
  /** True when extension, declared MIME and magic bytes agree. */
  readonly signatureAgreement: boolean;
}

export const UNVERIFIED: VerificationRecord = Object.freeze({
  status: 'unverified',
  evidence: Object.freeze([] as const),
  bytesInspected: 0,
  checkedAt: '',
  finalHost: null,
  finalUrl: null,
  redirectCount: 0,
  declaredMimeType: null,
  detectedSignature: null,
  signatureAgreement: false,
});

export const EMPTY_TECHNICAL: MediaTechnicalMetadata = Object.freeze({
  format: 'unknown',
  codec: 'unknown',
  mimeType: null,
  extension: null,
  durationSeconds: null,
  durationEstimated: false,
  sampleRateHz: null,
  bitDepth: null,
  channels: null,
  channelLayout: 'unknown',
  bitrate: Object.freeze({
    nominalBps: null,
    averageBps: null,
    mode: 'unknown',
    estimated: false,
    confidence: 'none',
  }),
  sizeBytes: null,
  lossless: false,
  encoder: null,
  loudness: Object.freeze({
    replayGainTrackDb: null,
    replayGainAlbumDb: null,
    peakAmplitude: null,
  }),
  corruptionSignals: Object.freeze([] as const),
  confidence: 'none',
});

export const LOSSLESS_FORMATS: ReadonlySet<AudioFormat> = new Set(['wav', 'aiff', 'flac', 'alac']);
