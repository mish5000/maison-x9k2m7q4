import { connect, type Socket } from 'node:net';

import { AuralisError } from '../domain/errors.js';
import { classifyIp } from './ip-rules.js';
import {
  defaultResolver,
  literalAddressOf,
  normaliseHostname,
  UnsafeUrlError,
  type DnsResolver,
  type UrlSafetyPolicy,
} from './url-safety.js';

/**
 * A minimal, standards-compliant FTP client covering exactly what a directory
 * adapter needs: login, PASV, MLSD (with a LIST fallback), and SIZE.
 *
 * Written in-house so the same security posture as the HTTP egress applies:
 * the control connection target is validated by the URL safety service, and the
 * data connection address returned by PASV is re-classified before it is used —
 * a server cannot use a PASV reply to point Auralis at an internal host.
 */

const CRLF = '\r\n';
const MAX_LINE_BYTES = 8 * 1024;
const MAX_LISTING_BYTES = 2 * 1024 * 1024;

export interface FtpEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  readonly sizeBytes: number | null;
  readonly modifiedAt: string | null;
}

export interface FtpClientOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly policy: UrlSafetyPolicy;
  readonly resolver?: DnsResolver;
  readonly signal?: AbortSignal;
}

interface FtpReply {
  readonly code: number;
  readonly text: string;
}

export class FtpClient {
  private socket: Socket | null = null;
  private buffer = '';
  private pending: ((reply: FtpReply) => void) | null = null;
  private failPending: ((error: Error) => void) | null = null;

  private constructor(private readonly options: FtpClientOptions) {}

  static async connect(options: FtpClientOptions): Promise<FtpClient> {
    // FTP is not an HTTP scheme, so the control host is resolved and classified
    // directly rather than through assertUrlAllowed — but with the same rules.
    const address = await resolveAllowedHost(options);
    const client = new FtpClient(options);
    await client.open(address);
    return client;
  }

  private async open(address: string): Promise<void> {
    this.socket = await new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: address, port: this.options.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new AuralisError('timeout', 'That server did not respond in time.'));
      }, this.options.connectTimeoutMs);

      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        reject(new AuralisError('provider_unavailable', 'That server could not be reached.'));
      });
    });

    this.socket.setEncoding('utf8');
    this.socket.on('data', (chunk: string) => this.onData(chunk));
    this.socket.on('error', () =>
      this.failPending?.(new AuralisError('provider_unavailable', 'The connection failed.')),
    );
    this.socket.on('close', () =>
      this.failPending?.(new AuralisError('provider_unavailable', 'The connection closed.')),
    );

    await this.expect([220]);
    const userReply = await this.command(`USER ${this.options.user}`);
    if (userReply.code === 331) {
      const passReply = await this.command(`PASS ${this.options.password}`);
      if (passReply.code !== 230 && passReply.code !== 202) {
        throw new AuralisError('unauthenticated', 'The server rejected those credentials.');
      }
    } else if (userReply.code !== 230) {
      throw new AuralisError('unauthenticated', 'The server rejected those credentials.');
    }

    await this.command('TYPE I');
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_LINE_BYTES * 4) {
      this.buffer = this.buffer.slice(-MAX_LINE_BYTES);
    }
    const reply = extractReply(this.buffer);
    if (reply) {
      this.buffer = reply.rest;
      const resolve = this.pending;
      this.pending = null;
      this.failPending = null;
      resolve?.({ code: reply.code, text: reply.text });
    }
  }

  private async expect(codes: readonly number[]): Promise<FtpReply> {
    const reply = await this.awaitReply();
    if (!codes.includes(reply.code)) {
      throw new AuralisError('provider_unavailable', 'The server returned an unexpected response.');
    }
    return reply;
  }

  private awaitReply(): Promise<FtpReply> {
    return new Promise<FtpReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        this.failPending = null;
        reject(new AuralisError('timeout', 'The server did not respond in time.'));
      }, this.options.commandTimeoutMs);

      this.pending = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      this.failPending = (error) => {
        clearTimeout(timer);
        reject(error);
      };

      // A complete reply may already be buffered from a previous chunk.
      const buffered = extractReply(this.buffer);
      if (buffered) {
        this.buffer = buffered.rest;
        this.pending = null;
        this.failPending = null;
        clearTimeout(timer);
        resolve({ code: buffered.code, text: buffered.text });
      }
    });
  }

  async command(line: string): Promise<FtpReply> {
    if (!this.socket) throw new AuralisError('provider_unavailable', 'Not connected.');
    if (this.options.signal?.aborted)
      throw new AuralisError('cancelled', 'The search was cancelled.');
    // A command containing CR or LF would let a caller inject extra commands.
    if (/[\r\n]/.test(line)) {
      throw new AuralisError('invalid_request', 'That command is not valid.');
    }
    this.socket.write(line + CRLF);
    return await this.awaitReply();
  }

  /** Opens a passive data connection, re-validating the address the server gives. */
  private async openDataConnection(): Promise<Socket> {
    const reply = await this.command('PASV');
    if (reply.code !== 227) {
      throw new AuralisError('provider_unavailable', 'The server refused a data connection.');
    }
    const target = parsePasvReply(reply.text);
    if (!target) {
      throw new AuralisError('provider_unavailable', 'The server sent an invalid data address.');
    }

    // SECURITY: the address in a PASV reply is attacker-controlled. Classify it
    // exactly as strictly as any other outbound target.
    if (!this.options.policy.allowPrivateAddresses) {
      const verdict = classifyIp(target.host);
      if (verdict.disposition === 'blocked') {
        throw new UnsafeUrlError({
          rule: `ftp-pasv:${verdict.rule}`,
          message: 'That server tried to redirect the transfer to a private address.',
        });
      }
    }

    return await new Promise<Socket>((resolve, reject) => {
      const socket = connect({ host: target.host, port: target.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new AuralisError('timeout', 'The data connection timed out.'));
      }, this.options.connectTimeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        reject(new AuralisError('provider_unavailable', 'The data connection failed.'));
      });
    });
  }

  /** Lists a directory, preferring MLSD and falling back to LIST. */
  async list(path: string): Promise<readonly FtpEntry[]> {
    const dataSocket = await this.openDataConnection();
    const collect = collectData(dataSocket, this.options.commandTimeoutMs);

    let usedMlsd = true;
    let reply = await this.command(`MLSD ${path}`);
    if (reply.code >= 500) {
      usedMlsd = false;
      dataSocket.destroy();
      const retrySocket = await this.openDataConnection();
      const retryCollect = collectData(retrySocket, this.options.commandTimeoutMs);
      reply = await this.command(`LIST ${path}`);
      if (reply.code >= 400) {
        retrySocket.destroy();
        return [];
      }
      const text = await retryCollect;
      await this.awaitReply().catch(() => undefined);
      return parseListOutput(text);
    }

    if (reply.code >= 400) {
      dataSocket.destroy();
      return [];
    }

    const text = await collect;
    // The transfer-complete reply follows the data connection closing.
    await this.awaitReply().catch(() => undefined);
    return usedMlsd ? parseMlsdOutput(text) : parseListOutput(text);
  }

  async size(path: string): Promise<number | null> {
    const reply = await this.command(`SIZE ${path}`);
    if (reply.code !== 213) return null;
    const value = Number.parseInt(reply.text.replace(/^\d+\s*/, ''), 10);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  async close(): Promise<void> {
    try {
      if (this.socket && !this.socket.destroyed) {
        this.socket.write(`QUIT${CRLF}`);
      }
    } catch {
      // Closing is best-effort.
    }
    this.socket?.destroy();
    this.socket = null;
  }
}

/**
 * Resolves the FTP control host and returns an address that passed
 * classification. Rejects the whole host when any of its addresses is internal.
 */
async function resolveAllowedHost(options: FtpClientOptions): Promise<string> {
  const hostname = normaliseHostname(options.host);
  if (hostname.length === 0) {
    throw new UnsafeUrlError({ rule: 'ftp:no-host', message: 'That server address is not valid.' });
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new UnsafeUrlError({ rule: 'ftp:port', message: 'That server port is not valid.' });
  }

  const literal = literalAddressOf(hostname);
  const addresses = literal
    ? [{ address: literal, family: literal.includes(':') ? (6 as const) : (4 as const) }]
    : await (options.resolver ?? defaultResolver)(hostname).catch(() => {
        throw new UnsafeUrlError({
          rule: 'dns:resolution-failed',
          message: 'That server could not be reached.',
        });
      });

  if (addresses.length === 0) {
    throw new UnsafeUrlError({
      rule: 'dns:no-records',
      message: 'That server could not be reached.',
    });
  }

  if (!options.policy.allowPrivateAddresses) {
    for (const record of addresses) {
      const verdict = classifyIp(record.address);
      if (verdict.disposition === 'blocked') {
        throw new UnsafeUrlError({
          rule: `ip:${verdict.rule}`,
          message: 'That server resolves to a private network address.',
        });
      }
    }
  }

  const first = addresses[0];
  if (!first) {
    throw new UnsafeUrlError({
      rule: 'dns:no-records',
      message: 'That server could not be reached.',
    });
  }
  return first.address;
}

function collectData(socket: Socket, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }, timeoutMs);

    socket.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_LISTING_BYTES) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
    });
    const finish = (): void => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    socket.on('end', finish);
    socket.on('close', finish);
    socket.on('error', finish);
  });
}

interface ExtractedReply {
  readonly code: number;
  readonly text: string;
  readonly rest: string;
}

/** Pulls one complete reply (including multi-line replies) off the buffer. */
export function extractReply(buffer: string): ExtractedReply | null {
  const lines = buffer.split(CRLF);
  if (lines.length < 2) return null;

  const firstLine = lines[0];
  if (!firstLine) return null;
  const start = /^(\d{3})([ -])/.exec(firstLine);
  if (!start?.[1]) return null;

  const code = Number(start[1]);
  if (start[2] === ' ') {
    return { code, text: firstLine, rest: lines.slice(1).join(CRLF) };
  }

  // Multi-line: read until a line beginning with the same code and a space.
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) return null;
    if (new RegExp(`^${code} `).test(line)) {
      return {
        code,
        text: lines.slice(0, i + 1).join(' '),
        rest: lines.slice(i + 1).join(CRLF),
      };
    }
  }
  return null;
}

export function parsePasvReply(
  text: string,
): { readonly host: string; readonly port: number } | null {
  const match = /\((\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3})\)/.exec(text);
  if (!match) return null;
  const parts = match.slice(1, 7).map((value) => Number(value));
  if (parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
  const port = (parts[4] ?? 0) * 256 + (parts[5] ?? 0);
  if (port <= 0 || port > 65535) return null;
  return { host: parts.slice(0, 4).join('.'), port };
}

/** Parses MLSD output: `fact=value;fact=value; name`. */
export function parseMlsdOutput(text: string): readonly FtpEntry[] {
  const entries: FtpEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const separator = line.indexOf(' ');
    if (separator < 0) continue;
    const facts = line.slice(0, separator);
    const name = line.slice(separator + 1).trim();
    if (name.length === 0 || name === '.' || name === '..') continue;

    const parsed = new Map<string, string>();
    for (const fact of facts.split(';')) {
      const eq = fact.indexOf('=');
      if (eq > 0) parsed.set(fact.slice(0, eq).toLowerCase(), fact.slice(eq + 1));
    }

    const type = parsed.get('type') ?? '';
    if (type === 'cdir' || type === 'pdir') continue;
    const size = Number.parseInt(parsed.get('size') ?? '', 10);

    entries.push({
      name,
      isDirectory: type === 'dir',
      sizeBytes: Number.isSafeInteger(size) ? size : null,
      modifiedAt: parseMlsdTimestamp(parsed.get('modify')),
    });
  }
  return entries;
}

function parseMlsdTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Parses Unix-style LIST output. */
export function parseListOutput(text: string): readonly FtpEntry[] {
  const entries: FtpEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const match =
      /^([dlrwxsSt-]{10})\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d{1,2}\s+(?:\d{4}|\d{2}:\d{2}))\s+(.+)$/.exec(
        line,
      );
    if (!match) continue;
    const permissions = match[1] ?? '';
    const name = (match[4] ?? '').trim();
    if (name.length === 0 || name === '.' || name === '..') continue;
    const size = Number.parseInt(match[2] ?? '', 10);
    entries.push({
      name: name.split(' -> ')[0] ?? name,
      isDirectory: permissions.startsWith('d'),
      sizeBytes: Number.isSafeInteger(size) ? size : null,
      modifiedAt: null,
    });
  }
  return entries;
}
