import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signSession } from '../src/crypto/secrets.js';
import { ACCESS_COOKIE, ACCESS_PATH } from '../src/http/access-gate.js';
import { createHarness, type Harness } from '../src/testing/harness.js';

/**
 * The private-instance gate.
 *
 * A deployment on a public hostname is reachable by anyone who knows the
 * address, so "unlisted" is not access control. These tests assert the gate
 * actually closes: no route, no static asset and no API response is reachable
 * without it, and the health check stays open so a platform can still probe the
 * process.
 */

const PASSWORD = 'a-long-enough-test-password';
const SESSION_SECRET = 'test-session-secret-that-is-long-enough-32';

let locked: Harness;
let open: Harness;

/** Injects without the harness's stored cookie, so each case starts locked. */
async function raw(
  harness: Harness,
  options: {
    method?: 'GET' | 'POST';
    url: string;
    cookie?: string;
    form?: string;
  },
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const response = await harness.app.inject({
    method: options.method ?? 'GET',
    url: options.url,
    headers: {
      'x-auralis-csrf': '1',
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(options.form ? { payload: options.form } : {}),
  });
  return {
    status: response.statusCode,
    body: response.body,
    headers: response.headers as Record<string, unknown>,
  };
}

function cookieFrom(headers: Record<string, unknown>): string | null {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return null;
  const value = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  return value?.split(';')[0] ?? null;
}

beforeAll(async () => {
  locked = await createHarness({
    configOverrides: {
      AURALIS_ACCESS_PASSWORD: PASSWORD,
      AURALIS_SESSION_SECRET: SESSION_SECRET,
    },
  });
  open = await createHarness();
}, 90_000);

afterAll(async () => {
  await locked?.close();
  await open?.close();
});

describe('when no password is configured', () => {
  it('installs no gate at all, so behaviour is unchanged', async () => {
    const response = await raw(open, { url: '/api/v1/providers' });
    expect(response.status).toBe(200);
  });
});

describe('when a password is configured', () => {
  it('refuses an unauthenticated page request with the unlock form', async () => {
    const response = await raw(locked, { url: '/' });
    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('This instance is private.');
    expect(response.body).toContain(ACCESS_PATH);
  });

  it('refuses an unauthenticated API request with JSON, not the form', async () => {
    const response = await raw(locked, { url: '/api/v1/providers' });
    expect(response.status).toBe(401);
    expect(response.body).not.toContain('<html');
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'unauthorized' } });
  });

  it('never reveals the password in the unlock page', async () => {
    const response = await raw(locked, { url: '/' });
    expect(response.body).not.toContain(PASSWORD);
  });

  it('leaves the health check open so a platform can probe it', async () => {
    const response = await raw(locked, { url: '/health' });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({ status: 'ok' });
  });

  it('rejects a wrong password without setting a cookie', async () => {
    const response = await raw(locked, {
      method: 'POST',
      url: ACCESS_PATH,
      form: 'password=not-the-password',
    });
    expect(response.status).toBe(401);
    expect(cookieFrom(response.headers)).toBeNull();
    expect(response.body).toContain('That password was not correct.');
  });

  it('rejects an empty password', async () => {
    const response = await raw(locked, {
      method: 'POST',
      url: ACCESS_PATH,
      form: 'password=',
    });
    expect(response.status).toBe(401);
    expect(cookieFrom(response.headers)).toBeNull();
  });

  it('accepts the right password and then allows the API through', async () => {
    const unlock = await raw(locked, {
      method: 'POST',
      url: ACCESS_PATH,
      form: `password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(unlock.status).toBe(303);

    const cookie = cookieFrom(unlock.headers);
    expect(cookie).not.toBeNull();
    expect(cookie).toContain(ACCESS_COOKIE);

    const allowed = await raw(locked, { url: '/api/v1/providers', cookie: cookie! });
    expect(allowed.status).toBe(200);
  });

  it('refuses a forged cookie', async () => {
    const response = await raw(locked, {
      url: '/api/v1/providers',
      cookie: `${ACCESS_COOKIE}=not-a-signed-value`,
    });
    expect(response.status).toBe(401);
  });

  it('refuses a correctly signed cookie carrying the wrong value', async () => {
    // Signed with the real secret, so only the derived value rejects it. This
    // is the case a signature check alone would let through.
    const forged = signSession('0'.repeat(32), SESSION_SECRET);
    const response = await raw(locked, {
      url: '/api/v1/providers',
      cookie: `${ACCESS_COOKIE}=${forged}`,
    });
    expect(response.status).toBe(401);
  });

  it('refuses a cookie signed with a different secret', async () => {
    const forged = signSession('0'.repeat(32), 'a-completely-different-secret-value-here');
    const response = await raw(locked, {
      url: '/api/v1/providers',
      cookie: `${ACCESS_COOKIE}=${forged}`,
    });
    expect(response.status).toBe(401);
  });

  it('throttles repeated failures', async () => {
    // The gate tolerates a bounded number of failures per minute and then
    // refuses every attempt, including a correct one, until the window passes.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await raw(locked, { method: 'POST', url: ACCESS_PATH, form: 'password=wrong' });
    }

    const correct = await raw(locked, {
      method: 'POST',
      url: ACCESS_PATH,
      form: `password=${encodeURIComponent(PASSWORD)}`,
    });
    expect(correct.status).toBe(401);
    expect(cookieFrom(correct.headers)).toBeNull();
  }, 30_000);
});
