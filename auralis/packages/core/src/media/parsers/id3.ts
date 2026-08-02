import type { MediaTags } from '../../domain/media.js';
import { cleanTagString, decodeText, parseIntOrNull } from '../bytes.js';
import { asciiSlice, id3v2TagSize } from '../signatures.js';

/**
 * ID3v2 and ID3v1 tag reading. Deliberately conservative:
 *  - frame sizes are bounded, so an oversized declared length cannot allocate
 *  - at most MAX_FRAMES frames are read, so a crafted tag cannot spin the CPU
 *  - all strings pass through cleanTagString before leaving this module
 */

const MAX_FRAMES = 128;
const MAX_FRAME_BYTES = 64 * 1024;
const NUL = '\u0000';

export interface Id3Result {
  readonly tags: MediaTags;
  readonly replayGainTrackDb: number | null;
  readonly replayGainAlbumDb: number | null;
  readonly encoder: string | null;
  readonly tagBytes: number;
}

const EMPTY_RESULT: Id3Result = {
  tags: {
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    trackNumber: null,
    year: null,
    genre: null,
    comment: null,
  },
  replayGainTrackDb: null,
  replayGainAlbumDb: null,
  encoder: null,
  tagBytes: 0,
};

/**
 * Decodes a text frame payload into its NUL-separated parts. Frames such as
 * TXXX and COMM carry a description and a value in one payload, so splitting
 * has to happen before control characters are stripped.
 */
function decodeFrameParts(payload: Uint8Array): string[] {
  if (payload.length === 0) return [];
  const encodingByte = payload[0] ?? 0;
  const body = payload.subarray(1);
  let raw: string;
  switch (encodingByte) {
    case 0:
      raw = decodeText(body, 'latin1');
      break;
    case 1:
      raw = decodeText(body, 'utf16');
      break;
    case 2:
      raw = decodeText(body, 'utf16be');
      break;
    case 3:
      raw = decodeText(body, 'utf8');
      break;
    default:
      raw = decodeText(payload, 'latin1');
      break;
  }
  return raw.split(NUL);
}

function decodeFrameText(payload: Uint8Array): string | null {
  for (const part of decodeFrameParts(payload)) {
    const cleaned = cleanTagString(part);
    if (cleaned) return cleaned;
  }
  return null;
}

/** COMM/COM payload is: encoding byte, 3-byte language, description NUL, text. */
function decodeCommentFrame(payload: Uint8Array): string | null {
  if (payload.length < 5) return null;
  const withoutLanguage = new Uint8Array(payload.length - 3);
  withoutLanguage[0] = payload[0] ?? 0;
  withoutLanguage.set(payload.subarray(4), 1);
  const parts = decodeFrameParts(withoutLanguage);
  const text = parts.length > 1 ? parts.slice(1).join(' ') : (parts[0] ?? '');
  return cleanTagString(text);
}

function syncSafeSize(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) & 0x7f) * 0x200000 +
    ((bytes[offset + 1] ?? 0) & 0x7f) * 0x4000 +
    ((bytes[offset + 2] ?? 0) & 0x7f) * 0x80 +
    ((bytes[offset + 3] ?? 0) & 0x7f)
  );
}

function plainSize(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    (bytes[offset + 1] ?? 0) * 0x10000 +
    (bytes[offset + 2] ?? 0) * 0x100 +
    (bytes[offset + 3] ?? 0)
  );
}

export function parseId3v2(bytes: Uint8Array): Id3Result {
  const tagBytes = id3v2TagSize(bytes);
  if (tagBytes === 0) return EMPTY_RESULT;

  const majorVersion = bytes[3] ?? 0;
  if (majorVersion < 2 || majorVersion > 4) return { ...EMPTY_RESULT, tagBytes };

  const flags = bytes[5] ?? 0;
  let offset = 10;
  if ((flags & 0x40) !== 0) {
    // Extended header; its size field is sync-safe in v4 and plain in v3.
    const extSize = majorVersion === 4 ? syncSafeSize(bytes, offset) : plainSize(bytes, offset) + 4;
    offset += Math.max(0, Math.min(extSize, tagBytes - offset));
  }

  const frameIdLength = majorVersion === 2 ? 3 : 4;
  const frameHeaderLength = majorVersion === 2 ? 6 : 10;
  const limit = Math.min(bytes.length, tagBytes);

  const values = new Map<string, string>();
  const userTextValues = new Map<string, string>();
  let frames = 0;

  while (offset + frameHeaderLength <= limit && frames < MAX_FRAMES) {
    const frameId = asciiSlice(bytes, offset, frameIdLength);
    if (!/^[A-Z0-9]+$/.test(frameId)) break; // padding reached

    let size: number;
    if (majorVersion === 2) {
      size =
        (bytes[offset + 3] ?? 0) * 0x10000 +
        (bytes[offset + 4] ?? 0) * 0x100 +
        (bytes[offset + 5] ?? 0);
    } else if (majorVersion === 4) {
      size = syncSafeSize(bytes, offset + 4);
    } else {
      size = plainSize(bytes, offset + 4);
    }

    if (size <= 0 || size > MAX_FRAME_BYTES) break;
    const payloadStart = offset + frameHeaderLength;
    if (payloadStart + size > limit) break;

    const payload = bytes.subarray(payloadStart, payloadStart + size);

    if (frameId === 'TXXX' || frameId === 'TXX') {
      const parts = decodeFrameParts(payload);
      const description = cleanTagString(parts[0] ?? '')?.toLowerCase() ?? '';
      const value = cleanTagString(parts.slice(1).join(' '));
      if (description.length > 0 && value) userTextValues.set(description, value);
    } else if (frameId === 'COMM' || frameId === 'COM') {
      const decoded = decodeCommentFrame(payload);
      if (decoded !== null && !values.has(frameId)) values.set(frameId, decoded);
    } else if (frameId.startsWith('T')) {
      const decoded = decodeFrameText(payload);
      if (decoded !== null && !values.has(frameId)) values.set(frameId, decoded);
    }

    offset = payloadStart + size;
    frames += 1;
  }

  const pick = (...ids: string[]): string | null => {
    for (const id of ids) {
      const value = values.get(id);
      if (value) return cleanTagString(value);
    }
    return null;
  };

  const gain = (key: string): number | null => {
    const raw = userTextValues.get(key);
    if (!raw) return null;
    const match = /(-?\d+(?:\.\d+)?)\s*dB/i.exec(raw);
    return match?.[1] ? Number(match[1]) : null;
  };

  return {
    tags: {
      title: pick('TIT2', 'TT2'),
      artist: pick('TPE1', 'TP1'),
      album: pick('TALB', 'TAL'),
      albumArtist: pick('TPE2', 'TP2'),
      trackNumber: parseIntOrNull(pick('TRCK', 'TRK')),
      year: parseIntOrNull(pick('TYER', 'TDRC', 'TYE', 'TDRL')),
      genre: pick('TCON', 'TCO'),
      comment: pick('COMM', 'COM'),
    },
    replayGainTrackDb: gain('replaygain_track_gain'),
    replayGainAlbumDb: gain('replaygain_album_gain'),
    encoder: pick('TSSE', 'TEN'),
    tagBytes,
  };
}

/** Reads a 128-byte ID3v1 trailer. `tail` must be the final bytes of the file. */
export function parseId3v1(tail: Uint8Array): MediaTags | null {
  if (tail.length < 128) return null;
  const start = tail.length - 128;
  if (asciiSlice(tail, start, 3) !== 'TAG') return null;

  const field = (offset: number, length: number): string | null =>
    cleanTagString(decodeText(tail.subarray(start + offset, start + offset + length), 'latin1'));

  const trackMarker = tail[start + 125];
  const trackByte = tail[start + 126];
  const trackNumber =
    trackMarker === 0 && typeof trackByte === 'number' && trackByte > 0 ? trackByte : null;

  return {
    title: field(3, 30),
    artist: field(33, 30),
    album: field(63, 30),
    albumArtist: null,
    trackNumber,
    year: parseIntOrNull(field(93, 4)),
    genre: null,
    comment: field(97, trackNumber === null ? 30 : 28),
  };
}
