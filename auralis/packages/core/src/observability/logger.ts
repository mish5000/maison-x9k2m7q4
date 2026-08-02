import type { ProviderLogger } from '../domain/provider.js';

/**
 * Structured logging with a hard redaction boundary.
 *
 * PRIVACY INVARIANT: the fields listed in `FORBIDDEN_FIELDS` are dropped before
 * a record is emitted, wherever they appear in the field object, and any string
 * value that looks like a credential or a signed URL is redacted. Search text is
 * only logged when `logQueryText` is explicitly enabled in configuration.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  readonly level: LogLevel;
  readonly time: string;
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

export type LogSink = (record: LogRecord) => void;

const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'password',
  'secret',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'apikey',
  'api_key',
  'sessionsecret',
  'session_secret',
  'credential',
  'credentials',
  'privatekey',
  'private_key',
  'signedurl',
  'signed_url',
  'clientsecret',
  'client_secret',
  'secretaccesskey',
  'secret_access_key',
]);

const SIGNED_URL_MARKERS = ['x-amz-signature=', 'signature=', 'token=', 'sig=', 'key-pair-id='];

export const REDACTED = '[redacted]';

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return REDACTED;
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (SIGNED_URL_MARKERS.some((marker) => lower.includes(marker))) {
      return redactUrl(value);
    }
    if (/^(bearer|basic)\s+\S+/i.test(value)) return REDACTED;
    return value.length > 2048 ? `${value.slice(0, 2048)}…` : value;
  }

  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_FIELDS.has(key.toLowerCase())) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = redactValue(item, depth + 1);
    }
    return out;
  }

  return value;
}

/** Keeps the origin and path of a URL but removes every query parameter. */
export function redactUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}${url.search.length > 0 ? '?[redacted]' : ''}`;
  } catch {
    return REDACTED;
  }
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly sink?: LogSink;
  readonly base?: Record<string, unknown>;
  /** Off by default. Enabling it is a deliberate, documented privacy choice. */
  readonly logQueryText?: boolean;
}

export class Logger {
  private readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly base: Record<string, unknown>;
  private readonly logQueryText: boolean;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.sink = options.sink ?? defaultSink;
    this.base = options.base ?? {};
    this.logQueryText = options.logQueryText ?? false;
  }

  child(fields: Record<string, unknown>): Logger {
    return new Logger({
      level: this.level,
      sink: this.sink,
      base: { ...this.base, ...fields },
      logQueryText: this.logQueryText,
    });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit('debug', message, fields);
  }
  info(message: string, fields?: Record<string, unknown>): void {
    this.emit('info', message, fields);
  }
  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit('warn', message, fields);
  }
  error(message: string, fields?: Record<string, unknown>): void {
    this.emit('error', message, fields);
  }

  /** Returns the query text only when query logging is explicitly enabled. */
  queryField(text: string): string {
    return this.logQueryText ? text : `[${text.length} characters]`;
  }

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const merged = { ...this.base, ...(fields ?? {}) };
    this.sink({
      level,
      time: new Date().toISOString(),
      message,
      fields: redactValue(merged) as Record<string, unknown>,
    });
  }
}

const defaultSink: LogSink = (record) => {
  const line = JSON.stringify({
    level: record.level,
    time: record.time,
    msg: record.message,
    ...record.fields,
  });
  if (record.level === 'error' || record.level === 'warn') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
};

/** Adapts a Logger to the narrower interface providers receive. */
export function providerLogger(logger: Logger, providerId: string): ProviderLogger {
  const scoped = logger.child({ providerId });
  return {
    debug: (message, fields) => scoped.debug(message, fields),
    info: (message, fields) => scoped.info(message, fields),
    warn: (message, fields) => scoped.warn(message, fields),
    error: (message, fields) => scoped.error(message, fields),
  };
}

export const silentLogger = new Logger({ level: 'error', sink: () => undefined });
