import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { signSession, verifySession } from '../crypto/secrets.js';

/**
 * Optional single-password gate for a private deployment.
 *
 * Auralis has no accounts by design — a workspace is bound to an anonymous
 * signed cookie. That is right for a local or shared install, and wrong for one
 * person's instance on a public hostname, where "nobody knows the URL" is not
 * access control.
 *
 * When `AURALIS_ACCESS_PASSWORD` is set, every request except the health check
 * must carry a valid gate cookie. Unauthenticated browsers get a plain form;
 * unauthenticated API calls get 401 and nothing else. When it is unset the gate
 * is not installed at all, so the default behaviour is unchanged.
 *
 * This is deliberately one shared password, not a user system. It answers "only
 * I can reach this", which is the actual requirement. It is not a multi-user
 * authentication scheme and must not be presented as one.
 */

export const ACCESS_COOKIE = 'auralis_access';
export const ACCESS_PATH = '/__access';

/** A month. The gate is for convenience of access, not a short-lived session. */
const ACCESS_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** Failed attempts tolerated in a window before every attempt is refused. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 60_000;
/** Constant delay on failure, so a wrong password is never the fast path. */
const FAILURE_DELAY_MS = 400;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/**
 * Compares two secrets without leaking length or position through timing.
 * Both sides are hashed first, so the buffers are always 32 bytes and
 * `timingSafeEqual` cannot throw on a length mismatch.
 */
function secretsMatch(submitted: string, expected: string): boolean {
  return timingSafeEqual(digest(submitted), digest(expected));
}

/**
 * The cookie payload is derived from the password, so changing the password
 * invalidates every cookie already issued. Only the derived value is stored;
 * the password itself never enters a cookie, a log or the database.
 */
function cookieValue(password: string): string {
  return digest(password).toString('hex').slice(0, 32);
}

export interface AccessGateOptions {
  readonly password: string;
  readonly secret: string;
  readonly secureCookies: boolean;
}

export class AccessGate {
  readonly #options: AccessGateOptions;
  readonly #expected: string;
  #failures: number[] = [];

  constructor(options: AccessGateOptions) {
    this.#options = options;
    this.#expected = cookieValue(options.password);
  }

  /** True when the request already carries a valid gate cookie. */
  isUnlocked(request: FastifyRequest): boolean {
    const raw = request.cookies?.[ACCESS_COOKIE];
    if (raw === undefined) return false;
    const value = verifySession(raw, this.#options.secret);
    if (value === null) return false;
    // Constant-time, and re-derived rather than trusted from the cookie.
    return timingSafeEqual(Buffer.from(value, 'utf8'), Buffer.from(this.#expected, 'utf8'));
  }

  #throttled(): boolean {
    const now = Date.now();
    this.#failures = this.#failures.filter((at) => now - at < FAILURE_WINDOW_MS);
    return this.#failures.length >= MAX_FAILURES;
  }

  #recordFailure(): void {
    this.#failures.push(Date.now());
  }

  /**
   * Handles a submitted password. Returns true when the cookie was set.
   * Never reports whether the failure was a wrong password or a throttle —
   * both produce the same message.
   */
  async submit(password: string, reply: FastifyReply): Promise<boolean> {
    if (this.#throttled()) {
      await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
      return false;
    }

    if (typeof password !== 'string' || password.length === 0) {
      this.#recordFailure();
      await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
      return false;
    }

    if (!secretsMatch(password, this.#options.password)) {
      this.#recordFailure();
      await new Promise((resolve) => setTimeout(resolve, FAILURE_DELAY_MS));
      return false;
    }

    reply.setCookie(ACCESS_COOKIE, signSession(this.#expected, this.#options.secret), {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.#options.secureCookies,
      path: '/',
      maxAge: ACCESS_MAX_AGE_SECONDS,
    });
    return true;
  }
}

/**
 * The unlock page. No script, no external resource, no framework — it has to
 * work before anything else on the origin is reachable. The only inline style
 * is permitted by the existing `style-src 'unsafe-inline'` directive, and the
 * form posts same-origin, which `form-action 'self'` permits.
 */
export function unlockPage(failed: boolean): string {
  const error = failed
    ? '<p class="error" role="alert">That password was not correct.</p>'
    : '<p class="hint">This instance is private.</p>';

  return [
    '<!doctype html>',
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    '<title>Auralis</title>',
    '<style>',
    ':root{color-scheme:dark}',
    'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
    'background:#0b0b0c;color:#f2f0ed;',
    'font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}',
    'main{width:100%;max-width:22rem;padding:2rem 1.5rem}',
    'h1{font-size:1.5rem;letter-spacing:-0.02em;margin:0 0 0.5rem}',
    '.hint,.error{font-size:0.875rem;margin:0 0 1.5rem}',
    '.hint{color:#8e8983}',
    '.error{color:#e4746b}',
    'label{display:block;font-size:0.8125rem;color:#b4afa8;margin-bottom:0.5rem}',
    'input{width:100%;box-sizing:border-box;min-height:44px;padding:0 0.75rem;',
    'background:#141416;color:#f2f0ed;border:1px solid rgba(242,240,237,0.38);',
    'border-radius:10px;font-size:1rem}',
    'input:focus-visible,button:focus-visible{outline:2px solid #d08a4e;outline-offset:2px}',
    'button{width:100%;min-height:44px;margin-top:1rem;border:0;border-radius:10px;',
    'background:#d08a4e;color:#0b0b0c;font-size:0.9375rem;font-weight:500;cursor:pointer}',
    '</style>',
    '</head><body><main>',
    '<h1>Auralis</h1>',
    error,
    `<form method="post" action="${ACCESS_PATH}">`,
    '<label for="password">Password</label>',
    '<input id="password" name="password" type="password" autocomplete="current-password" ',
    'autofocus required>',
    '<button type="submit">Unlock</button>',
    '</form>',
    '</main></body></html>',
  ].join('');
}
