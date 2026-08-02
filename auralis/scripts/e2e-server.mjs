#!/usr/bin/env node
import { rmSync } from 'node:fs';

/**
 * The end-to-end server entry point.
 *
 * Starts from a clean database so each run is deterministic, then hands over to
 * the ordinary production entry point — the browser talks to exactly the same
 * application a user would.
 */

rmSync('./data/e2e.db', { force: true });
rmSync('./data/e2e.db-wal', { force: true });
rmSync('./data/e2e.db-shm', { force: true });

await import('../packages/server/dist/main.js');
