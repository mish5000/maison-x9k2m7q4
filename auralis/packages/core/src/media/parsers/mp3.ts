import { ByteReader } from '../bytes.js';
import { asciiSlice, findMpegSync, id3v2TagSize, isMpegFrameSync } from '../signatures.js';

/** MPEG-1/2/2.5 Layer I-III frame header parsing, plus Xing/Info/VBRI headers. */

const BITRATE_TABLE_V1_L3 = [
  0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, -1,
] as const;
const BITRATE_TABLE_V1_L2 = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, -1,
] as const;
const BITRATE_TABLE_V1_L1 = [
  0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, -1,
] as const;
const BITRATE_TABLE_V2_L1 = [
  0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, -1,
] as const;
const BITRATE_TABLE_V2_L23 = [
  0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, -1,
] as const;

const SAMPLE_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

export interface Mp3FrameHeader {
  readonly offset: number;
  readonly mpegVersion: '1' | '2' | '2.5';
  readonly layer: 1 | 2 | 3;
  readonly bitrateBps: number | null;
  readonly sampleRateHz: number;
  readonly channels: number;
  readonly channelMode: 'stereo' | 'joint_stereo' | 'dual_channel' | 'mono';
  readonly frameLengthBytes: number;
  readonly samplesPerFrame: number;
  readonly padded: boolean;
  readonly crcProtected: boolean;
}

export function parseMp3FrameHeader(bytes: Uint8Array, offset: number): Mp3FrameHeader | null {
  if (!isMpegFrameSync(bytes, offset)) return null;
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b1 === undefined || b2 === undefined || b3 === undefined) return null;

  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const crcProtected = (b1 & 0x01) === 0;
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  const padded = ((b2 >> 1) & 0x01) === 1;
  const channelModeBits = (b3 >> 6) & 0x03;

  if (bitrateIndex === 0x0f || sampleRateIndex === 0x03) return null;

  const mpegVersion = versionBits === 3 ? '1' : versionBits === 2 ? '2' : '2.5';
  const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;

  const sampleRate = SAMPLE_RATES[versionBits]?.[sampleRateIndex];
  if (sampleRate === undefined) return null;

  let table: readonly number[];
  if (mpegVersion === '1') {
    table =
      layer === 1 ? BITRATE_TABLE_V1_L1 : layer === 2 ? BITRATE_TABLE_V1_L2 : BITRATE_TABLE_V1_L3;
  } else {
    table = layer === 1 ? BITRATE_TABLE_V2_L1 : BITRATE_TABLE_V2_L23;
  }
  const bitrateKbps = table[bitrateIndex];
  if (bitrateKbps === undefined || bitrateKbps <= 0) return null;
  const bitrateBps = bitrateKbps * 1000;

  const samplesPerFrame = layer === 1 ? 384 : layer === 2 ? 1152 : mpegVersion === '1' ? 1152 : 576;

  const frameLengthBytes =
    layer === 1
      ? (Math.floor((12 * bitrateBps) / sampleRate) + (padded ? 1 : 0)) * 4
      : Math.floor((samplesPerFrame / 8) * (bitrateBps / sampleRate)) + (padded ? 1 : 0);

  const channelMode =
    channelModeBits === 0
      ? 'stereo'
      : channelModeBits === 1
        ? 'joint_stereo'
        : channelModeBits === 2
          ? 'dual_channel'
          : 'mono';

  return {
    offset,
    mpegVersion,
    layer,
    bitrateBps,
    sampleRateHz: sampleRate,
    channels: channelMode === 'mono' ? 1 : 2,
    channelMode,
    frameLengthBytes,
    samplesPerFrame,
    padded,
    crcProtected,
  };
}

export interface XingHeader {
  readonly kind: 'Xing' | 'Info' | 'VBRI';
  readonly frameCount: number | null;
  readonly byteCount: number | null;
  readonly qualityIndicator: number | null;
  readonly encoderDelaySamples: number | null;
  readonly encoderPaddingSamples: number | null;
  readonly encoder: string | null;
  /** `Info` marks a constant-bitrate stream written by LAME. */
  readonly indicatesVbr: boolean;
}

/** Locates the Xing/Info/VBRI header inside the first MPEG frame. */
export function parseXingHeader(bytes: Uint8Array, frame: Mp3FrameHeader): XingHeader | null {
  const reader = new ByteReader(bytes);

  // Xing/Info sits after the side information, whose size depends on the mode.
  const sideInfoSize =
    frame.mpegVersion === '1' ? (frame.channels === 1 ? 17 : 32) : frame.channels === 1 ? 9 : 17;
  const xingOffset = frame.offset + 4 + (frame.crcProtected ? 2 : 0) + sideInfoSize;
  const tag = reader.ascii(xingOffset, 4);

  if (tag === 'Xing' || tag === 'Info') {
    const flags = reader.u32be(xingOffset + 4) ?? 0;
    let cursor = xingOffset + 8;
    let frameCount: number | null = null;
    let byteCount: number | null = null;
    let qualityIndicator: number | null = null;

    if ((flags & 0x0001) !== 0) {
      frameCount = reader.u32be(cursor);
      cursor += 4;
    }
    if ((flags & 0x0002) !== 0) {
      byteCount = reader.u32be(cursor);
      cursor += 4;
    }
    if ((flags & 0x0004) !== 0) cursor += 100; // TOC
    if ((flags & 0x0008) !== 0) {
      qualityIndicator = reader.u32be(cursor);
      cursor += 4;
    }

    // The LAME tag, when present, immediately follows.
    const lameTag = reader.ascii(cursor, 9);
    let encoder: string | null = null;
    let delay: number | null = null;
    let padding: number | null = null;
    if (lameTag && /^(LAME|Lavc|Lavf)/.test(lameTag)) {
      encoder = lameTag.replace(/[^\x20-\x7e]/g, '').trim() || null;
      const delayBytes = reader.slice(cursor + 21, 3);
      if (delayBytes) {
        const packed =
          ((delayBytes[0] ?? 0) << 16) | ((delayBytes[1] ?? 0) << 8) | (delayBytes[2] ?? 0);
        delay = (packed >> 12) & 0xfff;
        padding = packed & 0xfff;
      }
    }

    return {
      kind: tag,
      frameCount,
      byteCount,
      qualityIndicator,
      encoderDelaySamples: delay,
      encoderPaddingSamples: padding,
      encoder,
      indicatesVbr: tag === 'Xing',
    };
  }

  // VBRI is written by the Fraunhofer encoder at a fixed offset.
  const vbriOffset = frame.offset + 4 + 32;
  if (reader.ascii(vbriOffset, 4) === 'VBRI') {
    return {
      kind: 'VBRI',
      frameCount: reader.u32be(vbriOffset + 14),
      byteCount: reader.u32be(vbriOffset + 10),
      qualityIndicator: reader.u16be(vbriOffset + 8),
      encoderDelaySamples: reader.u16be(vbriOffset + 6),
      encoderPaddingSamples: null,
      encoder: 'Fraunhofer',
      indicatesVbr: true,
    };
  }

  return null;
}

export interface Mp3Analysis {
  readonly firstFrame: Mp3FrameHeader;
  readonly xing: XingHeader | null;
  /** Distinct nominal bitrates seen while scanning the prefix. */
  readonly observedBitratesBps: readonly number[];
  readonly framesScanned: number;
  readonly audioStartOffset: number;
  readonly hasId3v2: boolean;
  readonly corruptionSignals: readonly string[];
}

const MAX_FRAMES_SCANNED = 400;

/**
 * Scans the prefix of an MP3 for frame headers. Bounded by MAX_FRAMES_SCANNED
 * so a malformed file cannot turn probing into a long-running loop.
 */
export function analyseMp3(bytes: Uint8Array): Mp3Analysis | null {
  const tagBytes = id3v2TagSize(bytes);
  const searchStart = Math.min(tagBytes, Math.max(0, bytes.length - 4));
  let offset = findMpegSync(bytes, searchStart, 64 * 1024);
  if (offset < 0) offset = findMpegSync(bytes, 0, 64 * 1024);
  if (offset < 0) return null;

  const firstFrame = parseMp3FrameHeader(bytes, offset);
  if (!firstFrame) return null;

  const xing = parseXingHeader(bytes, firstFrame);
  const observed = new Set<number>();
  const corruption: string[] = [];
  let cursor = offset;
  let framesScanned = 0;

  while (framesScanned < MAX_FRAMES_SCANNED) {
    const frame = parseMp3FrameHeader(bytes, cursor);
    if (!frame) {
      if (cursor < bytes.length - 4) {
        const resync = findMpegSync(bytes, cursor + 1, 8192);
        if (resync < 0) break;
        if (framesScanned > 0) corruption.push('mpeg:frame-resync-required');
        cursor = resync;
        continue;
      }
      break;
    }
    if (frame.sampleRateHz !== firstFrame.sampleRateHz) {
      corruption.push('mpeg:sample-rate-changes-mid-stream');
    }
    if (frame.bitrateBps !== null) observed.add(frame.bitrateBps);
    if (frame.frameLengthBytes <= 4) {
      corruption.push('mpeg:zero-length-frame');
      break;
    }
    cursor += frame.frameLengthBytes;
    framesScanned += 1;
    if (cursor + 4 > bytes.length) break;
  }

  return {
    firstFrame,
    xing,
    observedBitratesBps: [...observed].sort((a, b) => a - b),
    framesScanned,
    audioStartOffset: offset,
    hasId3v2: tagBytes > 0,
    corruptionSignals: [...new Set(corruption)],
  };
}

/** Checks whether the trailing bytes carry an APE or Lyrics3 tag. */
export function hasTrailingTag(tail: Uint8Array): boolean {
  if (tail.length < 32) return false;
  return (
    asciiSlice(tail, tail.length - 32, 8) === 'APETAGEX' ||
    asciiSlice(tail, tail.length - 9, 9) === 'LYRICS200'
  );
}
