import type { AudioCodec } from '../../domain/media.js';
import { ByteReader, cleanTagString, decodeText, parseIntOrNull } from '../bytes.js';

/**
 * ISO base media (MP4/M4A) parsing. Walks the box tree with a bounded depth and
 * box count so a crafted file cannot cause deep recursion or a long scan.
 */

export interface Mp4Analysis {
  readonly codec: AudioCodec;
  readonly channels: number | null;
  readonly sampleRateHz: number | null;
  readonly bitDepth: number | null;
  readonly durationSeconds: number | null;
  readonly averageBitrateBps: number | null;
  readonly maxBitrateBps: number | null;
  readonly brand: string | null;
  readonly tags: ReadonlyMap<string, string>;
  readonly moovFound: boolean;
  readonly moovAtEnd: boolean;
  readonly corruptionSignals: readonly string[];
}

const MAX_BOXES = 512;
const MAX_DEPTH = 8;

interface Box {
  readonly type: string;
  readonly start: number;
  readonly payloadStart: number;
  readonly end: number;
}

const CONTAINER_BOXES: ReadonlySet<string> = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'udta',
  'meta',
  'ilst',
  'moof',
  'traf',
  'edts',
]);

const ITUNES_TAGS: Readonly<Record<string, string>> = {
  '©nam': 'title',
  '©ART': 'artist',
  '©alb': 'album',
  aART: 'albumartist',
  '©day': 'date',
  '©gen': 'genre',
  gnre: 'genre',
  '©cmt': 'comment',
  '©too': 'encoder',
  trkn: 'tracknumber',
};

function readBox(reader: ByteReader, offset: number, limit: number): Box | null {
  if (!reader.has(offset, 8)) return null;
  let size = reader.u32be(offset) ?? 0;
  const type = reader.ascii(offset + 4, 4) ?? '';
  let payloadStart = offset + 8;

  if (size === 1) {
    const large = reader.u64be(offset + 8);
    if (large === null) return null;
    size = large;
    payloadStart = offset + 16;
  } else if (size === 0) {
    size = limit - offset; // extends to the end of the enclosing box
  }

  if (size < 8) return null;
  const end = Math.min(offset + size, limit);
  if (payloadStart > end) return null;
  return { type, start: offset, payloadStart, end };
}

export function parseMp4(bytes: Uint8Array, totalSize: number | null): Mp4Analysis {
  const reader = new ByteReader(bytes);
  const corruption: string[] = [];
  const tags = new Map<string, string>();

  let codec: AudioCodec = 'unknown';
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let bitDepth: number | null = null;
  let durationSeconds: number | null = null;
  let averageBitrate: number | null = null;
  let maxBitrate: number | null = null;
  let brand: string | null = null;
  let moovFound = false;
  let moovOffset = -1;
  let boxCount = 0;

  const walk = (start: number, limit: number, depth: number): void => {
    if (depth > MAX_DEPTH) {
      corruption.push('mp4:box-tree-too-deep');
      return;
    }
    let offset = start;
    while (offset < limit && boxCount < MAX_BOXES) {
      const box = readBox(reader, offset, limit);
      if (!box) break;
      boxCount += 1;

      switch (box.type) {
        case 'ftyp':
          brand = (reader.ascii(box.payloadStart, 4) ?? '').trim() || null;
          break;
        case 'moov':
          moovFound = true;
          moovOffset = box.start;
          walk(box.payloadStart, box.end, depth + 1);
          break;
        case 'mvhd': {
          const version = reader.u8(box.payloadStart) ?? 0;
          const timescale =
            version === 1
              ? reader.u32be(box.payloadStart + 20)
              : reader.u32be(box.payloadStart + 12);
          const duration =
            version === 1
              ? reader.u64be(box.payloadStart + 24)
              : reader.u32be(box.payloadStart + 16);
          if (timescale && duration !== null && timescale > 0) {
            durationSeconds = duration / timescale;
          }
          break;
        }
        case 'stsd': {
          // entry_count at payload+4, first entry begins at payload+8
          const entry = readBox(reader, box.payloadStart + 8, box.end);
          if (entry) {
            codec = codecForSampleEntry(entry.type);
            channels = reader.u16be(entry.payloadStart + 16) ?? null;
            bitDepth = reader.u16be(entry.payloadStart + 18) ?? null;
            // 16.16 fixed-point sample rate
            const rate = reader.u16be(entry.payloadStart + 24);
            sampleRate = rate === null || rate === 0 ? null : rate;
            walk(entry.payloadStart + 28, entry.end, depth + 1);
          }
          break;
        }
        case 'esds': {
          const info = parseEsds(reader, box.payloadStart + 4, box.end);
          if (info) {
            if (info.averageBitrateBps > 0) averageBitrate = info.averageBitrateBps;
            if (info.maxBitrateBps > 0) maxBitrate = info.maxBitrateBps;
            if (info.objectTypeIndication === 0x40) codec = 'aac_lc';
          }
          break;
        }
        case 'btrt': {
          maxBitrate = reader.u32be(box.payloadStart + 4) ?? maxBitrate;
          averageBitrate = reader.u32be(box.payloadStart + 8) ?? averageBitrate;
          break;
        }
        case 'alac': {
          codec = 'alac';
          // ALAC magic cookie: bit depth at +9, channels at +13, sample rate at +20
          const alacBox = readBox(reader, box.payloadStart + 28, box.end);
          const cookie = alacBox?.type === 'alac' ? alacBox.payloadStart + 4 : null;
          if (cookie !== null) {
            bitDepth = reader.u8(cookie + 5) ?? bitDepth;
            channels = reader.u8(cookie + 9) ?? channels;
            sampleRate = reader.u32be(cookie + 20) ?? sampleRate;
          }
          break;
        }
        case 'meta':
          // `meta` is a full box: 4 bytes of version/flags precede its children.
          walk(box.payloadStart + 4, box.end, depth + 1);
          break;
        default:
          if (CONTAINER_BOXES.has(box.type)) {
            walk(box.payloadStart, box.end, depth + 1);
          } else {
            const mapped = ITUNES_TAGS[box.type];
            if (mapped) readItunesTag(reader, box, mapped, tags);
          }
          break;
      }

      if (box.end <= offset) break; // never move backwards
      offset = box.end;
    }
  };

  walk(0, bytes.length, 0);

  if (boxCount >= MAX_BOXES) corruption.push('mp4:excessive-box-count');
  if (!moovFound) corruption.push('mp4:moov-not-in-inspected-range');

  const moovAtEnd = moovFound && totalSize !== null && moovOffset > 0 && moovOffset > totalSize / 2;

  if (codec === 'unknown' && moovFound) corruption.push('mp4:unrecognised-sample-entry');

  return {
    codec,
    channels,
    sampleRateHz: sampleRate,
    bitDepth: bitDepth === 0 ? null : bitDepth,
    durationSeconds,
    averageBitrateBps: averageBitrate,
    maxBitrateBps: maxBitrate,
    brand,
    tags,
    moovFound,
    moovAtEnd,
    corruptionSignals: corruption,
  };
}

function codecForSampleEntry(type: string): AudioCodec {
  switch (type) {
    case 'mp4a':
      return 'aac_lc';
    case 'alac':
      return 'alac';
    case 'Opus':
      return 'opus';
    case 'fLaC':
      return 'flac';
    case 'sowt':
    case 'lpcm':
    case 'in24':
      return 'pcm_s24le';
    case 'twos':
      return 'pcm_s16be';
    default:
      return 'unknown';
  }
}

interface EsdsInfo {
  readonly objectTypeIndication: number;
  readonly maxBitrateBps: number;
  readonly averageBitrateBps: number;
}

/** Minimal MPEG-4 elementary stream descriptor reader (DecoderConfig only). */
function parseEsds(reader: ByteReader, start: number, limit: number): EsdsInfo | null {
  let offset = start;
  let guard = 0;
  while (offset < limit && guard < 16) {
    guard += 1;
    const tag = reader.u8(offset);
    if (tag === null) return null;
    offset += 1;
    // Descriptor lengths use a 7-bit-per-byte variable encoding.
    let length = 0;
    for (let i = 0; i < 4; i += 1) {
      const b = reader.u8(offset);
      if (b === null) return null;
      offset += 1;
      length = (length << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }

    if (tag === 0x03) {
      // ES_Descriptor: skip ES_ID (2) plus flags byte, then continue inline.
      const flags = reader.u8(offset + 2) ?? 0;
      offset += 3;
      if ((flags & 0x80) !== 0) offset += 2;
      if ((flags & 0x40) !== 0) offset += (reader.u8(offset) ?? 0) + 1;
      if ((flags & 0x20) !== 0) offset += 2;
      continue;
    }
    if (tag === 0x04) {
      const objectTypeIndication = reader.u8(offset) ?? 0;
      const maxBitrate = reader.u32be(offset + 5) ?? 0;
      const averageBitrate = reader.u32be(offset + 9) ?? 0;
      return { objectTypeIndication, maxBitrateBps: maxBitrate, averageBitrateBps: averageBitrate };
    }
    offset += length;
  }
  return null;
}

function readItunesTag(reader: ByteReader, box: Box, key: string, out: Map<string, string>): void {
  const data = readBox(reader, box.payloadStart, box.end);
  if (!data || data.type !== 'data') return;
  const payload = reader.slice(
    data.payloadStart + 8,
    Math.min(data.end - data.payloadStart - 8, 4096),
  );
  if (!payload) return;

  if (key === 'tracknumber') {
    const track = reader.u16be(data.payloadStart + 8 + 2);
    if (track) out.set(key, String(track));
    return;
  }
  const value = cleanTagString(decodeText(payload, 'utf8'));
  if (value && !out.has(key)) out.set(key, value);
}

export function mp4TagNumber(tags: ReadonlyMap<string, string>, key: string): number | null {
  return parseIntOrNull(tags.get(key) ?? null);
}
