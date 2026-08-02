/**
 * Filename sanitisation for downloads.
 *
 * SECURITY INVARIANT: every filename that reaches a Content-Disposition header
 * or a filesystem path passes through `sanitiseFilename`. It defends against
 * path traversal, header injection, and executable-extension confusion.
 */

const MAX_BASE_LENGTH = 120;

/** Extensions that must never be produced, whatever the source claimed. */
const DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe',
  'com',
  'bat',
  'cmd',
  'sh',
  'bash',
  'zsh',
  'ps1',
  'msi',
  'scr',
  'dll',
  'so',
  'dylib',
  'app',
  'jar',
  'js',
  'mjs',
  'vbs',
  'php',
  'py',
  'rb',
  'pl',
  'html',
  'htm',
  'svg',
  'lnk',
]);

/** Names Windows refuses to treat as ordinary files. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

export interface SanitisedFilename {
  readonly filename: string;
  /** ASCII-only fallback for the legacy `filename=` parameter. */
  readonly asciiFilename: string;
  readonly changed: boolean;
}

export function sanitiseFilename(
  rawName: string | null | undefined,
  fallbackExtension: string | null,
): SanitisedFilename {
  const fallbackBase = 'audio';
  const safeExtension = normaliseExtension(fallbackExtension);

  let working = typeof rawName === 'string' ? rawName : '';

  // Strip any directory component; a filename never contains a path.
  working = working.replace(/\\/g, '/');
  working = working.substring(working.lastIndexOf('/') + 1);

  // Remove control characters, quotes, semicolons and other header-breaking bytes.
  // eslint-disable-next-line no-control-regex -- deliberately removing control bytes
  working = working.replace(/[\u0000-\u001f\u007f"'`;\\|<>*?:]/g, '');
  working = working.replace(/\s+/g, ' ').trim();

  // Leading dots hide files and enable `..` traversal patterns.
  working = working.replace(/^[.\s]+/, '');

  let base = working;
  let extension = safeExtension;

  const dot = working.lastIndexOf('.');
  if (dot > 0 && dot < working.length - 1) {
    const candidate = working.slice(dot + 1).toLowerCase();
    if (/^[a-z0-9]{1,5}$/.test(candidate) && !DANGEROUS_EXTENSIONS.has(candidate)) {
      base = working.slice(0, dot);
      extension = candidate;
    } else {
      base = working.slice(0, dot);
    }
  }

  base = base.trim().slice(0, MAX_BASE_LENGTH).trim();
  if (base.length === 0 || RESERVED_NAMES.has(base.toLowerCase())) base = fallbackBase;

  const filename = extension ? `${base}.${extension}` : base;
  const asciiBase = base
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  const asciiFilename = extension
    ? `${asciiBase.length > 0 ? asciiBase : fallbackBase}.${extension}`
    : asciiBase.length > 0
      ? asciiBase
      : fallbackBase;

  return {
    filename,
    asciiFilename,
    changed: filename !== (rawName ?? ''),
  };
}

function normaliseExtension(extension: string | null): string | null {
  if (!extension) return null;
  const clean = extension.toLowerCase().replace(/^\./, '');
  if (!/^[a-z0-9]{1,5}$/.test(clean)) return null;
  if (DANGEROUS_EXTENSIONS.has(clean)) return null;
  return clean;
}

/** Builds a Content-Disposition value that cannot be used to inject headers. */
export function contentDispositionAttachment(name: SanitisedFilename): string {
  const encoded = encodeURIComponent(name.filename);
  return `attachment; filename="${name.asciiFilename.replace(/"/g, '')}"; filename*=UTF-8''${encoded}`;
}

/** Derives a display filename from a URL path when the source supplies none. */
export function filenameFromUrl(rawUrl: string | null): string | null {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const segment = decodeURIComponent(url.pathname.substring(url.pathname.lastIndexOf('/') + 1));
    return segment.length > 0 ? segment : null;
  } catch {
    return null;
  }
}
