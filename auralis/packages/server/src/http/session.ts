import { AuralisError } from '@auralis/core';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { WorkspaceRepository } from '../db/repositories.js';
import { signSession, verifySession } from '../crypto/secrets.js';

/**
 * Anonymous workspace sessions.
 *
 * Auralis asks for no account. On first request a workspace and user are
 * created and bound to a signed, HttpOnly cookie. That gives connectors a
 * tenant to belong to and gives search history somewhere to live, without
 * collecting an identity. See docs/adr/0006-anonymous-workspace-session-model.md
 */

export const SESSION_COOKIE = 'auralis_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

export interface SessionContext {
  readonly workspaceId: string;
  readonly userId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionContext;
  }
}

export interface SessionOptions {
  readonly workspaces: WorkspaceRepository;
  readonly secret: string;
  readonly secureCookies: boolean;
}

export function resolveSession(
  request: FastifyRequest,
  reply: FastifyReply,
  options: SessionOptions,
): SessionContext {
  if (request.session) return request.session;

  const raw = request.cookies?.[SESSION_COOKIE];
  if (typeof raw === 'string' && raw.length > 0) {
    const userId = verifySession(raw, options.secret);
    if (userId) {
      const existing = options.workspaces.findByUserId(userId);
      if (existing) {
        options.workspaces.touch(userId);
        request.session = existing;
        return existing;
      }
    }
  }

  const created = options.workspaces.create();
  reply.setCookie(SESSION_COOKIE, signSession(created.userId, options.secret), {
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secureCookies,
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  request.session = created;
  return created;
}

/**
 * CSRF protection for state-changing requests.
 *
 * The session cookie is `SameSite=Lax`, which already blocks cross-site form
 * posts. This adds a required custom header, which a cross-origin form cannot
 * set without a successful CORS preflight — so a simple-request forgery fails.
 */
export const CSRF_HEADER = 'x-auralis-csrf';

export function assertCsrf(request: FastifyRequest): void {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const header = request.headers[CSRF_HEADER];
  if (typeof header !== 'string' || header.length === 0) {
    throw new AuralisError(
      'forbidden',
      'That request could not be verified. Reload the page and try again.',
    );
  }
}
