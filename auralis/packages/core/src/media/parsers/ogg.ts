import { ByteReader } from '../bytes.js';
import { asciiSlice } from '../signatures.js';
import { parseVorbisComments, type VorbisComments } from './flac.js';

/**
 * Ogg container parsing for Vorbis and Opus streams.
 *
 * Duration comes from the granule position of the final page, which lives at
 * the end of the file — so callers pass the tail bytes separately rather than
 * downloading the whole stream.
 */

export interface OggPage {
  readonly offset: number;
  readonly headerLength: number;
  readonly payloadLength: number;
  readonly granulePosition: number | null;
  readonly serialNumber: number;
  readonly sequence: number;
  readonly isLastPage: boolean;
}

const MAX_PAGES = 64;

export function readOggPage(bytes: Uint8Array, offset: number): OggPage | null {
  const reader = new ByteReader(bytes);
  if (reader.ascii(offset, 4) !== 'OggS') return null;
  const version = reader.u8(offset + 4);
  if (version !== 0) return null;

  const headerType = reader.u8(offset + 5) ?? 0;
  const granulePosition = reader.u64le(offset + 6);
  const serialNumber = reader.u32le(offset + 14) ?? 0;
  const sequence = reader.u32le(offset + 18) ?? 0;
  const segmentCount = reader.u8(offset + 26);
  if (segmentCount === null) return null;

  const segmentTable = reader.slice(offset + 27, segmentCount);
  if (!segmentTable) return null;
  let payloadLength = 0;
  for (const segment of segmentTable) payloadLength += segment;

  return {
    offset,
    headerLength: 27 + segmentCount,
    payloadLength,
    granulePosition,
    serialNumber,
    sequence,
    isLastPage: (headerType & 0x04) !== 0,
  };
}

export interface OggAnalysis {
  readonly codec: 'vorbis' | 'opus' | 'flac' | 'unknown';
  readonly channels: number | null;
  readonly sampleRateHz: number | null;
  readonly nominalBitrateBps: number | null;
  readonly maxBitrateBps: number | null;
  readonly minBitrateBps: number | null;
  readonly comments: VorbisComments | null;
  readonly serialNumber: number | null;
  /** Opus pre-skip, needed for an exact duration. */
  readonly preSkipSamples: number;
  readonly corruptionSignals: readonly string[];
}

export function parseOgg(head: Uint8Array): OggAnalysis {
  const corruption: string[] = [];
  let codec: OggAnalysis['codec'] = 'unknown';
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let nominalBitrate: number | null = null;
  let maxBitrate: number | null = null;
  let minBitrate: number | null = null;
  let comments: VorbisComments | null = null;
  let serialNumber: number | null = null;
  let preSkip = 0;

  let offset = 0;
  let pages = 0;

  while (pages < MAX_PAGES) {
    const page = readOggPage(head, offset);
    if (!page) {
      if (pages === 0) corruption.push('ogg:no-valid-page-at-start');
      break;
    }
    if (serialNumber === null) serialNumber = page.serialNumber;

    const payloadStart = page.offset + page.headerLength;
    const payload = head.subarray(payloadStart, payloadStart + page.payloadLength);
    const reader = new ByteReader(payload);

    if (asciiSlice(payload, 0, 8) === 'OpusHead') {
      codec = 'opus';
      channels = reader.u8(9) ?? null;
      preSkip = reader.u16le(10) ?? 0;
      // Opus always decodes at 48 kHz regardless of the original input rate.
      sampleRate = 48000;
    } else if (asciiSlice(payload, 0, 8) === 'OpusTags') {
      comments = parseVorbisComments(payload.subarray(8));
    } else if (payload[0] === 0x01 && asciiSlice(payload, 1, 6) === 'vorbis') {
      codec = 'vorbis';
      channels = reader.u8(11) ?? null;
      sampleRate = reader.u32le(12) ?? null;
      maxBitrate = normaliseBitrate(reader.u32le(16));
      nominalBitrate = normaliseBitrate(reader.u32le(20));
      minBitrate = normaliseBitrate(reader.u32le(24));
    } else if (payload[0] === 0x03 && asciiSlice(payload, 1, 6) === 'vorbis') {
      comments = parseVorbisComments(payload.subarray(7));
    } else if (asciiSlice(payload, 0, 5) === 'FLAC' || asciiSlice(payload, 1, 4) === 'FLAC') {
      codec = 'flac';
    }

    offset = payloadStart + page.payloadLength;
    pages += 1;
    if (offset >= head.length) break;
    if (comments !== null && codec !== 'unknown') break;
  }

  if (codec === 'unknown') corruption.push('ogg:unrecognised-codec');

  return {
    codec,
    channels,
    sampleRateHz: sampleRate,
    nominalBitrateBps: nominalBitrate,
    maxBitrateBps: maxBitrate,
    minBitrateBps: minBitrate,
    comments,
    serialNumber,
    preSkipSamples: preSkip,
    corruptionSignals: corruption,
  };
}

function normaliseBitrate(value: number | null): number | null {
  if (value === null || value === 0) return null;
  // Vorbis writes 0 or 0xFFFFFFFF (as a signed -1) when a bound is unset.
  if (value >= 0xffffffff) return null;
  return value;
}

/**
 * Finds the granule position of the last complete Ogg page in `tail`, which is
 * the total decoded sample count for the stream.
 */
export function finalGranulePosition(tail: Uint8Array, serialNumber: number | null): number | null {
  let best: number | null = null;
  for (let i = tail.length - 27; i >= 0; i -= 1) {
    if (tail[i] !== 0x4f || tail[i + 1] !== 0x67 || tail[i + 2] !== 0x67 || tail[i + 3] !== 0x53) {
      continue;
    }
    const page = readOggPage(tail, i);
    if (!page) continue;
    if (serialNumber !== null && page.serialNumber !== serialNumber) continue;
    if (page.granulePosition !== null && page.granulePosition > 0) {
      best = page.granulePosition;
      break;
    }
  }
  return best;
}

export function oggDurationSeconds(analysis: OggAnalysis, tail: Uint8Array): number | null {
  const granule = finalGranulePosition(tail, analysis.serialNumber);
  if (granule === null) return null;
  if (analysis.codec === 'opus') {
    return Math.max(0, (granule - analysis.preSkipSamples) / 48000);
  }
  if (analysis.sampleRateHz && analysis.sampleRateHz > 0) {
    return granule / analysis.sampleRateHz;
  }
  return null;
}
