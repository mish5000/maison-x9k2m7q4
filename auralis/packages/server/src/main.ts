import { buildApp } from './app.js';
import { loadConfig, ConfigError } from './config/env.js';
import { writeFixtures } from './fixtures/generate.js';
import { startFixtureOrigin, type FixtureOrigin } from './fixtures/origin.js';

/**
 * Process entry point.
 *
 * In development the bundled fixture origin starts alongside the API and is
 * registered as a configured HTTP directory, so a clean clone has something
 * real to search before any external source is reachable. In production the
 * fixture origin never starts and private-network egress is refused outright.
 */

async function main(): Promise<void> {
  const config = loadConfig();

  let fixtureOrigin: FixtureOrigin | null = null;
  const staticProviderConfig: Record<string, Record<string, string>> = {};

  if (!config.isProduction && config.allowPrivateEgress) {
    writeFixtures(config.fixtureDir);
    fixtureOrigin = await startFixtureOrigin({ port: config.fixtureOriginPort });
    staticProviderConfig['http-directory'] = { roots: fixtureOrigin.baseUrl, maxDepth: '1' };
    staticProviderConfig['local-files'] = { roots: config.fixtureDir };
  }

  const app = await buildApp({ config, staticProviderConfig });

  await app.listen({ host: config.host, port: config.port });

  process.stdout.write(
    JSON.stringify({
      message: 'Auralis API listening',
      url: `http://${config.host}:${config.port}`,
      environment: config.nodeEnv,
      fixtureOrigin: fixtureOrigin?.baseUrl ?? null,
      privateEgressAllowed: config.allowPrivateEgress,
    }) + '\n',
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stdout.write(JSON.stringify({ message: 'Shutting down', signal }) + '\n');
    try {
      await app.close();
      await fixtureOrigin?.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  process.stderr.write(
    `Auralis failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
