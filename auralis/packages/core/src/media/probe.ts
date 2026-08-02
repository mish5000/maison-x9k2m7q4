import {
  EMPTY_TAGS,
  EMPTY_TECHNICAL,
  LOSSLESS_FORMATS,
  type AudioCodec,
  type AudioFormat,
  type BitrateInfo,
  type ChannelLayout,
  type Confidence,
  type MediaTags,
  type MediaTechnicalMetadata,
  type VerificationStatus,
} from '../domain/media.js';
import { cleanTagString, parseIntOrNull } from './bytes.js';
import { parseFlac, vorbisTagView } from './parsers/flac.js';
import { parseId3v1, parseId3v2 } from './parsers/id3.js';
import { analyseMp3, hasTrailingTag } from './parsers/mp3.js';
import { parseMp4 } from './parsers/mp4.js';
import { oggDurationSeconds, parseOgg } from './parsers/ogg.js';
import { parseAiff, parseWave } from './parsers/riff.js';
import {
  detectAudioSignature,
  detectNonAudio,
  extensionFromPath,
  extensionMatchesFormat,
  canonicalMimeFor,
  indexOfAscii,
  mimeMatchesFormat,
  type NonAudioMatch,
  type SignatureMatch,
} from './signatures.js';

/**
 * Turns a bounded byte sample into technical metadata.
 *
 * The probe never needs the whole file: a head sample plus (optionally) a tail
 * sample is enough for every format Auralis supports. Everything here is pure
 * and synchronous so it can run inside an isolated worker.
 */

export interface ProbeInput {
  /** First bytes of the file. 64 KiB is enough for every supported container. */
  readonly head: Uint8Array;
  /** Final bytes, when a range request for the tail succeeded. */
  readonly tail?: Uint8Array | null;
  readonly totalSizeBytes?: number | null;
  readonly declaredMimeType?: string | null;
  /** Path or filename, used only to compare the claimed extension. */
  readonly filenameOrPath?: string | null;
}

export interface ProbeResult {
  readonly signature: SignatureMatch | null;
  readonly nonAudio: NonAudioMatch | null;
  readonly technical: MediaTechnicalMetadata;
  readonly tags: MediaTags;
  readonly status: VerificationStatus;
  readonly evidence: readonly string[];
  readonly signatureAgreement: boolean;
}

export function probeMedia(input: ProbeInput): ProbeResult {
  const { head } = input;
  const evidence: string[] = [];
  const extension = input.filenameOrPath ? extensionFromPath(input.filenameOrPath) : null;
  const declaredMime = normaliseMime(input.declaredMimeType);

  if (extension) evidence.push(`extension:${extension}`);
  if (declaredMime) evidence.push(`header:content-type=${declaredMime}`);

  if (head.length === 0) {
    return {
      signature: null,
      nonAudio: null,
      technical: { ...EMPTY_TECHNICAL, extension, mimeType: declaredMime },
      tags: EMPTY_TAGS,
      status: 'verification_failed',
      evidence: [...evidence, 'probe:no-bytes-returned'],
      signatureAgreement: false,
    };
  }

  const nonAudio = detectNonAudio(head);
  if (nonAudio) {
    return {
      signature: null,
      nonAudio,
      technical: { ...EMPTY_TECHNICAL, extension, mimeType: declaredMime },
      tags: EMPTY_TAGS,
      status: 'not_audio',
      evidence: [...evidence, `signature:${nonAudio.signature}`, `rejected:${nonAudio.reason}`],
      signatureAgreement: false,
    };
  }

  const signature = detectAudioSignature(head);
  if (!signature) {
    return {
      signature: null,
      nonAudio: null,
      technical: { ...EMPTY_TECHNICAL, extension, mimeType: declaredMime },
      tags: EMPTY_TAGS,
      status: 'unverified',
      evidence: [...evidence, 'signature:none-recognised'],
      signatureAgreement: false,
    };
  }

  evidence.push(`signature:${signature.signature}`);

  const parsed = parseByFormat(signature, input);
  const extensionAgrees = extensionMatchesFormat(extension, parsed.technical.format);
  const mimeAgrees = mimeMatchesFormat(declaredMime, parsed.technical.format);

  if (extension && !extensionAgrees) evidence.push('mismatch:extension-vs-signature');
  if (declaredMime && !mimeAgrees) evidence.push('mismatch:declared-mime-vs-signature');
  if (extensionAgrees) evidence.push('agreement:extension-matches-signature');
  if (mimeAgrees) evidence.push('agreement:mime-matches-signature');

  // Agreement is only claimed where a claim actually exists to compare against.
  const comparableClaims = (extension ? 1 : 0) + (declaredMime ? 1 : 0);
  const agreeingClaims = (extensionAgrees ? 1 : 0) + (mimeAgrees ? 1 : 0);
  const signatureAgreement = comparableClaims > 0 && agreeingClaims === comparableClaims;

  const status: VerificationStatus = signature.strong
    ? parsed.technical.corruptionSignals.length > 0
      ? 'probable_audio'
      : 'verified_audio'
    : 'probable_audio';

  return {
    signature,
    nonAudio: null,
    technical: {
      ...parsed.technical,
      extension,
      mimeType: declaredMime ?? canonicalMimeFor(parsed.technical.format),
    },
    tags: parsed.tags,
    status,
    evidence: [...evidence, ...parsed.evidence],
    signatureAgreement,
  };
}

interface FormatParseResult {
  readonly technical: MediaTechnicalMetadata;
  readonly tags: MediaTags;
  readonly evidence: readonly string[];
}

function parseByFormat(signature: SignatureMatch, input: ProbeInput): FormatParseResult {
  switch (signature.format) {
    case 'mp3':
      return parseMp3Format(input);
    case 'flac':
      return parseFlacFormat(input);
    case 'wav':
      return parseWavFormat(input);
    case 'aiff':
      return parseAiffFormat(input);
    case 'm4a':
    case 'alac':
    case 'aac':
      return parseMp4Format(input, signature);
    case 'ogg':
    case 'opus':
      return parseOggFormat(input);
    default:
      return {
        technical: { ...EMPTY_TECHNICAL, format: signature.format },
        tags: EMPTY_TAGS,
        evidence: ['parser:none-for-format'],
      };
  }
}

function parseMp3Format(input: ProbeInput): FormatParseResult {
  const analysis = analyseMp3(input.head);
  const id3v2 = parseId3v2(input.head);
  const id3v1 = input.tail ? parseId3v1(input.tail) : null;
  const evidence: string[] = [];

  if (!analysis) {
    return {
      technical: { ...EMPTY_TECHNICAL, format: 'mp3', codec: 'mp3', confidence: 'low' },
      tags: id3v2.tags,
      evidence: ['mp3:no-parsable-frame'],
    };
  }

  const frame = analysis.firstFrame;
  const xing = analysis.xing;
  evidence.push(`mp3:mpeg${frame.mpegVersion}-layer${frame.layer}`);
  if (xing) evidence.push(`mp3:${xing.kind.toLowerCase()}-header`);

  const totalSize = input.totalSizeBytes ?? null;
  const audioBytes =
    xing?.byteCount ??
    (totalSize !== null ? Math.max(0, totalSize - analysis.audioStartOffset) : null);

  let durationSeconds: number | null = null;
  let durationEstimated = false;

  if (xing?.frameCount && xing.frameCount > 0) {
    durationSeconds = (xing.frameCount * frame.samplesPerFrame) / frame.sampleRateHz;
    evidence.push('mp3:duration-from-frame-count');
  } else if (audioBytes !== null && frame.bitrateBps) {
    durationSeconds = (audioBytes * 8) / frame.bitrateBps;
    durationEstimated = true;
    evidence.push('mp3:duration-estimated-from-size');
  }

  const distinctBitrates = analysis.observedBitratesBps.length;
  const isVbr = xing?.indicatesVbr === true || distinctBitrates > 1;
  const mode = isVbr
    ? 'vbr'
    : xing?.kind === 'Info'
      ? 'cbr'
      : distinctBitrates === 1
        ? 'cbr'
        : 'unknown';

  let averageBps: number | null = null;
  let estimated = false;
  let confidence: Confidence = 'low';

  if (audioBytes !== null && durationSeconds && durationSeconds > 0) {
    averageBps = Math.round((audioBytes * 8) / durationSeconds);
    estimated = durationEstimated || xing?.byteCount === undefined;
    confidence = xing?.frameCount ? 'high' : 'medium';
  } else if (!isVbr && frame.bitrateBps) {
    averageBps = frame.bitrateBps;
    estimated = false;
    // One frame header is a reading, not a measurement. High confidence needs
    // several consecutive frames to agree.
    confidence = analysis.framesScanned >= 4 ? 'high' : 'low';
  }

  const corruption = [...analysis.corruptionSignals];
  if (input.tail && hasTrailingTag(input.tail)) evidence.push('mp3:trailing-tag-present');
  if (analysis.framesScanned === 0) corruption.push('mp3:no-complete-frames');

  const bitrate: BitrateInfo = {
    nominalBps: isVbr ? null : frame.bitrateBps,
    averageBps,
    mode,
    estimated,
    confidence: averageBps === null ? 'none' : confidence,
  };

  const tags = mergeTags(id3v2.tags, id3v1);

  return {
    technical: {
      ...EMPTY_TECHNICAL,
      format: 'mp3',
      codec: 'mp3',
      durationSeconds,
      durationEstimated,
      sampleRateHz: frame.sampleRateHz,
      bitDepth: null,
      channels: frame.channels,
      channelLayout: channelLayoutFor(frame.channels),
      bitrate,
      sizeBytes: totalSize,
      lossless: false,
      encoder: xing?.encoder ?? id3v2.encoder,
      loudness: {
        replayGainTrackDb: id3v2.replayGainTrackDb,
        replayGainAlbumDb: id3v2.replayGainAlbumDb,
        peakAmplitude: null,
      },
      corruptionSignals: corruption,
      confidence: analysis.framesScanned > 4 ? 'high' : 'medium',
    },
    tags,
    evidence,
  };
}

function parseFlacFormat(input: ProbeInput): FormatParseResult {
  const analysis = parseFlac(input.head);
  const info = analysis.streamInfo;
  const view = vorbisTagView(analysis.comments);
  const evidence: string[] = ['flac:streaminfo-parsed'];

  if (!info) {
    return {
      technical: {
        ...EMPTY_TECHNICAL,
        format: 'flac',
        codec: 'flac',
        lossless: true,
        corruptionSignals: analysis.corruptionSignals,
        confidence: 'low',
      },
      tags: EMPTY_TAGS,
      evidence: ['flac:streaminfo-missing'],
    };
  }

  const durationSeconds =
    info.totalSamples !== null && info.sampleRateHz > 0
      ? info.totalSamples / info.sampleRateHz
      : null;
  const totalSize = input.totalSizeBytes ?? null;
  const averageBps =
    durationSeconds && durationSeconds > 0 && totalSize
      ? Math.round((totalSize * 8) / durationSeconds)
      : null;

  if (durationSeconds !== null) evidence.push('flac:duration-from-total-samples');
  if (info.md5) evidence.push('flac:audio-md5-present');

  return {
    technical: {
      ...EMPTY_TECHNICAL,
      format: 'flac',
      codec: 'flac',
      durationSeconds,
      durationEstimated: false,
      sampleRateHz: info.sampleRateHz,
      bitDepth: info.bitDepth,
      channels: info.channels,
      channelLayout: channelLayoutFor(info.channels),
      bitrate: {
        nominalBps: null,
        averageBps,
        mode: 'lossless',
        estimated: averageBps !== null,
        confidence: averageBps === null ? 'none' : 'high',
      },
      sizeBytes: totalSize,
      lossless: true,
      encoder: view.encoder,
      loudness: {
        replayGainTrackDb: view.replayGainTrackDb,
        replayGainAlbumDb: view.replayGainAlbumDb,
        peakAmplitude: view.peakAmplitude,
      },
      corruptionSignals: analysis.corruptionSignals,
      confidence: 'high',
    },
    tags: tagsFromView(view),
    evidence,
  };
}

function parseWavFormat(input: ProbeInput): FormatParseResult {
  const wave = parseWave(input.head);
  if (!wave) {
    return {
      technical: { ...EMPTY_TECHNICAL, format: 'wav', lossless: true, confidence: 'low' },
      tags: EMPTY_TAGS,
      evidence: ['wav:header-unparsable'],
    };
  }

  const evidence = ['wav:fmt-chunk-parsed'];
  const totalSize = input.totalSizeBytes ?? null;
  // `data` may declare a size larger than the file; trust the smaller of the two.
  const effectiveDataSize =
    wave.dataSizeBytes !== null && totalSize !== null
      ? Math.min(wave.dataSizeBytes, totalSize)
      : (wave.dataSizeBytes ?? null);

  const durationSeconds =
    effectiveDataSize !== null && wave.byteRate > 0 ? effectiveDataSize / wave.byteRate : null;
  if (durationSeconds !== null) evidence.push('wav:duration-from-data-chunk');

  const corruption = [...wave.corruptionSignals];
  if (wave.dataSizeBytes !== null && totalSize !== null && wave.dataSizeBytes > totalSize) {
    corruption.push('wav:data-chunk-larger-than-file');
  }

  const bitrateBps = wave.byteRate > 0 ? wave.byteRate * 8 : null;

  return {
    technical: {
      ...EMPTY_TECHNICAL,
      format: 'wav',
      codec: wave.codec,
      durationSeconds,
      durationEstimated: false,
      sampleRateHz: wave.sampleRateHz,
      bitDepth: wave.bitDepth || null,
      channels: wave.channels,
      channelLayout: channelLayoutFor(wave.channels),
      bitrate: {
        nominalBps: bitrateBps,
        averageBps: bitrateBps,
        mode: 'lossless',
        estimated: false,
        confidence: bitrateBps === null ? 'none' : 'high',
      },
      sizeBytes: totalSize,
      lossless: true,
      encoder: wave.tags.get('encoder') ?? null,
      loudness: EMPTY_TECHNICAL.loudness,
      corruptionSignals: corruption,
      confidence: 'high',
    },
    tags: {
      ...EMPTY_TAGS,
      title: cleanTagString(wave.tags.get('title')),
      artist: cleanTagString(wave.tags.get('artist')),
      album: cleanTagString(wave.tags.get('album')),
      comment: cleanTagString(wave.tags.get('comment')),
      genre: cleanTagString(wave.tags.get('genre')),
      year: parseIntOrNull(wave.tags.get('date')),
      trackNumber: parseIntOrNull(wave.tags.get('tracknumber')),
    },
    evidence,
  };
}

function parseAiffFormat(input: ProbeInput): FormatParseResult {
  const aiff = parseAiff(input.head);
  if (!aiff) {
    return {
      technical: { ...EMPTY_TECHNICAL, format: 'aiff', lossless: true, confidence: 'low' },
      tags: EMPTY_TAGS,
      evidence: ['aiff:header-unparsable'],
    };
  }

  const durationSeconds =
    aiff.sampleRateHz > 0 && aiff.numSampleFrames > 0
      ? aiff.numSampleFrames / aiff.sampleRateHz
      : null;
  const bitrateBps =
    aiff.sampleRateHz > 0 && aiff.bitDepth > 0 && aiff.channels > 0
      ? aiff.sampleRateHz * aiff.bitDepth * aiff.channels
      : null;
  const compressed =
    aiff.compressionType !== null &&
    aiff.compressionType !== 'NONE' &&
    aiff.compressionType !== 'sowt';

  return {
    technical: {
      ...EMPTY_TECHNICAL,
      format: 'aiff',
      codec: aiff.codec,
      durationSeconds,
      durationEstimated: false,
      sampleRateHz: aiff.sampleRateHz || null,
      bitDepth: aiff.bitDepth || null,
      channels: aiff.channels || null,
      channelLayout: channelLayoutFor(aiff.channels),
      bitrate: {
        nominalBps: compressed ? null : bitrateBps,
        averageBps: compressed ? null : bitrateBps,
        mode: compressed ? 'unknown' : 'lossless',
        estimated: false,
        confidence: bitrateBps === null || compressed ? 'none' : 'high',
      },
      sizeBytes: input.totalSizeBytes ?? null,
      lossless: !compressed || aiff.codec === 'alac',
      encoder: null,
      loudness: EMPTY_TECHNICAL.loudness,
      corruptionSignals: aiff.corruptionSignals,
      confidence: 'high',
    },
    tags: {
      ...EMPTY_TAGS,
      title: cleanTagString(aiff.tags.get('title')),
      artist: cleanTagString(aiff.tags.get('artist')),
      comment: cleanTagString(aiff.tags.get('comment')),
    },
    evidence: ['aiff:comm-chunk-parsed'],
  };
}

function parseMp4Format(input: ProbeInput, signature: SignatureMatch): FormatParseResult {
  const totalSize = input.totalSizeBytes ?? null;
  const evidence: string[] = ['mp4:box-tree-walked'];

  let mp4 = parseMp4(input.head, totalSize);
  if (!mp4.moovFound && input.tail && input.tail.length > 0) {
    // Streaming-unfriendly files put `moov` at the end. Locate it in the tail
    // sample and walk from its box header rather than concatenating buffers,
    // which would leave every offset inside the tail wrong.
    const marker = indexOfAscii(input.tail, 'moov');
    if (marker >= 4) {
      const fromTail = parseMp4(input.tail.subarray(marker - 4), totalSize);
      if (fromTail.moovFound) {
        mp4 = { ...fromTail, brand: mp4.brand, moovAtEnd: true };
        evidence.push('mp4:moov-recovered-from-tail');
      }
    }
  }
  if (mp4.moovAtEnd) evidence.push('mp4:moov-at-end-of-file');

  const format: AudioFormat =
    mp4.codec === 'alac' ? 'alac' : signature.format === 'aac' ? 'aac' : 'm4a';
  const lossless = mp4.codec === 'alac' || mp4.codec.startsWith('pcm_');

  const averageBps =
    mp4.averageBitrateBps ??
    (mp4.durationSeconds && mp4.durationSeconds > 0 && totalSize
      ? Math.round((totalSize * 8) / mp4.durationSeconds)
      : null);
  const estimated = mp4.averageBitrateBps === null && averageBps !== null;
  if (estimated) evidence.push('mp4:bitrate-estimated-from-size');

  const tagsMap = mp4.tags;

  return {
    technical: {
      ...EMPTY_TECHNICAL,
      format,
      codec: mp4.codec,
      durationSeconds: mp4.durationSeconds,
      durationEstimated: false,
      sampleRateHz: mp4.sampleRateHz,
      bitDepth: lossless ? mp4.bitDepth : null,
      channels: mp4.channels,
      channelLayout: channelLayoutFor(mp4.channels ?? 0),
      bitrate: {
        nominalBps: mp4.maxBitrateBps,
        averageBps,
        mode: lossless ? 'lossless' : averageBps === null ? 'unknown' : 'abr',
        estimated,
        confidence: averageBps === null ? 'none' : estimated ? 'medium' : 'high',
      },
      sizeBytes: totalSize,
      lossless,
      encoder: tagsMap.get('encoder') ?? null,
      loudness: EMPTY_TECHNICAL.loudness,
      corruptionSignals: mp4.corruptionSignals,
      confidence: mp4.moovFound ? 'high' : 'low',
    },
    tags: {
      ...EMPTY_TAGS,
      title: cleanTagString(tagsMap.get('title')),
      artist: cleanTagString(tagsMap.get('artist')),
      album: cleanTagString(tagsMap.get('album')),
      albumArtist: cleanTagString(tagsMap.get('albumartist')),
      genre: cleanTagString(tagsMap.get('genre')),
      comment: cleanTagString(tagsMap.get('comment')),
      year: parseIntOrNull(tagsMap.get('date')),
      trackNumber: parseIntOrNull(tagsMap.get('tracknumber')),
    },
    evidence,
  };
}

function parseOggFormat(input: ProbeInput): FormatParseResult {
  const ogg = parseOgg(input.head);
  const view = vorbisTagView(ogg.comments);
  const evidence: string[] = [`ogg:codec-${ogg.codec}`];

  const durationSeconds = input.tail ? oggDurationSeconds(ogg, input.tail) : null;
  if (durationSeconds !== null) evidence.push('ogg:duration-from-final-granule');

  const totalSize = input.totalSizeBytes ?? null;
  const derivedBps =
    durationSeconds && durationSeconds > 0 && totalSize
      ? Math.round((totalSize * 8) / durationSeconds)
      : null;

  const format: AudioFormat = ogg.codec === 'opus' ? 'opus' : ogg.codec === 'flac' ? 'flac' : 'ogg';
  const codec: AudioCodec = ogg.codec === 'unknown' ? 'unknown' : ogg.codec;

  return {
    technical: {
      ...EMPTY_TECHNICAL,
      format,
      codec,
      durationSeconds,
      durationEstimated: false,
      sampleRateHz: ogg.sampleRateHz,
      bitDepth: null,
      channels: ogg.channels,
      channelLayout: channelLayoutFor(ogg.channels ?? 0),
      bitrate: {
        nominalBps: ogg.nominalBitrateBps,
        averageBps: derivedBps ?? ogg.nominalBitrateBps,
        mode:
          ogg.codec === 'flac'
            ? 'lossless'
            : ogg.minBitrateBps === ogg.maxBitrateBps && ogg.minBitrateBps !== null
              ? 'cbr'
              : 'vbr',
        estimated: derivedBps !== null && ogg.nominalBitrateBps === null,
        confidence:
          derivedBps !== null ? 'high' : ogg.nominalBitrateBps !== null ? 'medium' : 'none',
      },
      sizeBytes: totalSize,
      lossless: ogg.codec === 'flac',
      encoder: view.encoder,
      loudness: {
        replayGainTrackDb: view.replayGainTrackDb,
        replayGainAlbumDb: view.replayGainAlbumDb,
        peakAmplitude: view.peakAmplitude,
      },
      corruptionSignals: ogg.corruptionSignals,
      confidence: ogg.codec === 'unknown' ? 'low' : 'high',
    },
    tags: tagsFromView(view),
    evidence,
  };
}

function tagsFromView(view: ReturnType<typeof vorbisTagView>): MediaTags {
  return {
    title: view.title,
    artist: view.artist,
    album: view.album,
    albumArtist: view.albumArtist,
    trackNumber: view.trackNumber,
    year: view.year,
    genre: view.genre,
    comment: view.comment,
  };
}

function mergeTags(primary: MediaTags, fallback: MediaTags | null): MediaTags {
  if (!fallback) return primary;
  return {
    title: primary.title ?? fallback.title,
    artist: primary.artist ?? fallback.artist,
    album: primary.album ?? fallback.album,
    albumArtist: primary.albumArtist ?? fallback.albumArtist,
    trackNumber: primary.trackNumber ?? fallback.trackNumber,
    year: primary.year ?? fallback.year,
    genre: primary.genre ?? fallback.genre,
    comment: primary.comment ?? fallback.comment,
  };
}

export function channelLayoutFor(channels: number): ChannelLayout {
  if (channels === 1) return 'mono';
  if (channels === 2) return 'stereo';
  if (channels > 2) return 'multichannel';
  return 'unknown';
}

function normaliseMime(value: string | null | undefined): string | null {
  if (!value) return null;
  const bare = value.split(';')[0]?.trim().toLowerCase();
  return bare && bare.length > 0 ? bare : null;
}

export function isLosslessFormat(format: AudioFormat): boolean {
  return LOSSLESS_FORMATS.has(format);
}
