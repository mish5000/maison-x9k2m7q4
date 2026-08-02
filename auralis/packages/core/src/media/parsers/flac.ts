import {
  ByteReader,
  cleanTagString,
  decodeText,
  parseFloatOrNull,
  parseIntOrNull,
} from '../bytes.js';

/** FLAC STREAMINFO and VORBIS_COMMENT parsing. */

export interface FlacStreamInfo {
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly bitDepth: number;
  readonly totalSamples: number | null;
  readonly minBlockSize: number;
  readonly maxBlockSize: number;
  readonly md5: string | null;
}

export interface VorbisComments {
  readonly vendor: string | null;
  readonly fields: ReadonlyMap<string, string>;
}

export interface FlacAnalysis {
  readonly streamInfo: FlacStreamInfo | null;
  readonly comments: VorbisComments | null;
  readonly corruptionSignals: readonly string[];
  /** Byte offset of the first audio frame, when the metadata block list ended. */
  readonly audioStartOffset: number | null;
}

const MAX_METADATA_BLOCKS = 64;
const MAX_COMMENT_BYTES = 256 * 1024;
const MAX_COMMENT_FIELDS = 128;

export function parseFlac(bytes: Uint8Array): FlacAnalysis {
  const reader = new ByteReader(bytes);
  const corruption: string[] = [];

  if (reader.ascii(0, 4) !== 'fLaC') {
    return {
      streamInfo: null,
      comments: null,
      corruptionSignals: ['flac:missing-magic'],
      audioStartOffset: null,
    };
  }

  let offset = 4;
  let streamInfo: FlacStreamInfo | null = null;
  let comments: VorbisComments | null = null;
  let blocks = 0;
  let audioStartOffset: number | null = null;

  while (blocks < MAX_METADATA_BLOCKS) {
    const header = reader.u8(offset);
    if (header === null) break;
    const isLast = (header & 0x80) !== 0;
    const blockType = header & 0x7f;
    const lengthBytes = reader.slice(offset + 1, 3);
    if (!lengthBytes) break;
    const length =
      ((lengthBytes[0] ?? 0) << 16) | ((lengthBytes[1] ?? 0) << 8) | (lengthBytes[2] ?? 0);
    const payloadStart = offset + 4;

    if (blockType === 0 && streamInfo === null) {
      streamInfo = parseStreamInfo(reader, payloadStart);
      if (!streamInfo) corruption.push('flac:streaminfo-truncated');
    } else if (blockType === 4 && comments === null) {
      const payload = reader.slice(payloadStart, Math.min(length, MAX_COMMENT_BYTES));
      if (payload) comments = parseVorbisComments(payload);
    } else if (blockType === 127) {
      corruption.push('flac:invalid-block-type');
      break;
    }

    offset = payloadStart + length;
    blocks += 1;
    if (isLast) {
      audioStartOffset = offset;
      break;
    }
    if (offset > bytes.length) {
      // Metadata claims to extend past what we fetched; not an error by itself.
      break;
    }
  }

  if (blocks >= MAX_METADATA_BLOCKS) corruption.push('flac:excessive-metadata-blocks');

  return { streamInfo, comments, corruptionSignals: corruption, audioStartOffset };
}

function parseStreamInfo(reader: ByteReader, offset: number): FlacStreamInfo | null {
  if (!reader.has(offset, 34)) return null;
  const minBlockSize = reader.u16be(offset) ?? 0;
  const maxBlockSize = reader.u16be(offset + 2) ?? 0;

  // Bit layout from offset+10: 20 bits sample rate, 3 bits channels-1,
  // 5 bits bits-per-sample-1, 36 bits total samples.
  const bitBase = (offset + 10) * 8;
  const sampleRate = reader.bits(bitBase, 20);
  const channelsMinusOne = reader.bits(bitBase + 20, 3);
  const bitsMinusOne = reader.bits(bitBase + 23, 5);
  const totalHigh = reader.bits(bitBase + 28, 4);
  const totalLow = reader.bits(bitBase + 32, 32);

  if (sampleRate === null || channelsMinusOne === null || bitsMinusOne === null) return null;

  const totalSamples =
    totalHigh !== null && totalLow !== null ? totalHigh * 2 ** 32 + totalLow : null;

  const md5Bytes = reader.slice(offset + 18, 16);
  const md5 =
    md5Bytes && md5Bytes.some((b) => b !== 0)
      ? [...md5Bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
      : null;

  return {
    sampleRateHz: sampleRate,
    channels: channelsMinusOne + 1,
    bitDepth: bitsMinusOne + 1,
    totalSamples: totalSamples !== null && totalSamples > 0 ? totalSamples : null,
    minBlockSize,
    maxBlockSize,
    md5,
  };
}

/** Parses a Vorbis comment payload (also used by Ogg Vorbis and Opus). */
export function parseVorbisComments(payload: Uint8Array): VorbisComments {
  const reader = new ByteReader(payload);
  const vendorLength = reader.u32le(0) ?? 0;
  const vendorBytes = reader.slice(4, Math.min(vendorLength, 1024));
  const vendor = vendorBytes ? cleanTagString(decodeText(vendorBytes, 'utf8')) : null;

  const fields = new Map<string, string>();
  let offset = 4 + vendorLength;
  const count = reader.u32le(offset) ?? 0;
  offset += 4;

  const limit = Math.min(count, MAX_COMMENT_FIELDS);
  for (let i = 0; i < limit; i += 1) {
    const length = reader.u32le(offset);
    if (length === null || length > MAX_COMMENT_BYTES) break;
    const entry = reader.slice(offset + 4, length);
    if (!entry) break;
    const text = decodeText(entry, 'utf8');
    const equals = text.indexOf('=');
    if (equals > 0) {
      const key = text.slice(0, equals).trim().toLowerCase();
      const value = cleanTagString(text.slice(equals + 1));
      if (key.length > 0 && value && !fields.has(key)) fields.set(key, value);
    }
    offset += 4 + length;
  }

  return { vendor, fields };
}

export interface VorbisTagView {
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly albumArtist: string | null;
  readonly trackNumber: number | null;
  readonly year: number | null;
  readonly genre: string | null;
  readonly comment: string | null;
  readonly replayGainTrackDb: number | null;
  readonly replayGainAlbumDb: number | null;
  readonly peakAmplitude: number | null;
  readonly encoder: string | null;
}

export function vorbisTagView(comments: VorbisComments | null): VorbisTagView {
  const get = (key: string): string | null => comments?.fields.get(key) ?? null;
  const gain = (key: string): number | null => {
    const raw = get(key);
    if (!raw) return null;
    const match = /(-?\d+(?:\.\d+)?)/.exec(raw);
    return match?.[1] ? Number(match[1]) : null;
  };

  return {
    title: get('title'),
    artist: get('artist'),
    album: get('album'),
    albumArtist: get('albumartist'),
    trackNumber: parseIntOrNull(get('tracknumber')),
    year: parseIntOrNull(get('date') ?? get('year')),
    genre: get('genre'),
    comment: get('comment') ?? get('description'),
    replayGainTrackDb: gain('replaygain_track_gain'),
    replayGainAlbumDb: gain('replaygain_album_gain'),
    peakAmplitude: parseFloatOrNull(get('replaygain_track_peak')),
    encoder: get('encoder') ?? comments?.vendor ?? null,
  };
}
