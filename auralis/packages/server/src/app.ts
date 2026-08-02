import { createReadStream } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import {
  API_BASE_PATH,
  AuralisError,
  CircuitBreakerRegistry,
  MemoryCacheStore,
  Logger,
  Metrics,
  configList,
  contentDispositionAttachment,
  createDefaultRegistry,
  createSafeFetch,
  HEAD_SAMPLE_BYTES,
  isAuralisError,
  newCorrelationId,
  openLocalAsset,
  probeMedia,
  PRODUCTION_URL_POLICY,
  readLocalSample,
  sanitiseFilename,
  TAIL_SAMPLE_BYTES,
  type CacheStore,
  type ProviderRegistry,
  type UrlSafetyPolicy,
} from '@auralis/core';

import type { AppConfig } from './config/env.js';
import { ConnectorRepository } from './db/connectors.js';
import { openDatabase, type Db } from './db/database.js';
import {
  AuditRepository,
  SavedItemRepository,
  SearchRepository,
  WorkspaceRepository,
} from './db/repositories.js';
import { RateLimiter } from './http/rate-limit.js';
import { assertCsrf, resolveSession, type SessionContext } from './http/session.js';
import { registerConnectorRoutes } from './routes/connectors.js';
import { registerProviderRoutes } from './routes/providers.js';
import { registerSavedRoutes } from './routes/saved.js';
import { registerSearchRoutes } from './routes/searches.js';
import { DownloadControlService } from './services/download-control.js';
import { SearchService } from './services/search-service.js';

/**
 * Application assembly.
 *
 * Everything is wired here so that a test can construct the whole application
 * against an in-memory database and a local fixture origin, with no globals and
 * no hidden singletons.
 */

export interface AppContext {
  readonly config: AppConfig;
  readonly db: Db;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly cache: CacheStore;
  readonly registry: ProviderRegistry;
  readonly searchService: SearchService;
  readonly downloadControl: DownloadControlService;
  readonly connectors: ConnectorRepository;
  readonly searches: SearchRepository;
  readonly saved: SavedItemRepository;
  readonly audit: AuditRepository;
  readonly workspaces: WorkspaceRepository;
  readonly breakers: CircuitBreakerRegistry;
  readonly urlPolicy: UrlSafetyPolicy;
  readonly session: (request: never, reply: never) => SessionContext;
}

export interface BuildAppOptions {
  readonly config: AppConfig;
  /** Overrides the database path; used by tests to run in memory. */
  readonly databasePath?: string;
  /** Additional static provider configuration, e.g. the fixture origin. */
  readonly staticProviderConfig?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly logSink?: (record: { level: string; message: string }) => void;
}

export function buildUrlPolicy(config: AppConfig): UrlSafetyPolicy {
  return {
    ...PRODUCTION_URL_POLICY,
    allowInsecureHttp: config.allowInsecureHttp,
    allowPrivateAddresses: config.allowPrivateEgress,
    // The bundled fixture origin binds to a non-standard port; permitting it
    // explicitly is narrower than widening the default port policy.
    additionalPorts: config.allowPrivateEgress ? [config.fixtureOriginPort] : [],
  };
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;

  const logger = new Logger({
    level: config.logLevel,
    logQueryText: config.logQueryText,
    ...(options.logSink
      ? { sink: (record) => options.logSink?.({ level: record.level, message: record.message }) }
      : {}),
  });
  const metrics = new Metrics();
  const cache = new MemoryCacheStore();
  const db = openDatabase(options.databasePath ?? config.databasePath);

  const urlPolicy = buildUrlPolicy(config);
  const safeFetch = createSafeFetch({ policy: urlPolicy });
  const registry = createDefaultRegistry({ urlPolicy });
  const breakers = new CircuitBreakerRegistry();

  const workspaces = new WorkspaceRepository(db);
  const searches = new SearchRepository(db);
  const savedItems = new SavedItemRepository(db);
  const audit = new AuditRepository(db);
  const connectors = new ConnectorRepository(db, config.secretKey);

  const staticProviderConfig = options.staticProviderConfig ?? {};

  const searchService = new SearchService({
    registry,
    repository: searches,
    connectors,
    fetch: safeFetch,
    logger,
    metrics,
    breakers,
    disabledProviderIds: new Set<string>(),
    staticProviderConfig,
    previewUrlFor: (result) =>
      result.mediaUrl ?? `${API_BASE_PATH}/searches/${result.searchId}/results/${result.id}/stream`,
    // Local assets are verified by reading bounded samples from disk, using the
    // same parsers as the network path so the evidence is directly comparable.
    verifyWithoutUrl: async (candidate) => {
      const localPath = candidate.providerExtras['localPath'];
      if (typeof localPath !== 'string' || localPath.length === 0) return null;
      const roots = configList(staticProviderConfig['local-files']?.['roots']);
      if (roots.length === 0) return null;

      const head = await readLocalSample(localPath, roots, HEAD_SAMPLE_BYTES);
      if (!head) return null;
      const tail = await readLocalSample(localPath, roots, TAIL_SAMPLE_BYTES, true);
      const sizeBytes =
        typeof candidate.claimed.sizeBytes === 'number' ? candidate.claimed.sizeBytes : null;

      const probe = probeMedia({
        head,
        tail,
        totalSizeBytes: sizeBytes,
        filenameOrPath: localPath,
      });

      return {
        verification: {
          status: probe.status,
          evidence: ['source:local-file', ...probe.evidence],
          bytesInspected: head.length + (tail?.length ?? 0),
          checkedAt: new Date().toISOString(),
          finalHost: null,
          finalUrl: null,
          redirectCount: 0,
          declaredMimeType: null,
          detectedSignature: probe.signature?.signature ?? probe.nonAudio?.signature ?? null,
          signatureAgreement: probe.signatureAgreement,
        },
        technical: { ...probe.technical, sizeBytes: probe.technical.sizeBytes ?? sizeBytes },
        tags: probe.tags,
        headSample: head,
        playlist: null,
      };
    },
  });

  const downloadControl = new DownloadControlService({
    registry,
    searches,
    connectors,
    audit,
    policy: urlPolicy,
    mediatedUrlFor: (searchId, resultId) =>
      `${API_BASE_PATH}/searches/${searchId}/results/${resultId}/stream`,
  });

  const searchLimiter = new RateLimiter(config.searchesPerMinute);
  const downloadLimiter = new RateLimiter(config.downloadsPerMinute);

  const app = Fastify({
    logger: false,
    bodyLimit: 64 * 1024,
    trustProxy: false,
  });

  await app.register(helmet, {
    contentSecurityPolicy: config.serveWeb
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            // Artwork and audio come from third-party sources by design.
            imgSrc: ["'self'", 'https:', 'data:'],
            mediaSrc: ["'self'", 'https:', ...(config.allowInsecureHttp ? ['http:'] : [])],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  });

  await app.register(cors, {
    origin: [...config.corsOrigins],
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-auralis-csrf', 'last-event-id'],
    maxAge: 600,
  });

  await app.register(cookie, {});

  app.decorateRequest('session', undefined);

  const sessionOptions = {
    workspaces,
    secret: config.sessionSecret,
    secureCookies: config.isProduction,
  };

  app.addHook('onRequest', async (_request, reply) => {
    reply.header('x-correlation-id', newCorrelationId());
  });

  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    assertCsrf(request);
    resolveSession(request, reply, sessionOptions);
  });

  app.setErrorHandler((error, request, reply) => {
    const correlationId = String(reply.getHeader('x-correlation-id') ?? newCorrelationId());

    if (isAuralisError(error)) {
      metrics.increment('auralis_errors_total', { code: error.code });
      void reply.status(error.httpStatus).send(error.toPublicJSON(correlationId));
      return;
    }

    const failure = error as { validation?: unknown; statusCode?: number; name?: string };
    if (failure.validation) {
      void reply
        .status(400)
        .send(
          new AuralisError('invalid_request', 'That request was not valid.').toPublicJSON(
            correlationId,
          ),
        );
      return;
    }

    if (failure.statusCode === 413) {
      void reply
        .status(413)
        .send(
          new AuralisError('payload_too_large', 'That request was too large.').toPublicJSON(
            correlationId,
          ),
        );
      return;
    }

    // Internal detail is logged, never returned.
    logger.error('Unhandled request error', {
      correlationId,
      route: request.routeOptions?.url ?? request.url,
      name: failure.name ?? 'Error',
    });
    void reply
      .status(500)
      .send(
        new AuralisError('internal_error', 'Something went wrong. Try again.').toPublicJSON(
          correlationId,
        ),
      );
  });

  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }));

  app.get('/metrics.json', async (_request, reply) => {
    if (config.isProduction) {
      void reply.status(404);
      return { error: 'not found' };
    }
    return metrics.snapshot();
  });

  const context = {
    config,
    logger,
    metrics,
    registry,
    searchService,
    downloadControl,
    connectors,
    searches,
    saved: savedItems,
    audit,
    workspaces,
    breakers,
    urlPolicy,
    cache,
    safeFetch,
    searchLimiter,
    downloadLimiter,
    staticProviderConfig,
  };

  await registerSearchRoutes(app, context);
  await registerProviderRoutes(app, context);
  await registerConnectorRoutes(app, context);
  await registerSavedRoutes(app, context);

  // Streaming route for assets with no public URL (local files, some connectors).
  app.get<{ Params: { searchId: string; resultId: string } }>(
    `${API_BASE_PATH}/searches/:searchId/results/:resultId/stream`,
    async (request, reply) => {
      const session = resolveSession(request, reply, sessionOptions);
      downloadLimiter.assertWithinLimit(session.workspaceId, 'download');

      const stored = searches.getResult(
        request.params.searchId,
        request.params.resultId,
        session.workspaceId,
      );
      if (!stored) throw new AuralisError('not_found', 'That file could not be found.');

      const intent = await downloadControl.createIntent({
        workspaceId: session.workspaceId,
        searchId: request.params.searchId,
        resultId: request.params.resultId,
      });
      if (!intent.allowed) {
        throw new AuralisError('download_not_permitted', intent.reason);
      }

      if (!stored.localPath) {
        throw new AuralisError('not_found', 'That file is not available through this address.');
      }

      const roots = configList(staticProviderConfig['local-files']?.['roots']).concat(
        configList(
          connectors.resolveConfig(session.workspaceId, stored.connectorId ?? '')?.['roots'],
        ),
      );
      const asset = await openLocalAsset(stored.localPath, roots);
      if (!asset) throw new AuralisError('not_found', 'That file could not be opened.');

      const name = sanitiseFilename(
        stored.result.filename ?? stored.result.title,
        stored.result.technical.extension ?? stored.result.technical.format,
      );

      void reply
        .header('content-type', stored.result.technical.mimeType ?? 'application/octet-stream')
        .header('content-length', String(asset.sizeBytes))
        .header('content-disposition', contentDispositionAttachment(name))
        .header('accept-ranges', 'none')
        .header('x-content-type-options', 'nosniff');
      return reply.send(asset.stream);
    },
  );

  const apiNotFound = (url: string, reply: FastifyReply): void => {
    const correlationId = String(reply.getHeader('x-correlation-id') ?? newCorrelationId());
    void reply
      .status(404)
      .send(
        new AuralisError('not_found', 'That address does not exist.').toPublicJSON(correlationId),
      );
    void url;
  };

  if (config.serveWeb) {
    const distPath = resolvePath(process.cwd(), config.webDist);
    const staticModule = await import('@fastify/static');
    await app.register(staticModule.default, { root: distPath, wildcard: false });

    // Fastify allows exactly one not-found handler, so the API 404 and the
    // single-page-application fallback share it.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        apiNotFound(request.url, reply);
        return;
      }
      void reply.type('text/html').send(createReadStream(resolvePath(distPath, 'index.html')));
    });
  } else {
    app.setNotFoundHandler((request, reply) => {
      apiNotFound(request.url, reply);
    });
  }

  app.addHook('onClose', async () => {
    await searchService.shutdown();
    db.close();
  });

  return app;
}

export type RouteContext = {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly metrics: Metrics;
  readonly registry: ProviderRegistry;
  readonly searchService: SearchService;
  readonly downloadControl: DownloadControlService;
  readonly connectors: ConnectorRepository;
  readonly searches: SearchRepository;
  readonly saved: SavedItemRepository;
  readonly audit: AuditRepository;
  readonly workspaces: WorkspaceRepository;
  readonly breakers: CircuitBreakerRegistry;
  readonly urlPolicy: UrlSafetyPolicy;
  readonly cache: CacheStore;
  readonly safeFetch: ReturnType<typeof createSafeFetch>;
  readonly searchLimiter: RateLimiter;
  readonly downloadLimiter: RateLimiter;
  readonly staticProviderConfig: Readonly<Record<string, Readonly<Record<string, string>>>>;
};
