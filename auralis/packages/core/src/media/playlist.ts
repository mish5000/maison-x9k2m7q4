import type { PlaylistFormat } from '../domain/media.js';

/**
 * Playlist container handling.
 *
 * Auralis never presents a playlist as a playable audio file. A playlist is
 * only useful once its entries have been resolved and individually inspected,
 * and resolution is bounded to stop recursive or circular playlists.
 */

export const MAX_PLAYLIST_ENTRIES = 100;
export const MAX_PLAYLIST_DEPTH = 2;
export const MAX_PLAYLIST_BYTES = 512 * 1024;

export interface PlaylistEntry {
  readonly uri: string;
  readonly title: string | null;
  readonly durationSeconds: number | null;
}

export interface ParsedPlaylist {
  readonly format: PlaylistFormat;
  readonly entries: readonly PlaylistEntry[];
  readonly truncated: boolean;
  readonly warnings: readonly string[];
}

export function detectPlaylistFormat(
  text: string,
  extension: string | null,
): PlaylistFormat | null {
  const head = text.slice(0, 512).trimStart();
  const ext = extension?.toLowerCase() ?? null;

  if (head.startsWith('#EXTM3U')) return ext === 'm3u8' ? 'm3u8' : 'm3u';
  if (/^\[playlist\]/i.test(head)) return 'pls';
  if (/^(REM\s|PERFORMER\s|TITLE\s|FILE\s)/im.test(head)) return 'cue';
  if (ext === 'm3u' || ext === 'm3u8') return ext;
  if (ext === 'pls') return 'pls';
  if (ext === 'cue') return 'cue';
  return null;
}

export function parsePlaylist(
  text: string,
  format: PlaylistFormat,
  baseUrl: string | null,
): ParsedPlaylist {
  switch (format) {
    case 'm3u':
    case 'm3u8':
      return parseM3u(text, format, baseUrl);
    case 'pls':
      return parsePls(text, baseUrl);
    case 'cue':
      return parseCue(text, baseUrl);
    case 'rss_enclosure':
      return {
        format,
        entries: [],
        truncated: false,
        warnings: ['playlist:rss-handled-by-provider'],
      };
  }
}

function resolve(uri: string, baseUrl: string | null): string | null {
  const trimmed = uri.trim();
  if (trimmed.length === 0) return null;
  try {
    return baseUrl ? new URL(trimmed, baseUrl).toString() : new URL(trimmed).toString();
  } catch {
    return null;
  }
}

function parseM3u(text: string, format: PlaylistFormat, baseUrl: string | null): ParsedPlaylist {
  const entries: PlaylistEntry[] = [];
  const warnings: string[] = [];
  let pendingTitle: string | null = null;
  let pendingDuration: number | null = null;
  let truncated = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (line.startsWith('#')) {
      const extinf = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)\s*(?:,\s*(.*))?$/i.exec(line);
      if (extinf) {
        const seconds = Number(extinf[1]);
        pendingDuration = Number.isFinite(seconds) && seconds > 0 ? seconds : null;
        pendingTitle = extinf[2]?.trim() || null;
      } else if (/^#EXT-X-STREAM-INF/i.test(line)) {
        warnings.push('playlist:hls-variant-stream');
      }
      continue;
    }

    if (entries.length >= MAX_PLAYLIST_ENTRIES) {
      truncated = true;
      break;
    }

    const uri = resolve(line, baseUrl);
    if (uri) entries.push({ uri, title: pendingTitle, durationSeconds: pendingDuration });
    pendingTitle = null;
    pendingDuration = null;
  }

  return { format, entries, truncated, warnings };
}

function parsePls(text: string, baseUrl: string | null): ParsedPlaylist {
  const files = new Map<number, string>();
  const titles = new Map<number, string>();
  const lengths = new Map<number, number>();
  let truncated = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^(File|Title|Length)(\d+)\s*=\s*(.*)$/i.exec(line);
    if (!match) continue;
    const key = match[1]?.toLowerCase();
    const index = Number(match[2]);
    const value = match[3] ?? '';
    if (!Number.isSafeInteger(index) || index < 0) continue;
    if (files.size >= MAX_PLAYLIST_ENTRIES) {
      truncated = true;
      break;
    }
    if (key === 'file') files.set(index, value);
    else if (key === 'title') titles.set(index, value);
    else if (key === 'length') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) lengths.set(index, seconds);
    }
  }

  const entries: PlaylistEntry[] = [];
  for (const index of [...files.keys()].sort((a, b) => a - b)) {
    const uri = resolve(files.get(index) ?? '', baseUrl);
    if (uri) {
      entries.push({
        uri,
        title: titles.get(index)?.trim() || null,
        durationSeconds: lengths.get(index) ?? null,
      });
    }
  }

  return { format: 'pls', entries, truncated, warnings: [] };
}

function parseCue(text: string, baseUrl: string | null): ParsedPlaylist {
  const entries: PlaylistEntry[] = [];
  const warnings: string[] = ['playlist:cue-references-a-single-audio-file'];
  let truncated = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^\s*FILE\s+"?([^"]+)"?\s+\w+\s*$/i.exec(rawLine);
    if (!match?.[1]) continue;
    if (entries.length >= MAX_PLAYLIST_ENTRIES) {
      truncated = true;
      break;
    }
    const uri = resolve(match[1], baseUrl);
    if (uri) entries.push({ uri, title: null, durationSeconds: null });
  }

  return { format: 'cue', entries, truncated, warnings };
}

/**
 * Guards against playlists that reference themselves, directly or through a
 * chain. Callers pass the URLs already visited on the current branch.
 */
export function filterResolvableEntries(
  entries: readonly PlaylistEntry[],
  visited: ReadonlySet<string>,
): { readonly entries: readonly PlaylistEntry[]; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  const seen = new Set<string>();
  const out: PlaylistEntry[] = [];

  for (const entry of entries) {
    if (visited.has(entry.uri)) {
      warnings.push('playlist:circular-reference-skipped');
      continue;
    }
    if (seen.has(entry.uri)) continue;
    seen.add(entry.uri);
    out.push(entry);
  }

  return { entries: out, warnings: [...new Set(warnings)] };
}
