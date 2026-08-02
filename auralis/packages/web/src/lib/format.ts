/** Presentation helpers. Pure, locale-aware, and null-safe by design. */

const NUMBER = new Intl.NumberFormat(undefined);
const DATE = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const DATE_TIME = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Shown wherever a value is genuinely absent, so rows never look broken. */
export const NOT_AVAILABLE = 'Not available';

export function formatCount(value: number): string {
  return NUMBER.format(value);
}

export function formatDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

/** Spoken form used in screen-reader text, where `4:03` reads poorly. */
export function describeDuration(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const total = Math.round(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  if (minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  if (secs > 0 && hours === 0) parts.push(`${secs} second${secs === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(' ') : '0 seconds';
}

const BYTE_UNITS = ['bytes', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} bytes`;
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = value < 10 ? 1 : 0;
  return `${value.toFixed(decimals)} ${BYTE_UNITS[unit] ?? 'bytes'}`;
}

export function formatBitrate(bps: number | null): string | null {
  if (bps === null || !Number.isFinite(bps) || bps <= 0) {
    return null;
  }
  if (bps >= 1_000_000) {
    return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  }
  return `${Math.round(bps / 1000)} kbps`;
}

export function formatSampleRate(hz: number | null): string | null {
  if (hz === null || !Number.isFinite(hz) || hz <= 0) {
    return null;
  }
  const khz = hz / 1000;
  const text = Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(1);
  return `${text} kHz`;
}

export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return DATE.format(date);
}

export function formatDateTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return DATE_TIME.format(date);
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

/** Scores arrive on a 0-1 scale; people read 0-100 far more easily. */
export function formatScore(value: number): string {
  if (!Number.isFinite(value)) return NOT_AVAILABLE;
  const scaled = value <= 1 ? value * 100 : value;
  return String(Math.round(scaled));
}

export function formatChannels(channels: number | null, layout: string): string | null {
  const layoutLabel =
    layout === 'mono'
      ? 'Mono'
      : layout === 'stereo'
        ? 'Stereo'
        : layout === 'multichannel'
          ? 'Multichannel'
          : null;
  if (channels === null || channels <= 0) {
    return layoutLabel;
  }
  const channelText = `${channels} channel${channels === 1 ? '' : 's'}`;
  return layoutLabel ? `${channelText} · ${layoutLabel}` : channelText;
}

/** Uppercases a short technical token (`mp3` -> `MP3`) without mangling words. */
export function formatToken(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 5 ? value.toUpperCase() : value;
}

/** True when an ISO timestamp is in the past. Unparseable input is not expired. */
export function isExpired(iso: string | null): boolean {
  if (!iso) return false;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() <= Date.now();
}

/** Trims a filename for display without hiding the extension. */
export function truncateMiddle(value: string, max = 64): string {
  if (value.length <= max) return value;
  const head = Math.ceil((max - 1) / 2);
  const tail = Math.floor((max - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
