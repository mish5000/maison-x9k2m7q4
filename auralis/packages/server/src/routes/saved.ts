import {
  API_BASE_PATH,
  AuralisError,
  saveItemRequestSchema,
  type SavedItemSummary,
} from '@auralis/core';
import type { FastifyInstance } from 'fastify';

import type { RouteContext } from '../app.js';
import { resolveSession } from '../http/session.js';

/** The saved collection. Scoped to a workspace, like everything else. */
export async function registerSavedRoutes(
  app: FastifyInstance,
  context: RouteContext,
): Promise<void> {
  const sessionOptions = {
    workspaces: context.workspaces,
    secret: context.config.sessionSecret,
    secureCookies: context.config.isProduction,
  };

  app.get(`${API_BASE_PATH}/saved`, async (request, reply) => {
    const session = resolveSession(request, reply, sessionOptions);
    const items: readonly SavedItemSummary[] = context.saved
      .list(session.workspaceId)
      .map((row) => ({
        id: row.id,
        title: row.title,
        creator: row.creator,
        sourceName: row.sourceName,
        pageUrl: row.pageUrl,
        format: row.format,
        durationSeconds: row.durationSeconds,
        savedAt: row.savedAt,
        note: row.note,
      }));
    return { items };
  });

  app.post(`${API_BASE_PATH}/saved`, async (request, reply) => {
    const session = resolveSession(request, reply, sessionOptions);
    const parsed = saveItemRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AuralisError(
        'invalid_request',
        parsed.error.issues[0]?.message ?? 'That request was not valid.',
      );
    }

    const stored = context.searches.getResult(
      parsed.data.searchId,
      parsed.data.resultId,
      session.workspaceId,
    );
    if (!stored) throw new AuralisError('not_found', 'That result could not be found.');

    const row = context.saved.save(
      session.workspaceId,
      parsed.data.searchId,
      stored.result,
      parsed.data.note ?? null,
    );

    void reply.status(201);
    return row satisfies SavedItemSummary;
  });

  app.delete<{ Params: { savedId: string } }>(
    `${API_BASE_PATH}/saved/:savedId`,
    async (request, reply) => {
      const session = resolveSession(request, reply, sessionOptions);
      const removed = context.saved.remove(session.workspaceId, request.params.savedId);
      if (!removed) throw new AuralisError('not_found', 'That saved item could not be found.');
      void reply.status(204);
      return null;
    },
  );
}
