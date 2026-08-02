import {
  API_BASE_PATH,
  AuralisError,
  createSearchRequestSchema,
  downloadIntentRequestSchema,
  type SearchEvent,
} from '@auralis/core';
import type { FastifyInstance } from 'fastify';

import type { RouteContext } from '../app.js';
import { resolveSession } from '../http/session.js';

/**
 * Search routes.
 *
 * The event stream uses Server-Sent Events: results arrive over one long-lived
 * response, reconnection is handled by the browser, and `Last-Event-ID` gives
 * exactly-once replay without a bespoke protocol. The reasoning is recorded in
 * docs/adr/0005-sse-for-progressive-results.md.
 */

const SSE_HEARTBEAT_MS = 15_000;

export async function registerSearchRoutes(
  app: FastifyInstance,
  context: RouteContext,
): Promise<void> {
  const sessionOptions = {
    workspaces: context.workspaces,
    secret: context.config.sessionSecret,
    secureCookies: context.config.isProduction,
  };

  app.post(`${API_BASE_PATH}/searches`, async (request, reply) => {
    const session = resolveSession(request, reply, sessionOptions);
    context.searchLimiter.assertWithinLimit(session.workspaceId, 'search');

    const parsed = createSearchRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AuralisError('invalid_request', firstIssueMessage(parsed.error.issues));
    }

    const response = context.searchService.create({
      workspaceId: session.workspaceId,
      userId: session.userId,
      query: parsed.data.query,
      mode: parsed.data.mode,
      filters: parsed.data.filters,
      locale: parsed.data.locale,
      compatibilityProfileIds: parsed.data.compatibilityProfileIds,
    });

    void reply.status(201);
    return response;
  });

  app.get<{ Params: { searchId: string } }>(
    `${API_BASE_PATH}/searches/:searchId`,
    async (request, reply) => {
      const session = resolveSession(request, reply, sessionOptions);
      const status = context.searchService.status(request.params.searchId, session.workspaceId);
      const results = context.searchService.results(request.params.searchId, session.workspaceId);
      return { ...status, results };
    },
  );

  app.get<{ Params: { searchId: string } }>(
    `${API_BASE_PATH}/searches/:searchId/events`,
    async (request, reply) => {
      const session = resolveSession(request, reply, sessionOptions);
      const lastEventId = Number.parseInt(String(request.headers['last-event-id'] ?? '0'), 10);
      const afterSeq = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0;

      const stream = reply.raw;
      let closed = false;
      // Events that arrive during subscription are buffered until the response
      // head has been written, so nothing is emitted before the headers.
      let streaming = false;
      const pending: SearchEvent[] = [];

      const send = (event: SearchEvent): void => {
        try {
          stream.write(
            `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          );
        } catch {
          closed = true;
        }
      };

      const write = (event: SearchEvent): void => {
        if (closed) return;
        if (!streaming) {
          pending.push(event);
          return;
        }
        send(event);
      };

      // Subscribing before hijacking means an unknown search still gets an
      // ordinary JSON 404 rather than a half-written event stream.
      const subscription = context.searchService.subscribe(
        request.params.searchId,
        session.workspaceId,
        afterSeq,
        write,
      );

      // Writing to the raw socket bypasses Fastify's serialiser, so the
      // response head has to be written here — otherwise the browser sees the
      // default content type and refuses the stream.
      reply.hijack();
      stream.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Disables response buffering in reverse proxies that honour it.
        'x-accel-buffering': 'no',
        'x-content-type-options': 'nosniff',
      });
      stream.flushHeaders();
      streaming = true;
      for (const event of pending.splice(0)) send(event);

      if (subscription.alreadyFinished) {
        stream.write('event: stream_closed\ndata: {"reason":"search_finished"}\n\n');
        stream.end();
        closed = true;
        return;
      }

      // A periodic comment keeps intermediaries from closing an idle stream.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          stream.write(': keep-alive\n\n');
        } catch {
          closed = true;
        }
      }, SSE_HEARTBEAT_MS);

      const cleanup = (): void => {
        closed = true;
        clearInterval(heartbeat);
        subscription.unsubscribe();
      };

      request.raw.on('close', cleanup);
      request.raw.on('error', cleanup);
      stream.on('error', cleanup);
    },
  );

  app.post<{ Params: { searchId: string } }>(
    `${API_BASE_PATH}/searches/:searchId/cancel`,
    async (request, reply) => {
      const session = resolveSession(request, reply, sessionOptions);
      const cancelled = context.searchService.cancel(request.params.searchId, session.workspaceId);
      void reply.status(202);
      return {
        searchId: request.params.searchId,
        cancelled,
        message: cancelled ? 'Search cancelled.' : 'That search had already finished.',
      };
    },
  );

  app.post<{ Params: { assetId: string } }>(
    `${API_BASE_PATH}/assets/:assetId/download-intent`,
    async (request, reply) => {
      const session = resolveSession(request, reply, sessionOptions);
      context.downloadLimiter.assertWithinLimit(session.workspaceId, 'download');

      const parsed = downloadIntentRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new AuralisError('invalid_request', firstIssueMessage(parsed.error.issues));
      }

      return await context.downloadControl.createIntent({
        workspaceId: session.workspaceId,
        searchId: parsed.data.searchId,
        resultId: request.params.assetId,
      });
    },
  );

  app.get<{ Params: { assetId: string }; Querystring: { searchId?: string } }>(
    `${API_BASE_PATH}/assets/:assetId`,
    async (request, reply) => {
      const session = resolveSession(request, reply, sessionOptions);
      const searchId = request.query.searchId;
      if (!searchId) {
        throw new AuralisError('invalid_request', 'A search reference is required.');
      }
      const stored = context.searches.getResult(
        searchId,
        request.params.assetId,
        session.workspaceId,
      );
      if (!stored) throw new AuralisError('not_found', 'That result could not be found.');
      return stored.result;
    },
  );

  app.post<{ Params: { assetId: string } }>(
    `${API_BASE_PATH}/assets/:assetId/verify`,
    async (request, reply) => {
      const session = resolveSession(request, reply, sessionOptions);
      const body = downloadIntentRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw new AuralisError('invalid_request', firstIssueMessage(body.error.issues));
      }
      const stored = context.searches.getResult(
        body.data.searchId,
        request.params.assetId,
        session.workspaceId,
      );
      if (!stored) throw new AuralisError('not_found', 'That result could not be found.');
      return {
        assetId: stored.result.id,
        verification: stored.result.verification,
        technical: stored.result.technical,
        compatibility: stored.result.compatibility,
        quality: stored.result.quality,
      };
    },
  );

  app.delete(`${API_BASE_PATH}/searches`, async (request, reply) => {
    const session = resolveSession(request, reply, sessionOptions);
    const deleted = context.searches.deleteHistory(session.workspaceId);
    return { deleted, message: 'Your search history has been deleted.' };
  });
}

function firstIssueMessage(
  issues: readonly { path: (string | number)[]; message: string }[],
): string {
  const issue = issues[0];
  if (!issue) return 'That request was not valid.';
  const field = issue.path.join('.');
  return field.length > 0 ? `${field}: ${issue.message}` : issue.message;
}
