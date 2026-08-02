import {
  API_BASE_PATH,
  type ProviderHealth,
  type ProviderHealthResponse,
  type ProviderSummary,
} from '@auralis/core';
import type { FastifyInstance } from 'fastify';

import type { RouteContext } from '../app.js';
import { resolveSession } from '../http/session.js';

/**
 * Provider discovery and health.
 *
 * Health checks run against the workspace's own configuration, so a connector
 * that is configured for one workspace never appears as "ready" for another.
 */

const HEALTH_TIMEOUT_MS = 6_000;

export async function registerProviderRoutes(
  app: FastifyInstance,
  context: RouteContext,
): Promise<void> {
  const sessionOptions = {
    workspaces: context.workspaces,
    secret: context.config.sessionSecret,
    secureCookies: context.config.isProduction,
  };

  app.get(`${API_BASE_PATH}/providers`, async (request, reply) => {
    const session = resolveSession(request, reply, sessionOptions);
    const connectorState = context.connectors.resolveAllByProvider(session.workspaceId);

    const providers: ProviderSummary[] = context.registry.all().map((registration) => {
      const provider = registration.provider;
      const config = {
        ...(context.staticProviderConfig[provider.id] ?? {}),
        ...(connectorState.configByProvider[provider.id] ?? {}),
      };
      return {
        id: provider.id,
        displayName: provider.displayName,
        sourceCategory: provider.capabilities.sourceCategory,
        requiresAuthentication: provider.capabilities.requiresAuthentication,
        requiredConfiguration: provider.capabilities.requiredConfiguration,
        modes: provider.capabilities.modes,
        supportsPreview: provider.capabilities.supportsPreview,
        returnsDirectMediaUrls: provider.capabilities.returnsDirectMediaUrls,
        status: context.registry.configurationStatus(provider.id, config),
        setupDocPath: registration.setupDocPath,
      };
    });

    return { providers };
  });

  app.get(`${API_BASE_PATH}/providers/health`, async (request, reply) => {
    const session = resolveSession(request, reply, sessionOptions);
    const connectorState = context.connectors.resolveAllByProvider(session.workspaceId);
    const circuitStates = context.breakers.states();

    const checks = context.registry.all().map(async (registration) => {
      const provider = registration.provider;
      const config = {
        ...(context.staticProviderConfig[provider.id] ?? {}),
        ...(connectorState.configByProvider[provider.id] ?? {}),
      };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      let health: ProviderHealth;
      try {
        health = await provider.healthCheck({
          config,
          fetch: context.safeFetch,
          signal: controller.signal,
          now: Date.now,
        });
      } catch {
        health = {
          providerId: provider.id,
          status: 'unavailable',
          message: 'The health check did not complete.',
          checkedAt: new Date().toISOString(),
          latencyMs: null,
          setupDocPath: registration.setupDocPath,
        };
      } finally {
        clearTimeout(timer);
      }

      try {
        context.audit.recordProviderHealth(
          provider.id,
          provider.capabilities.producesPrivateResults ? session.workspaceId : null,
          health.status,
          health.message,
          health.latencyMs,
        );
      } catch {
        // Recording a snapshot must never fail the diagnostics view.
      }

      return {
        providerId: health.providerId,
        status: health.status,
        message: health.message,
        latencyMs: health.latencyMs,
        circuitState: circuitStates[provider.id] ?? ('closed' as const),
        setupDocPath: health.setupDocPath ?? registration.setupDocPath,
      };
    });

    const providers = await Promise.all(checks);
    const response: ProviderHealthResponse = {
      checkedAt: new Date().toISOString(),
      providers,
    };
    return response;
  });
}
