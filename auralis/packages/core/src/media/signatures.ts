import type { AudioFormat } from '../domain/media.js';

/**
 * Magic-byte detection. An extension or a Content-Type header is a claim; the
 * bytes are evidence. Nothing in Auralis calls a file "verified audio" without
 * a signature match from this module.
 */

export interface SignatureMatch {
  /** Identifier such as `flac`, `id3v2+mpeg-frame`, `riff/wave`. */
  readonly signature: string;
  readonly format: AudioFormat;
  /** Byte offset at which the audio container actually starts. */
  readonly offset: number;
  /** Formats detected purely from a sync pattern are lower confidence. */
  readonly strong: boolean;
}

export interface NonAudioMatch {
  readonly signature: string;
  readonly kind: 'html' | 'xml' | 'executable' | 'archive' | 'image' | 'text' | 'video' | 'unknown';
  readonly reason: string;
}

function startsWith(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (offset + ascii.length > bytes.length) return false;
  for (let i = 0; i < ascii.length; i += 1) {
    if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
  }
  return true;
}

function bytesAt(bytes: Uint8Array, offset: number, values: readonly number[]): boolean {
  if (offset + values.length > bytes.length) return false;
  for (let i = 0; i < values.length; i += 1) {
    if (bytes[offset + i] !== values[i]) return false;
  }
  return true;
}

/** Size of an ID3v2 tag at the start of the buffer, or 0 when absent. */
export function id3v2TagSize(bytes: Uint8Array): number {
  if (!startsWith(bytes, 0, 'ID3')) return 0;
  if (bytes.length < 10) return 0;
  const flags = bytes[5] ?? 0;
  const size =
    ((bytes[6] ?? 0) & 0x7f) * 0x200000 +
    ((bytes[7] ?? 0) & 0x7f) * 0x4000 +
    ((bytes[8] ?? 0) & 0x7f) * 0x80 +
    ((bytes[9] ?? 0) & 0x7f);
  const footer = (flags & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

/** True when the two bytes at `offset` look like an MPEG audio frame sync. */
export function isMpegFrameSync(bytes: Uint8Array, offset: number): boolean {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  if (b0 === undefined || b1 === undefined) return false;
  if (b0 !== 0xff) return false;
  if ((b1 & 0xe0) !== 0xe0) return false;
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  // 0b01 is a reserved MPEG version and 0b00 a reserved layer.
  return versionBits !== 0x01 && layerBits !== 0x00;
}

const NON_AUDIO_SIGNATURES: ReadonlyArray<{
  test: (b: Uint8Array) => boolean;
  match: NonAudioMatch;
}> = [
  {
    test: (b) => bytesAt(b, 0, [0x4d, 0x5a]),
    match: { signature: 'mz', kind: 'executable', reason: 'Windows executable' },
  },
  {
    test: (b) => bytesAt(b, 0, [0x7f, 0x45, 0x4c, 0x46]),
    match: { signature: 'elf', kind: 'executable', reason: 'Linux executable' },
  },
  {
    test: (b) => bytesAt(b, 0, [0xca, 0xfe, 0xba, 0xbe]),
    match: { signature: 'mach-o-fat', kind: 'executable', reason: 'Mach-O binary' },
  },
  {
    test: (b) => bytesAt(b, 0, [0x50, 0x4b, 0x03, 0x04]),
    match: { signature: 'zip', kind: 'archive', reason: 'ZIP archive' },
  },
  {
    test: (b) => bytesAt(b, 0, [0x1f, 0x8b]),
    match: { signature: 'gzip', kind: 'archive', reason: 'gzip archive' },
  },
  {
    test: (b) => startsWith(b, 0, '%PDF'),
    match: { signature: 'pdf', kind: 'text', reason: 'PDF document' },
  },
  {
    test: (b) => bytesAt(b, 0, [0x89, 0x50, 0x4e, 0x47]),
    match: { signature: 'png', kind: 'image', reason: 'PNG image' },
  },
  {
    test: (b) => bytesAt(b, 0, [0xff, 0xd8, 0xff]),
    match: { signature: 'jpeg', kind: 'image', reason: 'JPEG image' },
  },
];

/** Detects content that is definitely not an audio file. */
export function detectNonAudio(bytes: Uint8Array): NonAudioMatch | null {
  for (const entry of NON_AUDIO_SIGNATURES) {
    if (entry.test(bytes)) return entry.match;
  }

  const prefix = asciiPrefix(bytes, 512).trimStart().toLowerCase();
  if (
    prefix.startsWith('<!doctype html') ||
    prefix.startsWith('<html') ||
    prefix.startsWith('<head')
  ) {
    return { signature: 'html', kind: 'html', reason: 'Web page, not an audio file' };
  }
  if (prefix.startsWith('<?xml') || prefix.startsWith('<rss') || prefix.startsWith('<feed')) {
    return { signature: 'xml', kind: 'xml', reason: 'XML document, not an audio file' };
  }
  return null;
}

function asciiPrefix(bytes: Uint8Array, limit: number): string {
  const end = Math.min(bytes.length, limit);
  let out = '';
  for (let i = 0; i < end; i += 1) {
    const c = bytes[i] ?? 0;
    out += c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : c === 0x0a || c === 0x0d ? '\n' : ' ';
  }
  return out;
}

const MP4_AUDIO_BRANDS: ReadonlySet<string> = new Set([
  'M4A ',
  'M4B ',
  'M4P ',
  'mp42',
  'mp41',
  'isom',
  'iso2',
  'dash',
  'M4V ',
  'qt  ',
]);

/**
 * Identify the audio container from magic bytes.
 * Returns null when nothing recognisable is present.
 */
export function detectAudioSignature(bytes: Uint8Array): SignatureMatch | null {
  if (bytes.length < 4) return null;

  if (startsWith(bytes, 0, 'fLaC')) {
    return { signature: 'flac', format: 'flac', offset: 0, strong: true };
  }
  if (startsWith(bytes, 0, 'OggS')) {
    // Distinguish Vorbis from Opus by the codec identification header.
    const window = bytes.subarray(0, Math.min(bytes.length, 128));
    if (indexOfAscii(window, 'OpusHead') >= 0) {
      return { signature: 'ogg/opus', format: 'opus', offset: 0, strong: true };
    }
    if (indexOfAscii(window, 'vorbis') >= 0) {
      return { signature: 'ogg/vorbis', format: 'ogg', offset: 0, strong: true };
    }
    if (indexOfAscii(window, 'FLAC') >= 0) {
      return { signature: 'ogg/flac', format: 'flac', offset: 0, strong: true };
    }
    return { signature: 'ogg', format: 'ogg', offset: 0, strong: false };
  }
  if (startsWith(bytes, 0, 'RIFF') && startsWith(bytes, 8, 'WAVE')) {
    return { signature: 'riff/wave', format: 'wav', offset: 0, strong: true };
  }
  if (startsWith(bytes, 0, 'FORM')) {
    if (startsWith(bytes, 8, 'AIFF')) {
      return { signature: 'aiff', format: 'aiff', offset: 0, strong: true };
    }
    if (startsWith(bytes, 8, 'AIFC')) {
      return { signature: 'aifc', format: 'aiff', offset: 0, strong: true };
    }
  }
  if (startsWith(bytes, 4, 'ftyp')) {
    const brand = asciiSlice(bytes, 8, 4);
    if (MP4_AUDIO_BRANDS.has(brand)) {
      return { signature: `mp4/${brand.trim()}`, format: 'm4a', offset: 0, strong: true };
    }
    return { signature: `mp4/${brand.trim()}`, format: 'm4a', offset: 0, strong: false };
  }
  if (bytesAt(bytes, 0, [0xff, 0xf1]) || bytesAt(bytes, 0, [0xff, 0xf9])) {
    return { signature: 'adts/aac', format: 'aac', offset: 0, strong: true };
  }

  const tagSize = id3v2TagSize(bytes);
  if (tagSize > 0) {
    // The frame may sit beyond the fetched prefix; that is still strong evidence
    // of an MPEG audio file when combined with a frame sync we can reach.
    const scanStart = Math.min(tagSize, bytes.length - 2);
    const syncOffset = findMpegSync(bytes, Math.max(0, scanStart), 8192);
    if (syncOffset >= 0) {
      return { signature: 'id3v2+mpeg-frame', format: 'mp3', offset: syncOffset, strong: true };
    }
    return { signature: 'id3v2', format: 'mp3', offset: tagSize, strong: false };
  }

  const syncOffset = findMpegSync(bytes, 0, 4096);
  if (syncOffset === 0) {
    return { signature: 'mpeg-frame', format: 'mp3', offset: 0, strong: true };
  }
  if (syncOffset > 0) {
    return { signature: 'mpeg-frame', format: 'mp3', offset: syncOffset, strong: false };
  }

  return null;
}

export function findMpegSync(bytes: Uint8Array, from: number, limit: number): number {
  const end = Math.min(bytes.length - 1, from + limit);
  for (let i = Math.max(0, from); i < end; i += 1) {
    if (isMpegFrameSync(bytes, i)) return i;
  }
  return -1;
}

export function indexOfAscii(bytes: Uint8Array, needle: string): number {
  outer: for (let i = 0; i + needle.length <= bytes.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

export function asciiSlice(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = offset; i < Math.min(bytes.length, offset + length); i += 1) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

const MIME_BY_FORMAT: Record<AudioFormat, readonly string[]> = {
  mp3: ['audio/mpeg', 'audio/mp3', 'audio/x-mpeg', 'audio/mpeg3'],
  wav: ['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'],
  aiff: ['audio/aiff', 'audio/x-aiff'],
  flac: ['audio/flac', 'audio/x-flac'],
  aac: ['audio/aac', 'audio/aacp', 'audio/x-aac'],
  m4a: ['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'video/mp4'],
  alac: ['audio/mp4', 'audio/x-m4a'],
  ogg: ['audio/ogg', 'application/ogg', 'audio/vorbis'],
  opus: ['audio/opus', 'audio/ogg'],
  unknown: [],
};

const EXTENSION_BY_FORMAT: Record<AudioFormat, readonly string[]> = {
  mp3: ['mp3'],
  wav: ['wav', 'wave'],
  aiff: ['aif', 'aiff', 'aifc'],
  flac: ['flac'],
  aac: ['aac', 'adts'],
  m4a: ['m4a', 'm4b', 'mp4'],
  alac: ['m4a', 'alac'],
  ogg: ['ogg', 'oga'],
  opus: ['opus', 'ogg'],
  unknown: [],
};

export function canonicalMimeFor(format: AudioFormat): string | null {
  return MIME_BY_FORMAT[format][0] ?? null;
}

export function mimeMatchesFormat(mime: string | null, format: AudioFormat): boolean {
  if (!mime) return false;
  const bare = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_BY_FORMAT[format].includes(bare);
}

export function extensionMatchesFormat(extension: string | null, format: AudioFormat): boolean {
  if (!extension) return false;
  return EXTENSION_BY_FORMAT[format].includes(extension.toLowerCase().replace(/^\./, ''));
}

export function formatForExtension(extension: string | null): AudioFormat {
  if (!extension) return 'unknown';
  const ext = extension.toLowerCase().replace(/^\./, '');
  for (const [format, list] of Object.entries(EXTENSION_BY_FORMAT) as [
    AudioFormat,
    readonly string[],
  ][]) {
    if (format !== 'unknown' && list.includes(ext)) return format;
  }
  return 'unknown';
}

export function extensionFromPath(pathname: string): string | null {
  const clean = pathname.split('?')[0]?.split('#')[0] ?? '';
  const base = clean.substring(clean.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,5}$/.test(ext) ? ext : null;
}
