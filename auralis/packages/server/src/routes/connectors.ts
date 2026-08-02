import {
  API_BASE_PATH,
  AuralisError,
  createConnectorRequestSchema,
  type ConnectorSummary,
} from '@auralis/core';
import type { FastifyInstance } from 'fastify';

import type { RouteContext } from '../app.js';
import { CONNECTOR_PROVIDER_BY_KIND, toConnectorSummary } from '../db/connectors.js';
import { resolveSession } from '../http/session.js';

/**
 * Connector management.
 *
 * Secret values are accepted on create, encrypted immediately, and never
 * returned. Connection testing runs the provider's own health check with the
 * decrypted configuration, which is the only other place secrets are read.
 */

const MAX_CONNECTORS_PER_WORKSPACE = 25;

export async function registerConnectorRoutes(
  app: FastifyInstance,
  context: RouteContext,
): Promise<void> {
  const sessionOptions = {
    workspaces: context.workspaces,
    secret: context.config.sessionSecret,
    secureCookies: context.config.isProduction,
  };

  app.get(`${API_BASE_PATH}/connectors`, async (request, reply) => {
    const session = resolveSession(request, reply, sessionOptions);
    const connectors: readonly ConnectorSummary[] = context.connectors
      .list(session.workspaceId)
      .map(toConnectorSummary);
    return { connectors };
  });

  app.post(`${API_BASE_PATH}/connectors`, async (request, reply) => {
    const session = resolveSession(request, reply, sessionOptions);

    const parsed = createConnectorRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new AuralisError(
        'invalid_request',
        parsed.error.issues[0]?.message ?? 'That connector could not be created.',
      );
    }

    const existing = context.connectors.list(session.workspaceId);
    if (existing.length >= MAX_CONNECTORS_PER_WORKSPACE) {
      throw new AuralisError(
        'forbidden',
        `You can connect up to ${MAX_CONNECTORS_PER_WORKSPACE} sources.`,
      );
    }

    const providerId = CONNECTOR_PROVIDER_BY_KIND[parsed.data.kind];
    const registration = context.registry.registration(providerId);
    if (!registration) {
      throw new AuralisError('invalid_request', 'That kind of source is not supported.');
    }

    const required = registration.provider.capabilities.requiredConfiguration;
    const missing = required.filter((key) => {
      const value = parsed.data.config[key];
      return typeof value !== 'string' || value.trim().length === 0;
    });
    if (missing.length > 0) {
      throw new AuralisError(
        'connector_not_configured',
        `This source still needs: ${missing.join(', ')}.`,
        { details: { missing } },
      );
    }

    const row = context.connectors.create({
      workspaceId: session.workspaceId,
      kind: parsed.data.kind,
      displayName: parsed.data.displayName,
      config: parsed.data.config,
      secretKeys: registration.secretConfigKeys,
    });

    context.audit.recordConnectorAction(row.id, session.workspaceId, 'create', 'ok', row.kind);

    void reply.status(201);
    return toConnectorSummary(row);
  });

  app.post<{ Params: { connectorId: string } }>(
    `${API_BASE_PATH}/connectors/:connectorId/test`,
    async (request, reply) => {
      const session = resolveSession(request, reply, sessionOptions);
      const connector = context.connectors.get(session.workspaceId, request.params.connectorId);
      if (!connector) throw new AuralisError('not_found', 'That source could not be found.');

      const provider = context.registry.get(connector.providerId);
      if (!provider)
        throw new AuralisError('not_found', 'That kind of source is no longer supported.');

      const config = context.connectors.resolveConfig(session.workspaceId, connector.id);
      if (!config) {
        context.connectors.updateStatus(
          session.workspaceId,
          connector.id,
          'error',
          'The stored settings could not be read. Reconnect this source.',
        );
        throw new AuralisError(
          'connector_auth_expired',
          'The stored settings could not be read. Reconnect this source.',
        );
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        const health = await provider.healthCheck({
          config,
          fetch: context.safeFetch,
          signal: controller.signal,
          now: Date.now,
        });

        const status: ConnectorSummary['status'] =
          health.status === 'ready'
            ? 'ready'
            : health.status === 'auth_required'
              ? 'auth_required'
              : health.status === 'not_configured'
                ? 'not_configured'
                : 'error';

        context.connectors.updateStatus(session.workspaceId, connector.id, status, health.message);
        context.audit.recordConnectorAction(
          connector.id,
          session.workspaceId,
          'test',
          status,
          null,
        );

        return {
          connectorId: connector.id,
          status,
          message: health.message,
          latencyMs: health.latencyMs,
          checkedAt: health.checkedAt,
        };
      } catch {
        context.connectors.updateStatus(
          session.workspaceId,
          connector.id,
          'error',
          'The connection test did not complete.',
        );
        context.audit.recordConnectorAction(
          connector.id,
          session.workspaceId,
          'test',
          'error',
          null,
        );
        return {
          connectorId: connector.id,
          status: 'error' as const,
          message: 'The connection test did not complete.',
          latencyMs: null,
          checkedAt: new Date().toISOString(),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  );

  app.delete<{ Params: { connectorId: string } }>(
    `${API_BASE_PATH}/connectors/:connectorId`,
    async (request, reply) => {
      const session = resolveSession(request, reply, sessionOptions);
      const connector = context.connectors.get(session.workspaceId, request.params.connectorId);
      if (!connector) throw new AuralisError('not_found', 'That source could not be found.');

      const removed = context.connectors.remove(session.workspaceId, connector.id);
      if (!removed) throw new AuralisError('not_found', 'That source could not be found.');

      // Anything this connector put in the cache goes with it.
      await context.cache.deleteByPrefix(
        `ws:${session.workspaceId}:provider:${connector.providerId}:`,
      );
      context.audit.recordConnectorAction(
        connector.id,
        session.workspaceId,
        'disconnect',
        'ok',
        null,
      );

      void reply.status(204);
      return null;
    },
  );
}
