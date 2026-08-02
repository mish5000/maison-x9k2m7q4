import type { AudioCodec } from '../../domain/media.js';
import { ByteReader, cleanTagString, decodeText } from '../bytes.js';

/** RIFF/WAVE parsing: fmt chunk, data size, LIST/INFO tags. */

export interface WaveAnalysis {
  readonly codec: AudioCodec;
  readonly formatTag: number;
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly byteRate: number;
  readonly bitDepth: number;
  readonly dataSizeBytes: number | null;
  readonly declaredRiffSize: number | null;
  readonly tags: ReadonlyMap<string, string>;
  readonly corruptionSignals: readonly string[];
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_ALAW = 0x0006;
const WAVE_FORMAT_MULAW = 0x0007;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

const MAX_CHUNKS = 64;

const INFO_KEYS: Readonly<Record<string, string>> = {
  INAM: 'title',
  IART: 'artist',
  IPRD: 'album',
  ICMT: 'comment',
  ICRD: 'date',
  IGNR: 'genre',
  ITRK: 'tracknumber',
  ISFT: 'encoder',
};

function pcmCodecFor(bitDepth: number, formatTag: number): AudioCodec {
  if (formatTag === WAVE_FORMAT_IEEE_FLOAT) return 'pcm_f32le';
  if (bitDepth === 16) return 'pcm_s16le';
  if (bitDepth === 24) return 'pcm_s24le';
  if (bitDepth === 32) return 'pcm_s32le';
  return 'unknown';
}

export function parseWave(bytes: Uint8Array): WaveAnalysis | null {
  const reader = new ByteReader(bytes);
  if (reader.ascii(0, 4) !== 'RIFF' || reader.ascii(8, 4) !== 'WAVE') return null;

  const declaredRiffSize = reader.u32le(4);
  const corruption: string[] = [];
  const tags = new Map<string, string>();

  let offset = 12;
  let chunks = 0;
  let formatTag = 0;
  let channels = 0;
  let sampleRate = 0;
  let byteRate = 0;
  let bitDepth = 0;
  let dataSize: number | null = null;
  let sawFmt = false;

  while (chunks < MAX_CHUNKS && reader.has(offset, 8)) {
    const chunkId = reader.ascii(offset, 4) ?? '';
    const chunkSize = reader.u32le(offset + 4) ?? 0;
    const payloadStart = offset + 8;

    if (chunkId === 'fmt ') {
      sawFmt = true;
      // A fmt chunk that runs past the bytes we hold means the file is either
      // truncated or lying about its own structure. Either way its numbers
      // cannot be trusted, so this is recorded rather than silently read as 0.
      if (!reader.has(payloadStart, Math.min(chunkSize, 16))) {
        corruption.push('wav:fmt-chunk-truncated');
      }
      formatTag = reader.u16le(payloadStart) ?? 0;
      channels = reader.u16le(payloadStart + 2) ?? 0;
      sampleRate = reader.u32le(payloadStart + 4) ?? 0;
      byteRate = reader.u32le(payloadStart + 8) ?? 0;
      bitDepth = reader.u16le(payloadStart + 14) ?? 0;
      if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
        // The real format sits in the first two bytes of the GUID subformat.
        const sub = reader.u16le(payloadStart + 24);
        if (sub !== null) formatTag = sub;
      }
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    } else if (chunkId === 'LIST' && reader.ascii(payloadStart, 4) === 'INFO') {
      readInfoChunk(reader, payloadStart + 4, payloadStart + chunkSize, tags);
    }

    // Chunks are word-aligned; an odd size is followed by a pad byte.
    offset = payloadStart + chunkSize + (chunkSize % 2);
    chunks += 1;
    if (chunkSize === 0 && chunkId.length === 0) break;
  }

  if (!sawFmt) corruption.push('wav:missing-fmt-chunk');
  if (sampleRate <= 0) corruption.push('wav:invalid-sample-rate');
  if (channels <= 0) corruption.push('wav:invalid-channel-count');
  if (bitDepth <= 0) corruption.push('wav:invalid-bit-depth');
  if (byteRate <= 0) corruption.push('wav:invalid-byte-rate');
  // The data chunk header sits near the start of any well-formed WAV, so its
  // absence is meaningful even when only a head sample has been fetched.
  if (dataSize === null) corruption.push('wav:data-chunk-not-found');
  if (
    declaredRiffSize !== null &&
    bytes.length >= declaredRiffSize + 8 &&
    declaredRiffSize + 8 < bytes.length
  ) {
    corruption.push('wav:trailing-data-after-riff-chunk');
  }

  const codec =
    formatTag === WAVE_FORMAT_PCM || formatTag === WAVE_FORMAT_IEEE_FLOAT
      ? pcmCodecFor(bitDepth, formatTag)
      : formatTag === WAVE_FORMAT_ALAW || formatTag === WAVE_FORMAT_MULAW
        ? 'unknown'
        : formatTag === 0x0055
          ? 'mp3'
          : 'unknown';

  return {
    codec,
    formatTag,
    channels,
    sampleRateHz: sampleRate,
    byteRate,
    bitDepth,
    dataSizeBytes: dataSize,
    declaredRiffSize,
    tags,
    corruptionSignals: corruption,
  };
}

function readInfoChunk(
  reader: ByteReader,
  start: number,
  end: number,
  out: Map<string, string>,
): void {
  let offset = start;
  let entries = 0;
  while (offset + 8 <= end && entries < 32) {
    const key = reader.ascii(offset, 4) ?? '';
    const size = reader.u32le(offset + 4) ?? 0;
    if (size < 0 || size > 4096) break;
    const payload = reader.slice(offset + 8, size);
    const mapped = INFO_KEYS[key];
    if (mapped && payload) {
      const value = cleanTagString(decodeText(payload, 'latin1'));
      if (value && !out.has(mapped)) out.set(mapped, value);
    }
    offset += 8 + size + (size % 2);
    entries += 1;
  }
}

export interface AiffAnalysis {
  readonly codec: AudioCodec;
  readonly channels: number;
  readonly sampleRateHz: number;
  readonly bitDepth: number;
  readonly numSampleFrames: number;
  readonly compressionType: string | null;
  readonly tags: ReadonlyMap<string, string>;
  readonly corruptionSignals: readonly string[];
}

/** Decodes an 80-bit IEEE 754 extended float, as used by AIFF sample rates. */
export function decodeExtendedFloat80(bytes: Uint8Array, offset: number): number | null {
  const reader = new ByteReader(bytes);
  const exponentAndSign = reader.u16be(offset);
  const hiMantissa = reader.u32be(offset + 2);
  const loMantissa = reader.u32be(offset + 6);
  if (exponentAndSign === null || hiMantissa === null || loMantissa === null) return null;

  const sign = (exponentAndSign & 0x8000) !== 0 ? -1 : 1;
  const exponent = exponentAndSign & 0x7fff;
  if (exponent === 0 && hiMantissa === 0 && loMantissa === 0) return 0;
  if (exponent === 0x7fff) return null;

  const mantissa = hiMantissa * 2 ** 32 + loMantissa;
  return sign * mantissa * 2 ** (exponent - 16383 - 63);
}

const AIFF_TEXT_CHUNKS: Readonly<Record<string, string>> = {
  NAME: 'title',
  AUTH: 'artist',
  ANNO: 'comment',
  '(c) ': 'copyright',
};

export function parseAiff(bytes: Uint8Array): AiffAnalysis | null {
  const reader = new ByteReader(bytes);
  if (reader.ascii(0, 4) !== 'FORM') return null;
  const formType = reader.ascii(8, 4);
  if (formType !== 'AIFF' && formType !== 'AIFC') return null;

  const corruption: string[] = [];
  const tags = new Map<string, string>();
  let offset = 12;
  let chunks = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitDepth = 0;
  let numSampleFrames = 0;
  let compressionType: string | null = null;
  let sawComm = false;

  while (chunks < MAX_CHUNKS && reader.has(offset, 8)) {
    const chunkId = reader.ascii(offset, 4) ?? '';
    const chunkSize = reader.u32be(offset + 4) ?? 0;
    const payloadStart = offset + 8;

    if (chunkId === 'COMM') {
      sawComm = true;
      channels = reader.u16be(payloadStart) ?? 0;
      numSampleFrames = reader.u32be(payloadStart + 2) ?? 0;
      bitDepth = reader.u16be(payloadStart + 6) ?? 0;
      sampleRate = Math.round(decodeExtendedFloat80(bytes, payloadStart + 8) ?? 0);
      if (formType === 'AIFC') compressionType = reader.ascii(payloadStart + 18, 4);
    } else {
      const mapped = AIFF_TEXT_CHUNKS[chunkId];
      if (mapped && chunkSize <= 4096) {
        const payload = reader.slice(payloadStart, chunkSize);
        const value = payload ? cleanTagString(decodeText(payload, 'latin1')) : null;
        if (value && !tags.has(mapped)) tags.set(mapped, value);
      }
    }

    offset = payloadStart + chunkSize + (chunkSize % 2);
    chunks += 1;
  }

  if (!sawComm) corruption.push('aiff:missing-comm-chunk');
  if (sampleRate <= 0) corruption.push('aiff:invalid-sample-rate');

  const normalisedCompression = compressionType?.trim() ?? null;
  let codec: AudioCodec = 'unknown';
  if (normalisedCompression === null || normalisedCompression === 'NONE') {
    codec = bitDepth === 16 ? 'pcm_s16be' : bitDepth === 24 ? 'pcm_s24be' : 'unknown';
  } else if (normalisedCompression === 'sowt') {
    codec = bitDepth === 16 ? 'pcm_s16le' : bitDepth === 24 ? 'pcm_s24le' : 'unknown';
  } else if (normalisedCompression === 'fl32') {
    codec = 'pcm_f32le';
  } else if (normalisedCompression === 'alac') {
    codec = 'alac';
  }

  return {
    codec,
    channels,
    sampleRateHz: sampleRate,
    bitDepth,
    numSampleFrames,
    compressionType: normalisedCompression,
    tags,
    corruptionSignals: corruption,
  };
}
