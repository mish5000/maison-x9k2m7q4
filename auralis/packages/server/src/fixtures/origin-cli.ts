import { loadConfig } from '../config/env.js';
import { writeFixtures } from './generate.js';
import { startFixtureOrigin } from './origin.js';

/**
 * Runs the fixture origin as a standalone process, so a developer can browse
 * the same directory Auralis searches during a local demonstration.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const written = writeFixtures(config.fixtureDir);
  const origin = await startFixtureOrigin({ port: config.fixtureOriginPort });

  process.stdout.write(
    `Auralis fixture origin listening on ${origin.baseUrl}\n` +
      `${written.length} fixtures written to ${config.fixtureDir}\n` +
      written.map((fixture) => `  ${fixture.name} — ${fixture.description}`).join('\n') +
      '\n',
  );

  const shutdown = (): void => {
    void origin.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`Fixture origin failed to start: ${String(error)}\n`);
  process.exit(1);
});
