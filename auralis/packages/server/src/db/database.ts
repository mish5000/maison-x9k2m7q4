import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';

// Loaded through createRequire so bundlers that do not yet recognise
// `node:sqlite` as a built-in cannot try to resolve it from disk.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

import { MIGRATIONS, RETENTION_DAYS, type RetentionPolicy } from './schema.js';

/**
 * SQLite access built on Node's own `node:sqlite`.
 *
 * Using the built-in module means a clean clone needs no native compilation
 * step and no external database process. The trade-off — the module is marked
 * experimental in Node 22 and needs the `--experimental-sqlite` flag — is
 * recorded in docs/adr/0002-sqlite-via-node-sqlite.md.
 */

export type SqlValue = string | number | null | Uint8Array;

export interface Db {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);

  // WAL keeps readers from blocking the writer, which matters because search
  // event writes happen while the SSE stream is being read.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  const wrapper: Db = {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => db.prepare(sql),
    transaction<T>(fn: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try {
        const value = fn();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // A failed rollback must not mask the original error.
        }
        throw error;
      }
    },
    close: () => db.close(),
  };

  migrate(wrapper);
  return wrapper;
}

export function migrate(db: Db): readonly number[] {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT`);

  const applied = new Set(
    db
      .prepare('SELECT id FROM schema_migration')
      .all()
      .map((row) => Number((row as { id: number }).id)),
  );

  const ran: number[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migration (id, name, applied_at) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        new Date().toISOString(),
      );
    });
    ran.push(migration.id);
  }
  return ran;
}

function cutoff(days: number, now: number): string {
  return new Date(now - days * 86_400_000).toISOString();
}

export interface PruneReport {
  readonly table: string;
  readonly deleted: number;
}

/** Applies the documented retention policy. Safe to run repeatedly. */
export function pruneExpiredData(
  db: Db,
  now: number = Date.now(),
  overrides: Partial<RetentionPolicy> = {},
): readonly PruneReport[] {
  const policy = { ...RETENTION_DAYS, ...overrides };
  const plan: readonly { table: string; column: string; days: number }[] = [
    { table: 'search_event', column: 'created_at', days: policy.searchEvent },
    { table: 'provider_search', column: 'created_at', days: policy.providerSearch },
    { table: 'search_result', column: 'created_at', days: policy.searchResult },
    { table: 'search_session', column: 'started_at', days: policy.searchSession },
    { table: 'download_audit', column: 'created_at', days: policy.downloadAudit },
    { table: 'connector_audit', column: 'created_at', days: policy.connectorAudit },
    { table: 'abuse_signal', column: 'created_at', days: policy.abuseSignal },
    {
      table: 'provider_health_snapshot',
      column: 'created_at',
      days: policy.providerHealthSnapshot,
    },
  ];

  const reports: PruneReport[] = [];
  db.transaction(() => {
    for (const entry of plan) {
      // Table and column names come from this module only, never from input.
      const statement = db.prepare(`DELETE FROM ${entry.table} WHERE ${entry.column} < ?`);
      const result = statement.run(cutoff(entry.days, now));
      reports.push({ table: entry.table, deleted: Number(result.changes) });
    }
  });
  return reports;
}

/** Deletes everything belonging to a workspace. Backs the "delete my data" path. */
export function deleteWorkspaceData(db: Db, workspaceId: string): void {
  db.transaction(() => {
    for (const table of ['download_audit', 'abuse_signal', 'connector_audit']) {
      db.prepare(`DELETE FROM ${table} WHERE workspace_id = ?`).run(workspaceId);
    }
    // The remaining tables cascade from workspace.
    db.prepare('DELETE FROM workspace WHERE id = ?').run(workspaceId);
  });
}
