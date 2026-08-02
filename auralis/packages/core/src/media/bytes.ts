/** Bounds-checked byte reading helpers used by every media parser. */

export class ByteReader {
  private readonly view: DataView;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get length(): number {
    return this.bytes.length;
  }

  has(offset: number, size: number): boolean {
    return offset >= 0 && offset + size <= this.bytes.length;
  }

  u8(offset: number): number | null {
    return this.has(offset, 1) ? this.view.getUint8(offset) : null;
  }

  u16be(offset: number): number | null {
    return this.has(offset, 2) ? this.view.getUint16(offset, false) : null;
  }

  u16le(offset: number): number | null {
    return this.has(offset, 2) ? this.view.getUint16(offset, true) : null;
  }

  u32be(offset: number): number | null {
    return this.has(offset, 4) ? this.view.getUint32(offset, false) : null;
  }

  u32le(offset: number): number | null {
    return this.has(offset, 4) ? this.view.getUint32(offset, true) : null;
  }

  u64be(offset: number): number | null {
    if (!this.has(offset, 8)) return null;
    const value = this.view.getBigUint64(offset, false);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }

  u64le(offset: number): number | null {
    if (!this.has(offset, 8)) return null;
    const value = this.view.getBigUint64(offset, true);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
  }

  ascii(offset: number, length: number): string | null {
    if (!this.has(offset, length)) return null;
    let out = '';
    for (let i = 0; i < length; i += 1) out += String.fromCharCode(this.bytes[offset + i] ?? 0);
    return out;
  }

  slice(offset: number, length: number): Uint8Array | null {
    if (!this.has(offset, length)) return null;
    return this.bytes.subarray(offset, offset + length);
  }

  /** Reads `count` bits starting at an absolute bit offset. Max 32 bits. */
  bits(bitOffset: number, count: number): number | null {
    if (count > 32 || count < 1) return null;
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const absolute = bitOffset + i;
      const byte = this.bytes[absolute >> 3];
      if (byte === undefined) return null;
      const bit = (byte >> (7 - (absolute & 7))) & 1;
      value = value * 2 + bit;
    }
    return value;
  }
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: false });
const UTF16_DECODER = new TextDecoder('utf-16le', { fatal: false });
const UTF16BE_DECODER = new TextDecoder('utf-16be', { fatal: false });
const LATIN1_DECODER = new TextDecoder('latin1', { fatal: false });

export function decodeText(
  bytes: Uint8Array,
  encoding: 'utf8' | 'utf16' | 'utf16be' | 'latin1',
): string {
  switch (encoding) {
    case 'utf8':
      return UTF8_DECODER.decode(bytes);
    case 'utf16': {
      if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return UTF16_DECODER.decode(bytes.subarray(2));
      }
      if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return UTF16BE_DECODER.decode(bytes.subarray(2));
      }
      return UTF16_DECODER.decode(bytes);
    }
    case 'utf16be':
      return UTF16BE_DECODER.decode(bytes);
    case 'latin1':
      return LATIN1_DECODER.decode(bytes);
  }
}

/**
 * Trims NUL padding and control characters from tag strings. Media tags are
 * untrusted input and are the classic vector for injecting markup into a UI.
 */
export function cleanTagString(value: string | null | undefined, maxLength = 512): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex -- stripping control bytes from untrusted tags
  const stripped = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  if (stripped.length === 0) return null;
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
}

export function parseIntOrNull(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = /^\s*(\d{1,10})/.exec(value);
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseFloatOrNull(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const match = /^\s*([+-]?\d+(?:\.\d+)?)/.exec(value);
  if (!match?.[1]) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}
